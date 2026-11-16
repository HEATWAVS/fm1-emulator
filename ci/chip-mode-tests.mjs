#!/usr/bin/env node
// Tests of the flash chip test modes in the application (Component 8, Stage 2): site/emulator/chipmode.js (modes, report), chipcompare.js (the headless comparison the
// page runs in a worker), and what main.js / worklet.js must keep true. The page's buttons themselves are DOM code: they were exercised in the browser pane (docs/dev/TESTING.md
// lists exactly what), not here. What IS tested here: the pure modules, the REAL engines driven through the same code the page uses, and source-shape guards for the
// rules a regression would break silently (a test mode never touches the saved patches; Default keeps the shipped engine and its message shape).
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const FULL = process.argv.includes("--full");   // also the real engines (about 30 s); without it the pure modules and the source-shape guards (about 0.2 s)
const root = resolve(import.meta.dirname, "..");
const SITE = resolve(root, "site/emulator");
const read = (f) => readFileSync(resolve(SITE, f), "utf8").replace(/\r\n/g, "\n");
let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; } catch (e) { console.error(`FAIL: ${name}\n${e.stack ?? e}`); process.exit(1); } };

// The page's helper modules are plain browser scripts (this package has no "type": "module"): imported through data: URLs, with their own imports resolved the same way.
const cache = new Map();
function loadSite(file) {
  if (cache.has(file)) return cache.get(file);
  let src = read(file);
  const deps = [...src.matchAll(/from\s+"\.\/([\w.-]+\.js)(\?v=\d+)?"/g)];
  for (const m of deps) src = src.replace(m[0], `from "${loadSite.url(m[1])}"`);
  const url = `data:text/javascript;base64,${Buffer.from(src).toString("base64")}`;
  cache.set(file, url);
  return url;
}
loadSite.url = (f) => loadSite(f);
const importSite = (f) => import(loadSite(f));
const mode = await importSite("chipmode.js");
const cmp = await importSite("chipcompare.js");

await test("modes: Default is the original engine and the only mode that saves; every test mode is on the unified engine", () => {
  assert.equal(mode.MODES[0].id, "default");
  assert.equal(mode.DEFAULT_MODE, "default");
  assert.deepEqual(mode.MODES.map((m) => [m.id, m.engine, m.chip, m.test]), [
    ["default", "shipped", null, false], ["puya", "unified", "puya", true], ["uc25hq80", "unified", "uc25hq80", true], ["original-unified", "unified", null, true]]);
  for (const m of mode.MODES) assert.ok(m.label && m.note, m.id);
  assert.ok(mode.MODES.filter((m) => m.test).every((m) => /nothing is saved/i.test(m.note)), "every test mode says nothing is saved");
});

await test("modes: ?mode= takes ids, the harness's aliases (old, new, original) and falls back to Default for anything else", () => {
  const id = (v) => mode.modeFromParam(v).id;
  assert.equal(id(null), "default"); assert.equal(id(""), "default"); assert.equal(id("nonsense"), "default");
  assert.equal(id("puya"), "puya"); assert.equal(id("OLD"), "puya"); assert.equal(id("new"), "uc25hq80"); assert.equal(id("UC25HQ80"), "uc25hq80");
  assert.equal(id("original"), "original-unified"); assert.equal(id("legacy"), "original-unified");
});

await test("engine files: Default's is the shipped engine, the test modes' the committed unified engine, both present", () => {
  assert.deepEqual(Object.keys(mode.ENGINE_FILES), ["shipped", "unified"]);
  for (const e of Object.values(mode.ENGINE_FILES)) assert.ok(existsSync(resolve(SITE, e.file)), e.file);
  assert.equal(mode.ENGINE_FILES.shipped.file, "fm1_web.wasm");
  assert.equal(mode.ENGINE_FILES.unified.file, "fm1_web_unified.wasm");
  assert.match(read("main.js"), new RegExp(`fm1_web\\.wasm\\?v=${mode.ENGINE_FILES.shipped.v}\\b`), "the page's own copy of the shipped engine is the version chipmode.js names");
});

await test("applyChipProfile: selects the profile and timing with the ids the engine takes, refuses what it does not know, does nothing for the original model", () => {
  const calls = [];
  const x = { fm1_flash_chip: (n) => { calls.push(["chip", n]); return 0; }, fm1_flash_timing: (n) => { calls.push(["timing", n]); return 0; } };
  assert.equal(mode.applyChipProfile(x, null), null);
  assert.deepEqual(calls, []);
  assert.deepEqual(mode.applyChipProfile(x, "puya", "maximum"), { chip: "puya", timing: "maximum", jedec: [0x85, 0x60, 0x14] });
  assert.deepEqual(mode.applyChipProfile(x, "uc25hq80"), { chip: "uc25hq80", timing: "typical", jedec: [0xb3, 0x60, 0x14] });
  assert.deepEqual(calls, [["chip", 1], ["timing", 1], ["chip", 2], ["timing", 0]]);
  assert.throws(() => mode.applyChipProfile(x, "w25q80"), /unknown flash chip/);
  assert.throws(() => mode.applyChipProfile(x, "puya", "fast"), /unknown flash timing/);
  assert.throws(() => mode.applyChipProfile({}, "puya"), /no flash chip profiles/);
  assert.throws(() => mode.applyChipProfile({ fm1_flash_chip: () => 1, fm1_flash_timing: () => 0 }, "puya"), /refused flash chip/);
});

const result = (o = {}) => ({ halted: false, firstFrameMs: 52, audioRms: 0, audioPeak: 0, lcdHash: "aa", lcdColours: 27, changedSectors: 0, changedList: [], wipSeen: false, unspecified: 0, notModeled: 0, lastNotModeled: 0, uidUnknownReads: 0, ...o });

await test("comparison: differences are named, the JEDEC inference is labelled as an inference and only given for the two profiles compared directly", () => {
  const ref = { label: "Default", result: result({ changedSectors: 1, changedList: [0xd6000] }) };
  const puya = { label: "Puya", result: result({ changedSectors: 1, changedList: [0xd6000], wipSeen: true }) };
  const uc = { label: "UC", result: result({ changedSectors: 0, changedList: [], notModeled: 2, lastNotModeled: 0x4b }) };
  const rows = mode.compareRuns([ref, puya, uc]);
  assert.ok(rows.some((t) => /UC vs Default: flash writes differ \(0 sector\(s\) here, 1 in the reference\)/.test(t)));
  assert.ok(rows.some((t) => /2 opcode\(s\) outside the model were issued \(last 0x4B\)/.test(t)));
  assert.ok(!rows.some((t) => /Puya vs Default/.test(t)), "identical runs report no difference");
  assert.ok(!rows.some((t) => /possible cause/.test(t)), "no JEDEC remark in the Default comparison");
  const direct = mode.comparePair(puya, uc, true).join("\n");
  assert.match(direct, /possible cause \(an inference, not verified\)/);
  assert.match(direct, /0x85 0x60 0x14 on the Puya profile and 0xB3 0x60 0x14 on the UC25HQ80 profile/);
  assert.deepEqual(mode.compareRuns([ref]), [], "one row has nothing to compare");
  assert.deepEqual(mode.compareRuns([{ label: "a", error: "x" }, ref]), [], "a row that could not run is not compared");
  assert.match(mode.comparePair({ label: "r", result: result() }, { label: "h", result: result({ halted: true }) }).join(), /the CPU halted \(crashed\) here but not in the reference/);
  assert.match(mode.comparePair({ label: "r", result: result({ audioRms: 0.1 }) }, { label: "q", result: result() }).join(), /silent here but sound in the reference/);
});

const D = { generated: "2026-11-16T00:00:00.000Z", app: { name: "FM-1 Emulator" }, firmware: { id: "quadro-fm1", name: "quadro-fm1", sha256: "ab".repeat(32) },
  mode: mode.MODES[1], timing: "typical", engine: { file: "fm1_web_unified.wasm", sha256: "58bacde6" }, run: { mhz: 100, jit: false, board: 0, status: { ms: 4200, halted: false, flashRevision: 2, wip: false, unspecified: 1, notModeled: 1, lastNotModeled: 0x4b, uidUnknownReads: 3, hasAudioIn: false, audioPending: 0, usbConfigured: true } },
  sectors: { count: 1, list: [0xd6000] }, comparison: null };

await test("report: states the mode, engine, chip, counters and flash changes, labels the profiles as reference models, and never claims hardware accuracy", () => {
  const t = mode.buildReport(D);
  for (const s of ["FM-1 EMULATOR DIAGNOSTIC REPORT", "package sha256: " + "ab".repeat(32), "[TEST MODE: nothing is saved]", "fm1_web_unified.wasm (sha256 58bacde6)", "Puya P25Q80H reference profile, JEDEC 0x85 0x60 0x14, typical cycle times",
    "emulated clock: 100 MHz; JIT: off; board: FM-1", "flash revision (counts program/erase operations accepted): 2", "unspecified (ignored by the model): 1", "opcodes outside the model: 1 (last 0x4B)", "unique-ID reads answered without a configured ID: 3",
    "flash sectors changed from the package's flash: 1 (0xD6000)", "REFERENCE models", "Neither has been confirmed to match a physical FM-1's chip", "not a hardware measurement"]) assert.ok(t.includes(s), s);
  assert.ok(!/matches (the )?(real|physical) (hardware|chip)/i.test(t.replace(/Neither has been confirmed to match a physical/g, "")), "no accuracy claim");
  assert.equal(t, mode.buildReport(D), "deterministic");
});

await test("report: Default mode says the original engine has no chip counters; a comparison is included with its differences", () => {
  const t = mode.buildReport({ ...D, mode: mode.MODES[0], engine: { file: "fm1_web.wasm", sha256: null }, run: { mhz: 100, jit: true, board: 0, status: { ms: 1000, halted: null, flashRevision: 0, wip: null, unspecified: null, notModeled: null, lastNotModeled: null, uidUnknownReads: null, hasAudioIn: null, audioPending: null, usbConfigured: null } },
    comparison: { seconds: 3, rows: [{ label: "Default", result: result() }, { label: "Broken", error: "boom" }], differences: ["something differs"] } });
  assert.ok(!t.includes("[TEST MODE"), "Default is not a test mode");
  assert.ok(t.includes("chip counters: not available (the original engine has no chip model)"));
  assert.ok(t.includes("flash chip: the original flash model of the shipped engine"));
  assert.ok(t.includes("could not run: boom") && t.includes("- something differs") && t.includes("COMPARISON (same firmware"));
});

// ---- the real engines through the code the page runs (--full)
if (FULL) {
  const { loadEngine } = await import(new URL("../ci/machine/engine.mjs", import.meta.url));
  const { Fm1Machine } = await import(new URL("../ci/machine/machine.mjs", import.meta.url));
  const { catalogPackage } = await import(new URL("../ci/machine/firmware-survey.mjs", import.meta.url));
  const shipped = await loadEngine(), unified = await loadEngine({ wasmPath: resolve(SITE, "fm1_web_unified.wasm"), name: "fm1_web_unified.wasm" });
  const compile = (path) => new WebAssembly.Module(readFileSync(path));
  const modules = { shipped: compile(resolve(SITE, "fm1_web.wasm")), unified: compile(resolve(SITE, "fm1_web_unified.wasm")) };
  const QUADRO = new Uint8Array(catalogPackage("quadro-fm1"));

  const runs = {};
  await test("the page's comparison code on the real engines: quadro-fm1 saves its settings on the original model and on Puya, not on UC25HQ80 (the Component 4 finding), with WIP seen only under a profile", async () => {
    runs.shipped = await cmp.runConfig({ module: modules.shipped, pkg: QUADRO, seconds: 4 });
    runs.original = await cmp.runConfig({ module: modules.unified, pkg: QUADRO, seconds: 4 });
    runs.puya = await cmp.runConfig({ module: modules.unified, pkg: QUADRO, chip: "puya", seconds: 4 });
    runs.uc = await cmp.runConfig({ module: modules.unified, pkg: QUADRO, chip: "uc25hq80", seconds: 4 });
    assert.deepEqual(runs.shipped.changedList, [0xd6000]);
    assert.deepEqual(runs.puya.changedList, [0xd6000]);
    assert.deepEqual(runs.uc.changedList, []);
    assert.equal(runs.puya.wipSeen, true); assert.equal(runs.uc.wipSeen, false);
    assert.deepEqual(runs.puya.chip, { chip: "puya", timing: "typical", jedec: [0x85, 0x60, 0x14] });
    assert.equal(runs.shipped.chip, null);
    for (const r of Object.values(runs)) assert.equal(r.halted, false);
  });

  await test("the original flash model on the unified engine reproduces the shipped engine's run (display, audio, flash, clock): the baseline the chip profiles are compared with", () => {
    const keys = ["lcdHash", "lcdColours", "audioRms", "audioPeak", "changedList", "emulatedMs", "firstFrameMs", "halted", "flashRevision"];
    for (const k of keys) assert.deepEqual(runs.original[k], runs.shipped[k], k);
  });

  await test("the page's comparison agrees with the headless harness (ci/machine) on which flash sectors a run changed, per configuration", () => {
    for (const [name, options, want] of [["puya", { flashChip: "puya" }, runs.puya], ["uc25hq80", { flashChip: "uc25hq80" }, runs.uc]]) {
      const m = Fm1Machine.boot(unified, QUADRO, { usb: true, ...options });
      m.run(4000);
      assert.deepEqual(m.changedSectors().map((s) => s.at), want.changedList, name);
      assert.equal(m.observe().lcdHash.slice(0, 8) !== undefined, true);
    }
  });

  await test("runComparison: three rows in a fixed order, the differences between the profiles, and a row that cannot run is reported not skipped", async () => {
    const c = await cmp.runComparison({ engines: modules, pkg: QUADRO, seconds: 4 });
    assert.deepEqual(c.rows.map((r) => r.label), ["Default (original engine)", "Older FM-1 flash: Puya P25Q80H profile", "Newer FM-1 flash: UC25HQ80 profile"]);
    assert.ok(c.rows.every((r) => r.result), "all three ran");
    assert.ok(c.differences.some((t) => /UC25HQ80 profile vs Older FM-1 flash: Puya P25Q80H profile: flash writes differ \(0 sector\(s\) here, 1 in the reference\)/.test(t)));
    assert.ok(c.differences.some((t) => /possible cause \(an inference, not verified\)/.test(t)));
    const bad = await cmp.runComparison({ engines: { shipped: modules.shipped, unified: modules.shipped }, pkg: QUADRO, seconds: 1 });
    assert.equal(bad.rows[0].result.halted, false);
    assert.match(bad.rows[1].error, /no flash chip profiles/, "the shipped engine cannot take a chip profile: said, not silently run as the original model");
    assert.equal(bad.rows[1].result, undefined);
    await assert.rejects(cmp.runConfig({ module: modules.unified, pkg: new Uint8Array(64), seconds: 1 }), /not an FM-1 update package/);
    const pure = mode.buildReport({ ...D, comparison: c });
    assert.ok(pure.includes("[Newer FM-1 flash: UC25HQ80 profile]") && pure.includes("flash: 0 sector(s) changed"));
  });
}

// ---- source-shape guards (these cannot prove behaviour; they fail if the rules are edited away)
const main = read("main.js"), worklet = read("worklet.js");
await test("main.js: a test session returns from saveSnapshot before anything touches memory records or storage, and boots from a clean flash", () => {
  const body = main.slice(main.indexOf("function saveSnapshot("), main.indexOf("async function flushRunning("));
  const guard = body.indexOf("if (session.ephemeral)");
  assert.ok(guard > 0, "the guard exists");
  for (const forbidden of ["memoryRecords.set", "saveStore.save", "saveStore.remember", "session.record ="]) assert.ok(body.indexOf(forbidden) > guard, `${forbidden} comes after the guard`);
  assert.match(main, /const sectors = ephemeral \? \[\] : record\?\.sectors \|\| \[\];/, "a test mode never reads the saved sectors");
  assert.match(main, /forceSave: !ephemeral && /, "a test session never forces a save");
  assert.match(main, /engine\.postMessage\(\{ type: "boot", seq, wasm: bytesForEngine\.slice\(0\), engineId: mode\.engine, chip: mode\.chip, chipTiming,/);
});

await test("main.js and worklet.js: Default keeps the shipped engine (the page's own bytes), the drawing instance stays the shipped engine, and the chip is applied after the flash restore and the USB host", () => {
  assert.match(main, /const engineBytes = \{ shipped: wasm \};/);
  assert.match(main, /const ui = \(await WebAssembly\.instantiate\(wasm,/, "the panel is drawn by the shipped engine's own instance in every mode");
  const boot = worklet.slice(worklet.indexOf("async boot(m, token)"), worklet.indexOf("observeFlash()"));
  const order = ["fm1_boot_fwsc", "fm1_flash_restore", "fm1_usb_plug", "applyChipProfile", "this.x = x"].map((s) => boot.indexOf(s));
  assert.ok(order.every((i) => i > 0) && order.every((v, i) => !i || v > order[i - 1]), `boot order: ${order}`);
  assert.match(boot, /const engineId = m\.engineId \|\| "shipped";/, "a boot message without an engine id (an older caller) is the shipped engine");
  assert.match(boot, /flash chip test modes are for the FM-1 board/);
  assert.match(worklet, /m\.type === "chip-status"/);
  const html = read("index.html");
  for (const id of ["chipmode", "chiptiming", "chip-copy", "chip-compare", "chip-status", "chip-report"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /Not confirmed to match a physical FM-1's chip/);
  assert.match(html, />Copy report</, "the button is a general-purpose \"Copy report\"");
});

console.log(`PASS: ${passed} chip mode tests${FULL ? " (full)" : ""}`);
