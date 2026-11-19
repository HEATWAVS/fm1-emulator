#!/usr/bin/env node
// Self-test of the headless machine harness against the bundled engine and firmware.
//   node ci/machine/selftest.mjs           full tier: every test (about 90 s)      npm run test:machine
//   node ci/machine/selftest.mjs --quick   quick tier: the tests tagged test.quick (about 6 s)
//                                          npm run test:machine:quick; also run by `npm test` (ci/verify.mjs)
//
// Tiers: a test is quick if it is declared with test.quick(...). The full tier runs ALL tests, so the
// quick tier is a subset by construction. Quick tests do no firmware run longer than the one Felucca
// boot smoke test, so `npm test` stays fast; the slower firmware-behaviour tests are full-tier only.
// A test function receives { full }: false under --quick. One test ("default is untouched") uses it to run
// only its fast memory check in the quick tier and the whole test, with its slower run, in the full tier.
// Success prints "PASS: N machine tests (quick|full)", the line ci/verify.mjs checks for.
//
// The flash-chip reference model's conformance tests (chiptests.mjs, pure JavaScript, milliseconds, no engine)
// are registered here too, all in the quick tier. They test the datasheet model, not the running emulator.
//
// Tests marked KNOWN LIMITATION record what this engine does NOT model. They pass while the
// limitation is real; if an engine ever starts modelling the thing, they fail and tell you the
// harness can now test it.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadEngine, EMULATOR_DIR, FLASH_ID_LAYOUTS } from "./engine.mjs";
import { Fm1Machine, BootError, corruptedSectors, requires } from "./machine.mjs";
import { FlashIdError, FLASH_IDS, parseFlashId, locateLiveFlashId, applyFlashId } from "./flashid.mjs";
import { watch } from "./monitor.mjs";
import { FLASH_SIZE, SECTOR, packRecords, unpackRecords, parseCorruption, corruptSectors, diffSectors } from "./flash.mjs";
import { registerChipTests } from "./chiptests.mjs";
import { registerFaultRegressionTests } from "./faulttests.mjs";
import { registerLiveChipTests } from "./chiplivetests.mjs";
import { registerFirmwareTests } from "./firmwaretests.mjs";
import { registerFaultLiveTests } from "./faultlivetests.mjs";
import { registerFaultHarnessQuickTests, registerFaultHarnessLiveTests } from "./faultharnesstests.mjs";
import { registerFaultSurveyQuickTests, registerFaultSurveyLiveTests } from "./faultsurveytests.mjs";
import { registerRecoveryQuickTests, registerRecoveryFullTests, registerRecoveryLiveTests } from "./recoverytests.mjs";
import { registerBootAreaQuickTests, registerBootAreaFullTests, registerBootAreaLiveTests } from "./bootareatests.mjs";
import { registerBootArea7CQuickTests, registerBootArea7CFullTests, registerBootArea7CLiveTests } from "./bootarea7ctests.mjs";
import { registerUnifiedQuickTests, registerUnifiedFullTests, registerUnifiedAppTests, registerUnifiedLiveTests } from "./unifiedtests.mjs";
import { registerOptimizedQuickTests } from "./optimizedtests.mjs";
import { FlashChipError, FLASH_CHIPS, parseFlashChip, parseFlashTiming, resolveFlashChipOptions, parseFlashUid, uidWords } from "./flashchip.mjs";
import { PIN, defaultEnginePath, verifyEngineFile } from "../engine/verify.mjs";
import { renderTables } from "../engine/tables.mjs";

const engine = await loadEngine();
// The chip-profile engine is built on demand by ci/engine/build.mjs and is never committed. Tests that need it are
// full-tier only and are reported as SKIPPED (never as passed) when it has not been built.
const chipEnginePath = defaultEnginePath();
const chipEngine = existsSync(chipEnginePath) ? await loadEngine({ wasmPath: chipEnginePath, name: "fm1_web_chips.wasm" }) : null;
const fw = (name) => new Uint8Array(readFileSync(resolve(EMULATOR_DIR, "../fw", name)));
const FELUCCA = fw("felucca-1.8.2-beta.fwsc");
const AURORA = new Uint8Array(readFileSync(resolve(EMULATOR_DIR, "../archive/AURORA/aurora-0.9.1.fwsc")));
const MELODEE = fw("melodee-1.6.1.fwsc");
const hex = (n) => `0x${n.toString(16)}`;

const args = process.argv.slice(2);
const FILTER = args.includes("--filter") ? args[args.indexOf("--filter") + 1] : null;      // run only tests whose name contains this text (used for mutation controls)
if (args.some((a, i) => a !== "--quick" && a !== "--filter" && args[i - 1] !== "--filter") || (args.includes("--filter") && !FILTER)) { console.error("usage: node ci/machine/selftest.mjs [--quick] [--filter TEXT]"); process.exit(2); }
const QUICK_ONLY = args.includes("--quick");

const tests = [];
const test = (name, fn) => tests.push({ name, fn, quick: false });
test.quick = (name, fn) => tests.push({ name, fn, quick: true });
test.chip = (name, fn) => tests.push({ name, fn, quick: false, needsChipEngine: true });

test.quick("engine capabilities are detected from its exports", () => {
  const c = engine.capabilities;
  for (const k of ["boot", "flashRead", "flashBase", "flashRestore", "flashRevision", "input", "lcd"]) assert.ok(c[k], `${k}`);
  // Not exposed by this engine: a test needing them must be skipped loudly, never passed.
  assert.equal(c.selectFlashId, false);
  assert.equal(c.flashFaultInjection, false);
  assert.equal(c.resetCounter, false);
  for (const k of ["selectFlashChip", "flashWip", "flashEvents", "flashUid"]) assert.equal(c[k], false, `${k}: the shipped engine has no chip profiles`);
  assert.throws(() => requires(engine, "selectFlashId"), /lacks: selectFlashId/);
});

for (const [name, pkg] of [["Felucca", FELUCCA], ["AURORA", AURORA], ["Melodee", MELODEE]]) {
  (name === "Felucca" ? test.quick : test)(`${name} boots headless and shows a screen`, () => {   // Felucca: the quick tier's real-boot smoke test
    const r = watch(Fm1Machine.boot(engine, pkg), { seconds: 3 });
    assert.equal(r.verdict, "booted", JSON.stringify({ ...r, samples: undefined }));
    assert.ok(r.final.lcdColours >= 2);
  });
}

test("a run is repeatable: same screen, same flash, same clock", () => {
  const run = () => { const m = Fm1Machine.boot(engine, FELUCCA); const r = watch(m, { seconds: 2 }); return [r.final.lcdHash, m.flashHash(), r.emulatedMs]; };
  assert.deepEqual(run(), run());
});

test.quick("flash reads back: 1 MiB, populated, equal to the package base before the firmware runs", () => {
  const m = Fm1Machine.boot(engine, FELUCCA);
  const flash = m.flash();
  assert.equal(flash.length, FLASH_SIZE);
  assert.ok(flash.some((b) => b !== 0xff), "flash holds the firmware");
  assert.deepEqual(m.changedSectors(), []);
});

test.quick("an injected sector reaches the machine and is reported as changed", () => {
  const sectors = corruptedSectors(engine, FELUCCA, ["zero:0x20000"]);
  assert.deepEqual(sectors.map((s) => s.at), [0x20000]);
  const m = Fm1Machine.boot(engine, FELUCCA, { sectors });
  assert.ok(m.flash().subarray(0x20000, 0x21000).every((b) => b === 0));
  assert.deepEqual(m.changedSectors().map((s) => s.at), [0x20000]);
});

test("corrupting the start of the app area blanks the screen (no crash)", () => {
  const sectors = corruptedSectors(engine, FELUCCA, ["zero:0x4000"]);
  assert.equal(watch(Fm1Machine.boot(engine, FELUCCA, { sectors }), { seconds: 2 }).verdict, "blank");
});

test.quick("erasing a code sector halts the CPU", () => {
  const sectors = corruptedSectors(engine, FELUCCA, ["erase:0x20000"]);
  const r = watch(Fm1Machine.boot(engine, FELUCCA, { sectors }), { seconds: 3 });
  assert.equal(r.verdict, "crashed");
  assert.ok(r.haltedAtMs > 0);
});

test.quick("seeded bit flips are deterministic and change flash", () => {
  const flash = Fm1Machine.boot(engine, FELUCCA).flash();
  const a = corruptSectors(flash, ["flip:0x20000:4096:8:7"]), b = corruptSectors(flash, ["flip:0x20000:4096:8:7"]);
  assert.deepEqual(a, b);
  assert.equal(a.length, 1);
  assert.notDeepEqual(a[0].data, flash.slice(0x20000, 0x21000));
  assert.notDeepEqual(corruptSectors(flash, ["flip:0x20000:4096:8:8"]), a, "another seed flips other bits");
});

test.quick("power cycle carries flash over; corruption while 'off' is applied", () => {
  const sectors = corruptedSectors(engine, FELUCCA, ["zero:0x20000"]);
  const first = Fm1Machine.boot(engine, FELUCCA, { sectors });
  const again = first.powerCycle();
  assert.equal(again.flashHash(), first.flashHash());
  assert.deepEqual(again.changedSectors().map((s) => s.at), [0x20000]);
  const worse = first.powerCycle({ corrupt: ["zero:0x30000"] });
  assert.deepEqual(worse.changedSectors().map((s) => s.at), [0x20000, 0x30000]);
});

// What this records is about THIS ENGINE ONLY: its boot unpacks the package, never the live flash, so a zeroed sector 0 changes nothing. It is NOT evidence that the damage is harmless on
// hardware. The boot-area diagnostic (bootarea.mjs, docs/dev/BOOT-AREA.md) labels the same flash emulator-unbootable by the package-unpacker rules: an emulator-defined divergence, not a hardware claim.
test("KNOWN LIMITATION: the boot-area sector (0x0) is not used, so corrupting it changes nothing", () => {
  const base = watch(Fm1Machine.boot(engine, FELUCCA), { seconds: 2 });
  const sectors = corruptedSectors(engine, FELUCCA, ["zero:0x0"]);
  const hit = watch(Fm1Machine.boot(engine, FELUCCA, { sectors }), { seconds: 2 });
  assert.equal(hit.verdict, "booted");
  assert.equal(hit.final.lcdHash, base.final.lcdHash, "a bootloader-aware engine would differ here: bricking can now be tested");
});

test("KNOWN LIMITATION: the chip-key sector (0xFF000) is blank and unused", () => {
  const m = Fm1Machine.boot(engine, FELUCCA);
  assert.ok(m.flash().subarray(0xff000, 0x100000).every((b) => b === 0xff), "a real unit keeps its key here");
  const base = watch(m, { seconds: 2 });
  const sectors = corruptedSectors(engine, FELUCCA, ["zero:0xff000"]);
  const hit = watch(Fm1Machine.boot(engine, FELUCCA, { sectors }), { seconds: 2 });
  assert.equal(hit.final.lcdHash, base.final.lcdHash);
});

test.quick("flash record files round-trip and reject malformed input", () => {
  const sectors = [{ at: 0x5000, data: new Uint8Array(SECTOR).fill(7) }, { at: 0x1000, data: new Uint8Array(SECTOR).fill(9) }];
  assert.deepEqual(unpackRecords(packRecords(sectors)), sectors);
  assert.throws(() => unpackRecords(new Uint8Array(10)), /whole number/);
  assert.throws(() => packRecords([{ at: 5, data: new Uint8Array(SECTOR) }]), /bad sector offset/);
  assert.throws(() => packRecords([sectors[0], sectors[0]]), /twice/);
  assert.deepEqual(diffSectors(new Uint8Array(FLASH_SIZE), new Uint8Array(FLASH_SIZE)), []);
});

test.quick("corruption specs are validated", () => {
  assert.deepEqual(parseCorruption("zero:0x1000"), { kind: "zero", at: 0x1000, len: SECTOR });
  assert.throws(() => parseCorruption("melt:0"), /unknown corruption/);
  assert.throws(() => parseCorruption("flip:1:2"), /usage flip/);
  assert.throws(() => corruptSectors(new Uint8Array(FLASH_SIZE), ["zero:0x200000"]), /outside the 1 MiB/);
});

test.quick("a file that is not a firmware package is rejected, not booted", () => {
  assert.throws(() => Fm1Machine.boot(engine, new Uint8Array(5000).fill(1)), (e) => e instanceof BootError && e.code === "package-rejected");
});

// ======================================================================= flash ID selection (Component 2)
// ID selection only: these tests prove the JEDEC bytes the firmware sees can be chosen safely. They do
// NOT claim the engine behaves like a UC25HQ80 in any other way (see docs/dev/DECISIONS.md D11).
const OLD = [0x85, 0x60, 0x14], NEW = [0xb3, 0x60, 0x14];
const catalog = JSON.parse(readFileSync(resolve(EMULATOR_DIR, "firmwares.json"), "utf8")).firmwares;
const catalogPkg = (id) => new Uint8Array(readFileSync(resolve(EMULATOR_DIR, catalog.find((c) => c.id === id).package)));
const QUADRO = catalogPkg("quadro-fm1");   // writes its settings to flash only if it recognises the chip
const memo = new Map();
const runCase = (key, pkg, options = {}, seconds = 4) => {   // a deterministic run, remembered
  if (!memo.has(key)) {
    const m = Fm1Machine.boot(engine, pkg, options);
    const r = watch(m, { seconds });
    memo.set(key, { verdict: r.verdict, lcdHash: r.final.lcdHash, flashHash: m.flashHash(), flashRevision: r.final.flashRevision, emulatedMs: r.emulatedMs, idleMs: r.final.idleMs, colours: r.final.lcdColours });
  }
  return memo.get(key);
};
const idAt = (m, at) => [...new Uint8Array(m.x.memory.buffer, at, 3)];
const code = (c) => (e) => e instanceof FlashIdError && e.code === c;

test.quick("flash ID: this exact engine build has a validated layout; unknown builds do not", () => {
  assert.equal(engine.capabilities.flashIdPatch, true);
  assert.deepEqual(engine.flashIdLayout, FLASH_ID_LAYOUTS[engine.wasmSha256]);
  assert.equal(engine.capabilities.selectFlashId, false, "no native engine export yet");
});

test.quick("flash ID: requested IDs are validated (only the two hardware revisions are selectable)", () => {
  for (const [input, name] of [["puya", "puya"], ["PUYA", "puya"], ["old", "puya"], ["0x856014", "puya"], ["856014", "puya"], [[0x85, 0x60, 0x14], "puya"],
    ["uc25hq80", "uc25hq80"], ["new", "uc25hq80"], ["0xB36014", "uc25hq80"], [[179, 96, 20], "uc25hq80"]]) assert.equal(parseFlashId(input).name, name, JSON.stringify(input));
  for (const bad of ["", "0x000000", "eb6014", "85 60 14", "0x85601", "0x8560145", "newer", [1, 2, 3], [0x85, 0x60], [256, 0, 0], 0x856014, {}, true])
    assert.throws(() => parseFlashId(bad), code("invalid-id"), JSON.stringify(bad));
  assert.throws(() => Fm1Machine.boot(engine, FELUCCA, { flashId: "0x000000" }), code("invalid-id"));
  assert.throws(() => Fm1Machine.boot(engine, FELUCCA, { flashId: "eb6014" }), code("invalid-id"), "the SMK-37's ID is recognised, not selectable");
});

test.quick("flash ID: the live copy is PROVEN (engine's own getter), and only it is patched", () => {
  const m = Fm1Machine.boot(engine, FELUCCA);
  const found = locateLiveFlashId(m.x, engine.flashIdLayout);
  assert.equal(found.copies, 3, "3 chip-structure copies carry a known ID");
  assert.deepEqual(found.bytes, OLD);
  const others = found.candidates.map((c) => c + engine.flashIdLayout.jedecOffsetFromFlashPtr).filter((a) => a !== found.address);
  assert.equal(others.length, 2);
  const n = Fm1Machine.boot(engine, FELUCCA, { flashId: "uc25hq80" });
  assert.equal(n.flashIdInfo.address, found.address, "same live copy on a fresh boot");
  assert.deepEqual(idAt(n, found.address), NEW);
  for (const a of others) assert.deepEqual(idAt(n, a), OLD, "stale copies are left alone");
});

test.quick("flash ID: both IDs read back; the default is the older chip", () => {
  const def = Fm1Machine.boot(engine, FELUCCA);
  assert.equal(def.flashIdInfo, null);
  assert.equal(def.flashId().name, "puya");
  assert.equal(Fm1Machine.boot(engine, FELUCCA, { flashId: "puya" }).flashId().name, "puya");
  const n = Fm1Machine.boot(engine, FELUCCA, { flashId: "new" });
  assert.deepEqual(n.flashId().bytes, NEW);
  assert.deepEqual(n.flashIdInfo.previous, OLD);
});

// One test, in both tiers: the fast memory-identity check always runs; the slower whole-run comparison
// (about 4.5 s) runs only in the full tier (`full` is false under --quick).
test.quick("flash ID: default is untouched. Explicit puya == no option; uc25hq80 differs by exactly one byte of memory", ({ full }) => {
  const snap = (opts) => new Uint8Array(Fm1Machine.boot(engine, FELUCCA, opts).x.memory.buffer).slice();
  const a = snap({}), b = snap({ flashId: "puya" }), c = snap({ flashId: "uc25hq80" });
  const diff = (p, q) => { const d = []; for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) d.push(i); return d; };
  assert.deepEqual(diff(a, b), [], "writing the default ID changes nothing in engine memory");
  const d = diff(a, c);
  assert.equal(d.length, 1, "0x85 -> 0xB3; the other two ID bytes are equal");
  assert.equal(a[d[0]], 0x85); assert.equal(c[d[0]], 0xb3);
  if (!full) return;
  // and a whole run matches Component 1's behaviour exactly
  const r0 = runCase("felucca|default", FELUCCA, {}, 2), r1 = runCase("felucca|puya", FELUCCA, { flashId: "puya" }, 2);
  assert.deepEqual(r1, r0);
});

test("flash ID: firmware that probes the chip reacts (quadro-fm1 stops saving; AURORA's screen changes)", () => {
  const old = runCase("quadro|puya", QUADRO, { flashId: "puya" }), nu = runCase("quadro|uc25hq80", QUADRO, { flashId: "uc25hq80" });
  assert.deepEqual(runCase("quadro|default", QUADRO, {}), old, "default == older hardware");
  assert.ok(old.flashRevision > 0 && nu.flashRevision === 0, `flash writes ${old.flashRevision} -> ${nu.flashRevision}`);
  assert.notEqual(old.flashHash, nu.flashHash);
  const aurora = catalogPkg("aurora");
  assert.notEqual(runCase("aurora|puya", aurora, { flashId: "puya" }).lcdHash, runCase("aurora|uc25hq80", aurora, { flashId: "uc25hq80" }).lcdHash);
});

test("flash ID: justification for patching only the live copy (stale copies are inert; live-only == all three)", () => {
  const live = runCase("quadro|uc25hq80", QUADRO, { flashId: "uc25hq80" });
  const raw = (which) => {
    const m = Fm1Machine.boot(engine, QUADRO);
    const f = locateLiveFlashId(m.x, engine.flashIdLayout);
    const all = f.candidates.map((c) => c + engine.flashIdLayout.jedecOffsetFromFlashPtr);
    for (const a of which(all, f.address)) new Uint8Array(m.x.memory.buffer).set(NEW, a);
    const r = watch(m, { seconds: 4 });
    return { lcdHash: r.final.lcdHash, flashRevision: r.final.flashRevision, flashHash: m.flashHash() };
  };
  const stale = raw((all, liveAt) => all.filter((a) => a !== liveAt)), every = raw((all) => all);
  const def = runCase("quadro|default", QUADRO, {});
  assert.equal(stale.flashRevision, def.flashRevision, "patching only the stale copies changes nothing");
  assert.equal(stale.lcdHash, def.lcdHash);
  assert.equal(every.flashRevision, live.flashRevision, "patching all three behaves like the live copy alone");
  assert.equal(every.lcdHash, live.lcdHash);
});

test("flash ID: runs are repeatable on both IDs", () => {
  for (const id of ["puya", "uc25hq80"]) {
    const first = runCase(`quadro|${id}`, QUADRO, { flashId: id });
    const m = Fm1Machine.boot(engine, QUADRO, { flashId: id }), r = watch(m, { seconds: 4 });
    assert.deepEqual({ verdict: r.verdict, lcdHash: r.final.lcdHash, flashHash: m.flashHash(), flashRevision: r.final.flashRevision, emulatedMs: r.emulatedMs, idleMs: r.final.idleMs, colours: r.final.lcdColours }, first, id);
  }
});

test.quick("flash ID: a power cycle keeps the chosen ID; it can be changed at power-on; default stays default", () => {
  const n = Fm1Machine.boot(engine, FELUCCA, { flashId: "uc25hq80" });
  assert.equal(n.options.flashId, "uc25hq80");
  assert.equal(n.powerCycle().flashId().name, "uc25hq80");
  assert.equal(n.powerCycle({ flashId: "puya" }).flashId().name, "puya", "swap the chip while it is off");
  assert.equal(n.powerCycle({ flashId: null }).flashIdInfo, null);
  const d = Fm1Machine.boot(engine, FELUCCA);
  const cycled = d.powerCycle();
  assert.equal(cycled.flashIdInfo, null);
  assert.equal(cycled.flashId().name, "puya");
  const corrupt = n.powerCycle({ corrupt: ["zero:0x20000"] });          // other power-cycle features still compose
  assert.equal(corrupt.flashId().name, "uc25hq80");
  assert.deepEqual(corrupt.changedSectors().map((s) => s.at), [0x20000]);
});

test("flash ID: an engine build without a validated layout is refused; the default path still works", () => {
  const stranger = { ...engine, wasmSha256: "0".repeat(64), flashIdLayout: null, capabilities: { ...engine.capabilities, flashIdPatch: false } };
  assert.throws(() => Fm1Machine.boot(stranger, FELUCCA, { flashId: "puya" }), code("unsupported-engine"));
  assert.throws(() => Fm1Machine.boot(stranger, FELUCCA, { flashId: "uc25hq80" }), code("unsupported-engine"));
  const plain = Fm1Machine.boot(stranger, FELUCCA);                       // no ID requested: untouched, works
  assert.equal(watch(plain, { seconds: 1 }).verdict, "booted");
  assert.throws(() => plain.flashId(), code("unsupported-engine"));
  assert.throws(() => locateLiveFlashId(plain.x, null), code("unsupported-engine"));
});

test.quick("flash ID: refused on a board other than the FM-1", () => {
  const smk = { ...engine, instantiate: () => ({ ...engine.instantiate(), fm1_board: () => 1 }) };   // (the export object is frozen: copy it)
  assert.throws(() => Fm1Machine.boot(smk, FELUCCA, { flashId: "uc25hq80" }), code("unsupported-board"));
  assert.equal(Fm1Machine.boot(smk, FELUCCA).flashIdInfo, null, "without the option nothing is checked or touched");
});

// A stand-in for the engine's memory, so the safety refusals can be tested without a real engine.
function fakeX({ copies = [0x100, 0x2000, 0x4000], liveWord = 0x4024, idBytes = OLD, stalePtr = false, constantRevision = false } = {}) {
  const mem = new Uint8Array(1 << 16), dv = new DataView(mem.buffer), PTR = 0x8000;
  for (const c of copies) { dv.setUint32(c, PTR, true); mem.set(idBytes, c + 48); }
  if (stalePtr) dv.setUint32(0x6000, PTR + 4, true);
  return { mem, dv, x: { memory: { buffer: mem.buffer }, fm1_flash: () => PTR, fm1_flash_len: () => 256, fm1_xip: () => 0x9000, fm1_xip_len: () => 16, fm1_flash_base: () => 0xa000,
    fm1_flash_revision: () => (constantRevision ? 0 : dv.getInt32(liveWord, true)) } };       // a signed i32, like the real export
}
const LAYOUT = { jedecOffsetFromFlashPtr: 48, searchWindow: 256, copies: 3 };

test.quick("flash ID safety (synthetic memory): proves the live copy, patches only it, restores every probe write", () => {
  const { mem, x } = fakeX();
  const before = mem.slice();
  const found = locateLiveFlashId(x, LAYOUT);
  assert.equal(found.address, 0x4000 + 48);
  assert.deepEqual(mem, before, "locating changes nothing");
  const r = applyFlashId(x, LAYOUT, FLASH_IDS.uc25hq80);
  assert.deepEqual([...mem.slice(0x4030, 0x4033)], NEW);
  assert.deepEqual([...mem.slice(0x130, 0x133)], OLD); assert.deepEqual([...mem.slice(0x2030, 0x2033)], OLD);
  const changed = []; for (let i = 0; i < mem.length; i++) if (mem[i] !== before[i]) changed.push(i);
  assert.deepEqual(changed, [0x4030], "exactly one byte differs");
  assert.equal(r.method, "runtime-patch");
});

test.quick("flash ID safety (synthetic memory): wrong layout, wrong ID, no live copy, ambiguity: all refuse and change nothing", () => {
  const refuse = (setup, expectedCode, layout = LAYOUT) => {
    const { mem, x } = fakeX(setup), before = mem.slice();
    assert.throws(() => applyFlashId(x, layout, FLASH_IDS.uc25hq80), code(expectedCode), JSON.stringify(setup));
    assert.deepEqual(mem, before, `memory untouched after ${expectedCode}`);
  };
  refuse({ copies: [0x100, 0x2000] }, "layout-mismatch");                          // fewer copies than validated
  refuse({ copies: [0x100, 0x2000, 0x4000, 0x6000] }, "layout-mismatch");          // more copies than validated
  refuse({ idBytes: [0x12, 0x34, 0x56] }, "layout-mismatch");                      // not a known ID at the validated offset
  refuse({ constantRevision: true }, "no-live-copy");                              // getter never echoes: cannot prove liveness
  refuse({ copies: [0x100, 0x140, 0x4000], liveWord: 0x124 }, "ambiguous");        // two candidates' windows reach the live word
  refuse({}, "unsupported-engine", null);                                          // no validated layout at all
  refuse({}, "layout-mismatch", { ...LAYOUT, jedecOffsetFromFlashPtr: 52 });       // layout offset does not match this memory
});

test("flash ID: CLI default output is unchanged; the option and invalid IDs behave", () => {
  const cli = (...args) => spawnSync(process.execPath, [resolve(import.meta.dirname, "cli.mjs"), ...args], { encoding: "utf8" });
  const plain = JSON.parse(cli("--fw", "felucca", "--seconds", "1", "--json").stdout);
  assert.deepEqual(Object.keys(plain), ["engine", "package", "options", "expected", "pass", "verdict", "haltedAtMs", "emulatedMs", "final", "activity", "flash"]);
  assert.deepEqual(Object.keys(plain.options), ["seconds", "mhz", "corrupt", "flashFile"]);
  const withId = JSON.parse(cli("--fw", "felucca", "--seconds", "1", "--json", "--flash-id", "new").stdout);
  assert.equal(withId.flashId.name, "uc25hq80"); assert.equal(withId.options.flashId, "new");
  const bad = cli("--fw", "felucca", "--flash-id", "0xdeadbe");
  assert.equal(bad.status, 2); assert.match(bad.stderr, /unsupported flash ID/);
});


// ======================================================================= flash chip profiles (Component 4, Stage C2)
// Chip PROFILES (flashchip.mjs) are a different thing from the ID-only option above: a datasheet-based chip model inside a
// chip-profile engine. The configuration tests below need no such engine (they use the shipped engine and stand-ins that
// record the calls the harness makes); the live tests at the end need the engine built by ci/engine/build.mjs.
const chipCode = (c) => (e) => e instanceof FlashChipError && e.code === c;
/** The shipped engine with the chip exports stubbed: records every call, so order and arguments can be checked. */
function stubChipEngine(calls, { board = 0, chipRc = 0, timingRc = 0, nv = null, uid = false } = {}) {
  return {
    ...engine, name: "stub-chip-engine",
    capabilities: { ...engine.capabilities, selectFlashChip: true, flashNv: nv !== null, flashUid: uid },
    instantiate: () => {
      const real = engine.instantiate();
      return { ...real, fm1_board: () => board,
        fm1_flash_chip: (id) => { calls.push(["chip", id]); return chipRc; },
        fm1_flash_timing: (mode) => { calls.push(["timing", mode]); return timingRc; },
        fm1_flash_nv_status: () => nv,
        fm1_flash_uid_set: (...w) => { calls.push(["uid", ...w]); return 0; },
        fm1_flash_nv_restore: (v) => { calls.push(["nv", v]); return 0; },
        fm1_render: (...a) => { calls.push(["render"]); return real.fm1_render(...a); } };
    },
  };
}

test.quick("flash chip: the shipped engine has no chip profiles; the default boots exactly as before, nothing is called", () => {
  const m = Fm1Machine.boot(engine, FELUCCA);
  assert.equal(m.flashChipInfo, null);
  assert.equal(m.options.flashChip, null);
  assert.equal(m.options.flashTiming, null);
  assert.ok(!("flashWip" in m.observe()), "the observation keeps its old shape without chip support");
  assert.throws(() => m.flashWip(), /lacks: flashWip/);
  assert.throws(() => m.flashEvents(), /lacks: flashEvents/);
  assert.deepEqual(Object.keys(FLASH_CHIPS), ["legacy", "puya", "uc25hq80"]);
  assert.equal(FLASH_CHIPS.legacy.id, 0, "id 0 is the original model: the default");
});

test.quick("flash chip: explicit legacy is the default: engine memory identical, no chip exports needed", () => {
  const snap = (opts) => new Uint8Array(Fm1Machine.boot(engine, FELUCCA, opts).x.memory.buffer).slice();
  assert.deepEqual(snap({ flashChip: "legacy" }), snap({}));
  assert.deepEqual(resolveFlashChipOptions({}), { chip: "legacy", timing: null });
  assert.deepEqual(resolveFlashChipOptions({ flashChip: "LEGACY" }), { chip: "legacy", timing: null });
  assert.deepEqual(resolveFlashChipOptions({ flashChip: "original" }), { chip: "legacy", timing: null });
});

test.quick("flash chip: profile and timing names are parsed strictly; aliases match flashId's", () => {
  for (const [input, name] of [["puya", "puya"], ["PUYA", "puya"], ["old", "puya"], [" uc25hq80 ", "uc25hq80"], ["new", "uc25hq80"], ["legacy", "legacy"]]) assert.equal(parseFlashChip(input), name, input);
  for (const bad of ["", "eb6014", "0x856014", "p25q80h", "newer", 1, 0, null, undefined, {}, ["puya"], true]) assert.throws(() => parseFlashChip(bad), chipCode("invalid-chip"), JSON.stringify(bad));
  assert.equal(parseFlashTiming("typical"), "typical");
  assert.equal(parseFlashTiming("MAXIMUM"), "maximum");
  for (const bad of ["", "min", "minimum", "fast", 0, 1, null, undefined, {}]) assert.throws(() => parseFlashTiming(bad), chipCode("invalid-timing"), JSON.stringify(bad));
  assert.deepEqual(resolveFlashChipOptions({ flashChip: "puya" }), { chip: "puya", timing: "typical" }, "typical is the timing default");
  assert.deepEqual(resolveFlashChipOptions({ flashChip: "new", flashTiming: "maximum" }), { chip: "uc25hq80", timing: "maximum" });
});

test.quick("flash chip: invalid, conflicting or unsupported options are refused before anything boots", () => {
  let booted = false;
  const tripwire = { ...engine, instantiate: () => { booted = true; throw new Error("booted"); } };
  const refuse = (opts, c) => assert.throws(() => Fm1Machine.boot(tripwire, FELUCCA, opts), chipCode(c), JSON.stringify(opts));
  refuse({ flashChip: "bogus" }, "invalid-chip");
  refuse({ flashChip: 7 }, "invalid-chip");
  refuse({ flashChip: "puya", flashTiming: "fast" }, "invalid-timing");
  refuse({ flashTiming: "typical" }, "timing-needs-chip");
  refuse({ flashChip: "legacy", flashTiming: "maximum" }, "timing-needs-chip");
  refuse({ flashChip: "puya", flashId: "puya" }, "id-conflict");
  refuse({ flashChip: "uc25hq80", flashId: "new" }, "id-conflict");
  refuse({ flashChip: "puya" }, "unsupported-engine");                  // a valid request, but this engine has no profiles
  assert.equal(booted, false, "nothing was instantiated for any of these");
  assert.throws(() => Fm1Machine.boot(engine, FELUCCA, { flashChip: "uc25hq80" }), chipCode("unsupported-engine"));
});

test.quick("flash chip: selection calls the engine's exports with the right ids, before the first render; legacy and flashId call none", () => {
  for (const [opts, expected] of [
    [{ flashChip: "puya" }, [["chip", 1], ["timing", 0]]],
    [{ flashChip: "puya", flashTiming: "maximum" }, [["chip", 1], ["timing", 1]]],
    [{ flashChip: "uc25hq80" }, [["chip", 2], ["timing", 0]]],
    [{ flashChip: "new", flashTiming: "maximum" }, [["chip", 2], ["timing", 1]]],
    [{ flashChip: "legacy" }, []],
    [{}, []],
    [{ flashId: "uc25hq80" }, []],
  ]) {
    const calls = [], m = Fm1Machine.boot(stubChipEngine(calls), FELUCCA, opts);
    assert.deepEqual(calls, expected, `${JSON.stringify(opts)}: selected during boot, nothing rendered yet`);
    m.run(10);
    assert.deepEqual(calls.slice(0, expected.length), expected, "the selection precedes every render");
    assert.ok(calls.length > expected.length && calls.slice(expected.length).every((c) => c[0] === "render"), "only renders follow");
    const chosen = opts.flashChip && opts.flashChip !== "legacy";
    assert.deepEqual(m.flashChipInfo === null ? null : [m.flashChipInfo.chip, m.flashChipInfo.timing], chosen ? [parseFlashChip(opts.flashChip), opts.flashTiming ?? "typical"] : null);
  }
  assert.deepEqual(Fm1Machine.boot(stubChipEngine([]), FELUCCA, { flashChip: "puya" }).flashChipInfo.jedec, [0x85, 0x60, 0x14]);
  assert.deepEqual(Fm1Machine.boot(stubChipEngine([]), FELUCCA, { flashChip: "uc25hq80" }).flashChipInfo.jedec, [0xb3, 0x60, 0x14]);
});

test.quick("flash chip: an engine that refuses the profile, or a board other than the FM-1, stops the boot", () => {
  assert.throws(() => Fm1Machine.boot(stubChipEngine([], { chipRc: 1 }), FELUCCA, { flashChip: "puya" }), chipCode("engine-refused"));
  assert.throws(() => Fm1Machine.boot(stubChipEngine([], { timingRc: 1 }), FELUCCA, { flashChip: "puya" }), chipCode("engine-refused"));
  const calls = [];
  assert.throws(() => Fm1Machine.boot(stubChipEngine(calls, { board: 1 }), FELUCCA, { flashChip: "puya" }), chipCode("unsupported-board"));
  assert.deepEqual(calls, [], "no profile was selected on the wrong board");
  assert.equal(Fm1Machine.boot(stubChipEngine([], { board: 1 }), FELUCCA).flashChipInfo, null, "without the option nothing is checked or touched");
});

test.quick("flash chip: a power cycle keeps the chip and timing; they can be swapped while the unit is off", () => {
  const calls = [], eng = stubChipEngine(calls), m = Fm1Machine.boot(eng, FELUCCA, { flashChip: "puya", flashTiming: "maximum" });
  const again = m.powerCycle();
  assert.deepEqual([again.flashChipInfo.chip, again.flashChipInfo.timing], ["puya", "maximum"]);
  assert.deepEqual(calls.filter((c) => c[0] !== "render").slice(2), [["chip", 1], ["timing", 1]]);
  const swapped = m.powerCycle({ flashChip: "uc25hq80", flashTiming: "typical" });
  assert.deepEqual([swapped.flashChipInfo.chip, swapped.flashChipInfo.timing], ["uc25hq80", "typical"]);
  const back = m.powerCycle({ flashChip: null, flashTiming: null });
  assert.equal(back.flashChipInfo, null, "back to the original model");
  assert.throws(() => m.powerCycle({ flashChip: null }), chipCode("timing-needs-chip"), "timing without a chip is refused here too");
});

test.quick("flash chip: flashNvStatus is validated, needs a chip profile and an engine that can restore it, and is applied right after the profile", () => {
  const calls = [], eng = stubChipEngine(calls, { nv: 0 });
  for (const bad of [-1, 1.5, 2 ** 32, "0", NaN, {}]) assert.throws(() => Fm1Machine.boot(eng, FELUCCA, { flashChip: "puya", flashNvStatus: bad }), chipCode("invalid-nv-status"), String(bad));
  assert.throws(() => Fm1Machine.boot(eng, FELUCCA, { flashNvStatus: 5 }), chipCode("nv-needs-chip"));
  assert.throws(() => Fm1Machine.boot(eng, FELUCCA, { flashChip: "legacy", flashNvStatus: 5 }), chipCode("nv-needs-chip"));
  assert.throws(() => Fm1Machine.boot(stubChipEngine([]), FELUCCA, { flashChip: "puya", flashNvStatus: 5 }), chipCode("unsupported-engine"), "an engine without the flashNv capability");
  assert.deepEqual(calls, [], "nothing was selected for any refused request");
  const m = Fm1Machine.boot(eng, FELUCCA, { flashChip: "uc25hq80", flashTiming: "maximum", flashNvStatus: 0x40001234 });
  assert.deepEqual(calls, [["chip", 2], ["timing", 1], ["nv", 0x40001234]]);
  assert.ok(!("flashNvStatus" in m.options), "not stored: a later power cycle takes the live value");
});

test.quick("flash chip: a power cycle carries the chip's non-volatile status for the same chip only; an override wins; legacy and swapped chips carry nothing", () => {
  const calls = [], eng = stubChipEngine(calls, { nv: 0x00004a84 });
  const m = Fm1Machine.boot(eng, FELUCCA, { flashChip: "puya" });
  const nvCalls = () => calls.filter((c) => c[0] === "nv");
  m.powerCycle();
  assert.deepEqual(nvCalls(), [["nv", 0x4a84]], "the live status was read and restored");
  m.powerCycle({ flashChip: "puya", flashTiming: "maximum" });
  assert.deepEqual(nvCalls().length, 2, "same chip, new timing: still carried");
  m.powerCycle({ flashChip: "uc25hq80" });
  assert.deepEqual(nvCalls().length, 2, "a different chip swapped in while off starts fresh");
  m.powerCycle({ flashChip: "old" });
  assert.deepEqual(nvCalls().length, 3, "aliases count as the same chip");
  m.powerCycle({ flashNvStatus: 7 });
  assert.deepEqual(nvCalls().at(-1), ["nv", 7], "an explicit value wins");
  const before = calls.length;
  Fm1Machine.boot(eng, FELUCCA).powerCycle();
  assert.deepEqual(calls.slice(before), calls.slice(before).filter((c) => c[0] === "render"), "legacy: no chip call of any kind");
  const plain = Fm1Machine.boot(stubChipEngine([]), FELUCCA, { flashChip: "puya" });
  assert.doesNotThrow(() => plain.powerCycle(), "an engine without the flashNv capability just boots the chip fresh (as before)");
});

test.quick("flash chip: flashUid is parsed strictly, validated before boot, applied right after the profile, and a power cycle keeps it for the same chip only", () => {
  const HEX = "13579bdf02468acef1e2d3c4b5a69788";
  for (const ok of [HEX, HEX.toUpperCase(), "0x" + HEX, ` ${HEX} `, [...Buffer.from(HEX, "hex")], Uint8Array.from(Buffer.from(HEX, "hex"))]) assert.equal(parseFlashUid(ok), HEX);
  for (const bad of ["", HEX.slice(1), HEX + "0", "zz" + HEX.slice(2), [1, 2, 3], new Array(16).fill(256), new Array(16).fill(-1), new Array(16).fill(1.5), 5, null, {}, true]) assert.throws(() => parseFlashUid(bad), chipCode("invalid-uid"), JSON.stringify(bad));
  assert.deepEqual(uidWords(HEX), [0x13579bdf, 0x02468ace, 0xf1e2d3c4, 0xb5a69788], "word 0 holds bytes 0-3, byte 0 in the top byte");
  const calls = [], eng = stubChipEngine(calls, { uid: true });
  assert.throws(() => Fm1Machine.boot(eng, FELUCCA, { flashUid: HEX }), chipCode("uid-needs-chip"));
  assert.throws(() => Fm1Machine.boot(eng, FELUCCA, { flashChip: "legacy", flashUid: HEX }), chipCode("uid-needs-chip"));
  assert.throws(() => Fm1Machine.boot(eng, FELUCCA, { flashChip: "puya", flashUid: "nope" }), chipCode("invalid-uid"));
  assert.throws(() => Fm1Machine.boot(stubChipEngine([], { uid: false }), FELUCCA, { flashChip: "puya", flashUid: HEX }), chipCode("unsupported-engine"), "an engine without the flashUid capability");
  assert.deepEqual(calls, [], "nothing was selected for any refused request");
  const m = Fm1Machine.boot(eng, FELUCCA, { flashChip: "puya", flashUid: HEX.toUpperCase() });
  assert.deepEqual(calls, [["chip", 1], ["timing", 0], ["uid", 0x13579bdf, 0x02468ace, 0xf1e2d3c4, 0xb5a69788]]);
  assert.equal(m.options.flashUid, HEX, "stored normalised, so a power cycle keeps it");
  const uidCalls = () => calls.filter((c) => c[0] === "uid").length;
  m.powerCycle(); assert.equal(uidCalls(), 2, "same chip: kept");
  m.powerCycle({ flashChip: "uc25hq80" }); assert.equal(uidCalls(), 2, "a different chip swapped in while off has no fixture");
  m.powerCycle({ flashChip: "old", flashTiming: "maximum" }); assert.equal(uidCalls(), 3, "same chip (alias): kept");
  m.powerCycle({ flashUid: "00".repeat(16) }); assert.deepEqual(calls.filter((c) => c[0] === "uid").at(-1), ["uid", 0, 0, 0, 0], "an explicit value wins");
  m.powerCycle({ flashChip: null, flashTiming: null }); assert.equal(uidCalls(), 4, "back to the original model: no fixture, no error");
  assert.equal(m.powerCycle({ flashChip: null, flashTiming: null }).options.flashUid, null);
});

test.quick("chip engine pin: the patch and the tables generated from chipspec.mjs are the ones the pin records (one source of truth)", () => {
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  assert.equal(sha(readFileSync(resolve(import.meta.dirname, "../engine", PIN.patch.file))), PIN.patch.sha256, "ci/engine/chip-profiles.patch changed: update pin.json deliberately");
  assert.equal(sha(renderTables()), PIN.generatedTablesSha256, "chipspec.mjs changed: rebuild the engine (node ci/engine/build.mjs --test) and update pin.json");
  assert.equal(PIN.upstream.commit, "631b790b191e87ea8b796d351cfe7e61ab366794");
  assert.equal(PIN.expectedExports.length, 73);   // the 48 of an unpatched v0.3.0 build, 12 chip/test exports (Stage C), 13 fault-injection exports (Component 5: 12 in 5C-3, fm1_fault_set_ranges in 5D)
  for (const n of PIN.addedExports) assert.ok(PIN.expectedExports.includes(n), n);
  assert.ok(!engine.exportNames.has("fm1_flash_chip"), "the shipped engine was not replaced");
});

test("flash chip: CLI default output unchanged; bad, conflicting and unsupported options exit 2 with a reason", () => {
  const cli = (...args) => spawnSync(process.execPath, [resolve(import.meta.dirname, "cli.mjs"), ...args], { encoding: "utf8", env: { ...process.env, FM1_CHIP_ENGINE: resolve(import.meta.dirname, "no-such-engine.wasm") } });
  const plain = JSON.parse(cli("--fw", "felucca", "--seconds", "1", "--json").stdout);
  assert.ok(!("flashChip" in plain) && !("flashChip" in plain.options), "no chip keys unless asked");
  for (const [args, reason] of [[["--flash-chip", "bogus"], /unsupported flash chip.*invalid-chip/], [["--flash-timing", "typical"], /timing-needs-chip/], [["--flash-chip", "puya", "--flash-timing", "fast"], /invalid-timing/],
    [["--flash-chip", "puya", "--flash-id", "old"], /id-conflict/], [["--flash-chip", "puya"], /no flash chip profiles.*unsupported-engine/]]) {
    const r = cli("--fw", "felucca", "--seconds", "1", ...args);
    assert.equal(r.status, 2, args.join(" ")); assert.match(r.stderr, reason, args.join(" "));
  }
  assert.notEqual(cli("--fw", "felucca", "--engine", "no-such.wasm").status, 0);
});

// ---- live tests: need the chip-profile engine built by ci/engine/build.mjs (SKIPPED, loudly, when it is not there)
const chipRun = (id, options, seconds = 4) => {
  const m = Fm1Machine.boot(chipEngine, id === "felucca" ? FELUCCA : QUADRO, options), r = watch(m, { seconds });
  return { verdict: r.verdict, lcdHash: r.final.lcdHash, flashHash: m.flashHash(), flashRevision: r.final.flashRevision, emulatedMs: r.emulatedMs, idleMs: r.final.idleMs, m };
};
const strip = ({ m, ...rest }) => rest;

test.chip("flash chip (live): the built engine is the one the pin describes: exact exports and imports, hash for its toolchain", () => {
  const v = verifyEngineFile(chipEnginePath);
  assert.deepEqual({ missing: v.missing, unexpected: v.unexpected, importsOk: v.importsOk }, { missing: [], unexpected: [], importsOk: true });
  assert.notEqual(v.hash, "MISMATCH", `${v.sha256} is not the verified hash for ${v.rustc}`);
  for (const k of ["selectFlashChip", "flashWip", "flashEvents"]) assert.equal(chipEngine.capabilities[k], true, k);
  assert.notEqual(chipEngine.wasmSha256, engine.wasmSha256, "a separate engine: the shipped one is untouched");
  assert.equal(chipEngine.flashIdLayout, null, "no flash-ID runtime-patch layout for this build (it has native profiles instead)");
});

// usb: false on BOTH engines: the chip engine is built from upstream v0.3.0, which has no fm1_usb_plug (the shipped engine's
// virtual USB host), so with the harness's default usb: true the two would differ for that reason alone.
test.chip("flash chip (live): the default profile on the chip engine behaves like the shipped engine, USB host off (Felucca, quadro-fm1: LCD, flash, writes, clock)", () => {
  assert.equal(chipEngine.exportNames.has("fm1_usb_plug"), false, "known: v0.3.0 has no USB host plug");
  for (const [id, pkg] of [["felucca", FELUCCA], ["quadro", QUADRO]]) {
    const shipped = runCase(`${id}|shipped-3s-nousb`, pkg, { usb: false }, 3);
    const chips = strip(chipRun(id, { usb: false }, 3)), explicit = strip(chipRun(id, { usb: false, flashChip: "legacy" }, 3));
    assert.deepEqual(chips, { verdict: shipped.verdict, lcdHash: shipped.lcdHash, flashHash: shipped.flashHash, flashRevision: shipped.flashRevision, emulatedMs: shipped.emulatedMs, idleMs: shipped.idleMs }, `${id}: default on the chip engine == the shipped engine`);
    assert.deepEqual(explicit, chips, `${id}: explicit legacy too`);
  }
});

test.chip("flash chip (live): selecting a profile takes effect (quadro-fm1 saves settings on Puya, not on UC25HQ80); the default stays legacy", () => {
  const legacy = chipRun("quadro", {}), puya = chipRun("quadro", { flashChip: "puya" }), uc = chipRun("quadro", { flashChip: "uc25hq80" });
  assert.ok(legacy.flashRevision > 0, "legacy writes its settings");
  assert.ok(puya.flashRevision > 0, "the Puya profile reports 85 60 14: recognised, so it still writes");
  assert.equal(uc.flashRevision, 0, "the UC25HQ80 profile reports B3 60 14: not recognised, nothing written");
  assert.notEqual(uc.flashHash, puya.flashHash);
  assert.equal(legacy.m.flashChipInfo, null);
  assert.deepEqual(puya.m.flashChipInfo, { chip: "puya", timing: "typical", jedec: [0x85, 0x60, 0x14] });
  assert.deepEqual(uc.m.flashChipInfo.jedec, [0xb3, 0x60, 0x14]);
});

test.chip("flash chip (live): WIP is its own export (never set by the legacy model) and follows the selected timing (maximum holds it longer than typical)", () => {
  const wipSamples = (options) => {
    const m = Fm1Machine.boot(chipEngine, QUADRO, options);
    let wip = 0, busy = 0;
    for (let i = 0; i < 1400; i++) { m.run(3); wip += m.flashWip(); busy += m.observe().flashBusy; }   // a sample every 3 ms of audio time
    return { wip, busy, m };
  };
  const legacy = wipSamples({}), typ = wipSamples({ flashChip: "puya", flashTiming: "typical" }), max = wipSamples({ flashChip: "puya", flashTiming: "maximum" }), again = wipSamples({ flashChip: "puya", flashTiming: "maximum" });
  assert.ok(legacy.m.changedSectors().length > 0, "the firmware did write flash in this window");
  assert.equal(legacy.wip, 0, "the original model never reports a write cycle: WIP is not chip-select, whose export is unchanged");
  assert.ok(typ.wip > 0, "a flash cycle was seen in progress under the Puya profile");
  assert.ok(max.wip > typ.wip, `maximum timing holds WIP longer: ${typ.wip} -> ${max.wip} samples`);
  assert.equal(again.wip, max.wip, "deterministic");
  assert.deepEqual(typ.m.flashEvents(), { unspecified: 0, notModeled: 0, lastNotModeled: 0 }, "4Bh is modelled: no unmodelled or unspecified command");
  assert.equal(typ.m.flashUidUnknownReads(), 1, "quadro-fm1 reads the unique ID (4Bh) once; with no fixture configured the read is answered FF and counted as unknown, not guessed");
});

test.chip("flash chip (live): a power cycle keeps the profile; options are still validated on the chip engine", () => {
  const m = Fm1Machine.boot(chipEngine, FELUCCA, { flashChip: "uc25hq80", flashTiming: "maximum" });
  const again = m.powerCycle();
  assert.deepEqual([again.flashChipInfo.chip, again.flashChipInfo.timing], ["uc25hq80", "maximum"]);
  assert.deepEqual(m.powerCycle({ flashChip: "puya" }).flashChipInfo.jedec, [0x85, 0x60, 0x14]);
  assert.throws(() => Fm1Machine.boot(chipEngine, FELUCCA, { flashChip: "puya", flashId: "puya" }), chipCode("id-conflict"));
  assert.throws(() => Fm1Machine.boot(chipEngine, FELUCCA, { flashChip: "bogus" }), chipCode("invalid-chip"));
  assert.equal(chipEngine.exportNames.has("fm1_flash_busy"), true, "the chip-select busy export is still there, unchanged");
});

registerLiveChipTests(test.chip, { chipEngine, pkg: FELUCCA, quadro: QUADRO });   // live chip conformance (Stage C3), full tier, needs the chip engine
registerFirmwareTests(test.chip, { chipEngine, catalogPkg });
registerFaultSurveyQuickTests(test.quick);   // the fault survey tool and its committed results (Component 5, Stage 5E)
registerFaultHarnessQuickTests(test.quick);   // the fault-injection harness API, pure logic over a stand-in engine (Component 5, Stage 5D)
registerFaultLiveTests(test.chip, { chipEngine, pkg: FELUCCA, quadro: QUADRO });   // fault-injection exports and clock syncs (Component 5, Stage 5C-3), full tier, needs the chip engine
registerFaultHarnessLiveTests(test.chip, { chipEngine, shipped: engine, pkg: FELUCCA, quadro: QUADRO });
registerFaultSurveyLiveTests(test.chip, { chipEngine, shipped: engine, pkg: FELUCCA, quadro: QUADRO });   // the harness API over real firmware (Stage 5D), full tier, needs the chip engine   // firmware behaviour under the profiles (Stage C4), full tier, needs the chip engine
registerRecoveryQuickTests(test.quick, { engine });   // recovery scenarios, corrupted flash on the shipped engine + the committed survey fixture (Component 6), quick tier
registerRecoveryFullTests(test, { engine });   // the rest of the corrupted-flash catalogue on the shipped engine (Component 6), full tier, no chip engine needed
registerRecoveryLiveTests(test.chip, { chipEngine });   // interrupted-cycle recovery scenarios on the chip-profile engine (Component 6), full tier, SKIPPED without it
registerBootAreaQuickTests(test.quick, { engine });   // the boot-area diagnostic: classifier, fixtures, read-only adapter (Component 7, Stage 7B), quick tier
registerBootAreaFullTests(test, { engine });   // all 277 intact packages, the regenerated fixture and the running divergence (Component 7), full tier, no chip engine needed
registerBootAreaLiveTests(test.chip, { chipEngine });   // interrupted sector-0 and 0xFF000 erases on the chip-profile engine (Component 7), full tier, SKIPPED without it
registerBootArea7CQuickTests(test.quick);   // the curated boot-area scenarios: catalogue, identity guard, 43 quick pure rows, committed report and summary (Component 7, Stage 7C), quick tier
registerBootArea7CFullTests(test, { engine });   // the running divergence on the shipped engine, the machine reference guard and the CLI incl. its SKIPPED output (Component 7, Stage 7C), full tier, no chip engine needed
registerBootArea7CLiveTests(test.chip, { chipEngine });   // the 13 interrupted-cycle rows and the chip divergence replayed against the committed report (Component 7, Stage 7C), full tier, SKIPPED without the chip engine
registerUnifiedQuickTests(test.quick);   // the unified engine (Component 8, Stage 2): pin, committed binary identity, notices, quick tier
registerOptimizedQuickTests(test.quick);   // the optimized unified engine (settled-loop early exit; Stage 1 of the experimental optimized mode): pin and committed binary identity, quick tier
registerUnifiedFullTests(test, { engine });   // the committed unified engine against the shipped one: display, audio, flash, USB, audio-in queue, XIP-tail switch, chip profiles; full tier, never SKIPPED
registerUnifiedAppTests(test);   // the application's chip test modes on the real engines (Component 8, Stage 2), full tier
registerUnifiedLiveTests(test.chip, { chipEngine });   // the unified engine against the pinned chip-profile engine under both profiles; full tier, SKIPPED without the chip engine
registerChipTests(test.quick);                  // flash-chip reference model (datasheet conformance, incl. fault injection), quick tier
registerFaultRegressionTests(test, { genPath: resolve(import.meta.dirname, "../engine/gen-transcripts.mjs") });   // full tier: transcripts unchanged with faults disabled

const inTier = (QUICK_ONLY ? tests.filter((t) => t.quick) : tests).filter((t) => !FILTER || t.name.includes(FILTER));
const skipped = inTier.filter((t) => t.needsChipEngine && !chipEngine);
const selected = inTier.filter((t) => !skipped.includes(t));
const tier = QUICK_ONLY ? "quick" : "full";
for (const t of skipped) console.log(`SKIP ${t.name}\n     (no chip-profile engine at ${chipEnginePath}: build it with node ci/engine/build.mjs; a skipped test is not a passed test)`);
if (!selected.length) { console.log(`FAIL: no machine tests selected (${tier} tier)`); process.exit(1); }

let failed = 0;
const started = performance.now();
for (const { name, fn } of selected) {
  const t0 = performance.now();
  try {
    await fn({ full: !QUICK_ONLY });
    console.log(`ok   ${name}  (${Math.round(performance.now() - t0)} ms)`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n     ${String(error.stack ?? error).split("\n").slice(0, 6).join("\n     ")}`);
  }
}
const seconds = ((performance.now() - started) / 1000).toFixed(1);
console.log(`\n${selected.length - failed}/${selected.length} passed${skipped.length ? `, ${skipped.length} SKIPPED (chip-profile engine not built)` : ""} (${tier} tier${QUICK_ONLY ? `, ${tests.length} tests in the full suite` : ""}, ${seconds} s) — engine ${engine.name} sha256 ${engine.wasmSha256.slice(0, 16)}…${chipEngine && !QUICK_ONLY ? ` + chip engine ${chipEngine.wasmSha256.slice(0, 16)}…` : ""}`);
if (!failed) console.log(`PASS: ${selected.length} machine tests (${tier})`);
process.exit(failed ? 1 : 0);