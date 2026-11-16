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

const result = (o = {}) => ({ audioFrames: 87000, audioRequested: 88320, audioStarted: true, halted: false, firstFrameMs: 52, audioRms: 0, audioPeak: 0, lcdHash: "aa", lcdColours: 27, changedSectors: 0, changedList: [], wipSeen: false, unspecified: 0, notModeled: 0, lastNotModeled: 0, uidUnknownReads: 0, ...o });

await test("comparison, scoped: [engine] pairs Default with the original flash model on the unified engine, [chip] pairs each profile with that same-engine row, a profile is never compared with Default, and the audio-engine start is its own statement", () => {
  const def = { label: "Default", result: result({ changedSectors: 1, changedList: [0xd6000], audioStarted: false, audioFrames: 0 }) };
  const orig = { label: "Original", result: result({ changedSectors: 1, changedList: [0xd6000] }) };
  const puya = { label: "Puya", result: result({ changedSectors: 1, changedList: [0xd6000], wipSeen: true }) };
  const uc = { label: "UC", result: result({ changedSectors: 0, changedList: [], notModeled: 2, lastNotModeled: 0x4b }) };
  const rows = mode.compareScoped({ def, original: orig, puya, uc });
  assert.ok(rows.includes("[engine] Original vs Default: the audio engine started here but not in the reference (an engine difference: the flash model is the same in both)"), rows.join("\n"));
  assert.ok(rows.some((s) => /^\[chip\] UC vs Original: flash writes differ \(0 sector\(s\) here, 1 in the reference\)/.test(s)));
  assert.ok(rows.some((s) => /^\[chip\] UC: 2 opcode\(s\) outside the model were issued \(last 0x4B\)/.test(s)));
  assert.ok(rows.some((s) => /^\[chip\] UC vs Puya: possible cause \(an inference, not verified\)/.test(s)), "the JEDEC remark is for the two profiles compared directly");
  assert.ok(!rows.some((s) => /vs Default/.test(s) && !s.startsWith("[engine]")), "a profile is never compared with Default (the pair differs in engine and chip)");
  assert.ok(!rows.some((s) => /^\[chip\].*audio engine/.test(s)), "both profiles started the audio engine as the same-engine reference did: no chip audio claim");
  assert.ok(!rows.some((s) => /audio engine/.test(s) && /flash writes/.test(s)), "the audio-engine statement is separate from the flash statement");
  // a chip is named for an audio-start difference only when the same-engine pair shows it
  const ucNoAudio = { label: "UC", result: result({ audioStarted: false, audioFrames: 0 }) };
  assert.ok(mode.compareScoped({ def: orig, original: orig, puya, uc: ucNoAudio }).includes("[chip] UC vs Original: the audio engine started in the reference but not here (same engine, only the flash model differs)"));
  assert.deepEqual(mode.compareScoped({ def, original: { label: "Original", error: "x" }, puya: { label: "Puya", error: "x" }, uc: { label: "UC", error: "x" } }), [], "rows that could not run are not compared");
  assert.deepEqual(mode.compareScoped({ def: orig, original: orig, puya: orig, uc: orig }), [], "identical runs report no difference");
  assert.match(mode.comparePair({ label: "r", result: result() }, { label: "h", result: result({ halted: true }) }).join(), /the CPU halted \(crashed\) here but not in the reference/);
  assert.match(mode.comparePair({ label: "r", result: result({ audioRms: 0.1 }) }, { label: "q", result: result() }).join(), /silent here but sound in the reference/);
  const direct = mode.comparePair(puya, uc, true, "chip").join("\n");
  assert.match(direct, /0x85 0x60 0x14 on the Puya profile and 0xB3 0x60 0x14 on the UC25HQ80 profile/);
});

const D = { generated: "2026-11-16T00:00:00.000Z", app: { name: "FM-1 Emulator" }, firmware: { id: "quadro-fm1", name: "quadro-fm1", sha256: "ab".repeat(32) },
  mode: mode.MODES[1], timing: "typical", engine: { file: "fm1_web_unified.wasm", sha256: "ba1ba889" }, run: { mhz: 100, jit: false, board: 0, status: { ms: 4200, halted: false, flashRevision: 2, wip: false, unspecified: 1, notModeled: 1, lastNotModeled: 0x4b, uidUnknownReads: 3, hasAudioIn: false, audioPending: 0, usbConfigured: true } },
  sectors: { count: 1, list: [0xd6000] }, comparison: null };

await test("report: states the mode, engine, chip, counters and flash changes, labels the profiles as reference models, and never claims hardware accuracy", () => {
  const t = mode.buildReport(D);
  for (const s of ["FM-1 EMULATOR DIAGNOSTIC REPORT", "package sha256: " + "ab".repeat(32), "[TEST MODE: nothing is saved]", "fm1_web_unified.wasm (sha256 ba1ba889)", "audio clock: this engine starts the audio clock (PLL0) the way the upstream emulator sets it after a bootloader; the Default engine does not.", "have NOT been verified on a physical FM-1", "Puya P25Q80H reference profile, JEDEC 0x85 0x60 0x14, typical cycle times",
    "emulated clock: 100 MHz; JIT: off; board: FM-1", "flash revision (counts program/erase operations accepted): 2", "unspecified (ignored by the model): 1", "opcodes outside the model: 1 (last 0x4B)", "unique-ID reads answered without a configured ID: 3",
    "flash sectors changed from the package's flash: 1 (0xD6000)", "REFERENCE models", "Neither has been confirmed to match a physical FM-1's chip", "not a hardware measurement"]) assert.ok(t.includes(s), s);
  assert.ok(!/matches (the )?(real|physical) (hardware|chip)/i.test(t.replace(/Neither has been confirmed to match a physical/g, "")), "no accuracy claim");
  assert.ok(!t.includes("d2bcc33") && !t.includes("upstream fm1-emu") && !t.includes("firmware note:"), "plain wording, and no firmware-specific note without a matching hash");
  assert.equal(t, mode.buildReport(D), "deterministic");
});

await test("report: Default mode says the original engine has no chip counters; a comparison is included with its differences", () => {
  const t = mode.buildReport({ ...D, mode: mode.MODES[0], engine: { file: "fm1_web.wasm", sha256: null }, run: { mhz: 100, jit: true, board: 0, status: { ms: 1000, halted: null, flashRevision: 0, wip: null, unspecified: null, notModeled: null, lastNotModeled: null, uidUnknownReads: null, hasAudioIn: null, audioPending: null, usbConfigured: null } },
    comparison: { seconds: 3, rows: [{ label: "Default", result: result() }, { label: "Broken", error: "boom" }], differences: ["something differs"] } });
  assert.ok(!t.includes("[TEST MODE"), "Default is not a test mode");
  assert.ok(!t.includes("audio clock: this engine starts"), "Default runs the shipped engine, which has no PLL0 boot state");
  assert.ok(t.includes("chip counters: not available (the original engine has no chip model)"));
  assert.ok(t.includes("flash chip: the original flash model of the shipped engine"));
  assert.ok(t.includes("could not run: boom") && t.includes("- something differs") && t.includes("COMPARISON (same firmware"));
});

const PLL0 = JSON.parse(read("pll0-firmware.json"));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const FIFTEEN = ["amb", "amenity", "assid", "atek303", "choppah", "ctl", "fm1-ripple", "fmfam", "krisjangle", "loom", "midimon", "mutable", "polly", "remotefm1", "sidou"];

await test("PLL0 list: exactly the 15 audited packages, each pinned by the SHA-256 of its package file and of the catalogue, tied to the unified engine it was measured on", () => {
  assert.deepEqual(PLL0.entries.map((e) => e.id), FIFTEEN, "the 15 of the Stage 4 comparison, sorted");
  const catalogue = JSON.parse(read("firmwares.json")).firmwares;
  assert.equal(PLL0.packagesAudited, catalogue.filter((e) => e.package).length, "the audit covered every bundled package");
  assert.equal(new Set(PLL0.entries.map((e) => e.sha256)).size, 15);
  for (const e of PLL0.entries) {
    assert.match(e.sha256, /^[0-9a-f]{64}$/, e.id);
    const c = catalogue.find((x) => x.id === e.id);
    assert.equal(c.sha256, e.sha256, `${e.id}: the catalogue's hash`);
    assert.equal(sha256(readFileSync(resolve(SITE, c.package))), e.sha256, `${e.id}: the package file's hash`);
    assert.equal(e.shippedRealFrames, 0, `${e.id}: no real audio frames on the shipped engine`);
    assert.ok(e.unifiedRealFrames > PLL0.requestedFrames * 0.9, `${e.id}: the unified engine delivered audio frames`);
    assert.ok(e.name && typeof e.version === "string", e.id);
  }
  assert.equal(PLL0.unifiedEngineSha256, sha256(readFileSync(resolve(SITE, "fm1_web_unified.wasm"))), "the list was measured on the committed unified engine: a rebuilt engine needs node ci/pll0-audit.mjs --check (or --write, reviewed)");
});

await test("PLL0 matching is by package SHA-256 only: the same id with another hash, or another id with the hash, behave by the hash; malformed input never matches", () => {
  const ctl = PLL0.entries.find((e) => e.id === "ctl");
  assert.equal(mode.pll0Entry(ctl.sha256, PLL0).id, "ctl");
  assert.equal(mode.pll0Entry("0".repeat(64), PLL0), null, "an unknown hash (another version of CTL-1, say) does not match");
  assert.equal(mode.pll0Entry(ctl.sha256.toUpperCase(), PLL0), null, "hashes are lower-case hex");
  for (const bad of [null, undefined, "", "ctl", 42, ctl.sha256.slice(1)]) assert.equal(mode.pll0Entry(bad, PLL0), null, String(bad));
  assert.equal(mode.pll0Entry(ctl.sha256, null), null); assert.equal(mode.pll0Entry(ctl.sha256, {}), null);
  const renamed = { entries: [{ ...ctl, id: "something-else", name: "Other" }] };
  assert.equal(mode.pll0Entry(ctl.sha256, renamed).name, "Other", "the id is not what is looked at");
  assert.ok(!/\.id\b/.test(read("chipmode.js").slice(read("chipmode.js").indexOf("export function pll0Entry"), read("chipmode.js").indexOf("export const PLL0_PANEL_NOTICE"))), "pll0Entry never reads an id");
});

await test("panel notice: only in a test mode and only for a listed hash; plain wording that promises no sound and states the unverified hardware caveat", () => {
  const entry = PLL0.entries[0], N = mode.PLL0_PANEL_NOTICE;
  for (const m of mode.MODES) {
    assert.equal(mode.panelNotice({ mode: m, entry }), m.test ? N : null, `${m.id} with a listed package`);
    assert.equal(mode.panelNotice({ mode: m, entry: null }), null, `${m.id} with an unlisted package`);
  }
  assert.equal(mode.panelNotice({ mode: null, entry }), null);
  for (const s of ["may start its audio", "on Default it stays silent", "the audio clock (PLL0) differently", "may still make no sound until it is played", "not every firmware does", "have not been verified on a physical FM-1", "Original flash model on the unified engine"]) assert.ok(N.includes(s), s);
  assert.ok(!/will (produce|make|play|start)|always|guaranteed|every (affected|listed)/i.test(N), "no promise of sound");
  assert.ok(N.length < 700, "short enough to read in the panel");
});

await test("report wording: plain explanation for every unified-engine mode, the firmware note only for a matching package, the hardware caveat in both, no claim that the chip caused a difference", () => {
  const entry = PLL0.entries.find((e) => e.id === "ctl");
  const withNote = mode.buildReport({ ...D, pll0: entry }), plain = mode.buildReport({ ...D, pll0: null }), def = mode.buildReport({ ...D, mode: mode.MODES[0], engine: { file: "fm1_web.wasm", sha256: null }, pll0: entry });
  assert.ok(withNote.includes(mode.PLL0_ENGINE_LINE) && plain.includes(mode.PLL0_ENGINE_LINE), "the engine explanation is in every unified-engine report");
  assert.ok(!def.includes(mode.PLL0_ENGINE_LINE), "Default runs the shipped engine: no engine explanation");
  assert.ok(withNote.includes(mode.pll0FirmwareNote(entry)) && def.includes(mode.pll0FirmwareNote(entry)), "the firmware note is in any mode for a matching package");
  assert.ok(!plain.includes("firmware note:"), "and only for a matching package");
  for (const s of ["CTL-1 1.0.3 is one of the bundled firmware whose audio engine starts on the unified engine and does not start on Default", "That says nothing about whether it is audible", "not only from the flash chip", "have not been verified on a physical FM-1"]) assert.ok(withNote.includes(s), s);
  assert.ok(mode.PLL0_ENGINE_LINE.includes("NOT been verified on a physical FM-1"));
  for (const text of [withNote, def]) assert.ok(!/d2bcc33|upstream fm1-emu/.test(text), "no commit ids or project jargon");
});

await test("comparison text: describeRun separates the audio engine's start from audible output and from flash, and the report explains the scopes", () => {
  const lines = mode.describeRun(result({ audioStarted: false, audioFrames: 0, audioRequested: 176400, changedSectors: 2, changedList: [0xde000, 0xdf000] }));
  const at = (re) => lines.findIndex((l) => re.test(l));
  assert.ok(lines.includes("audio engine: did NOT start (0 real audio frames of 176400 rendered)"));
  assert.ok(at(/^audio engine:/) >= 0 && at(/^audible output:/) > at(/^audio engine:/) && at(/^flash:/) > at(/^audible output:/), "three separate statements, in that order");
  assert.ok(mode.describeRun(result()).includes("audio engine: started (87000 real audio frames of 88320 rendered)"));
  assert.ok(!mode.describeRun(result({ audioStarted: undefined })).some((l) => /^audio engine:/.test(l)), "no invented value when a row has none");
  const t = mode.buildReport({ ...D, comparison: { seconds: 3, rows: [{ label: "Default (original engine)", result: result() }], differences: [] } });
  for (const s of ["Rows 1 and 2 differ only in the engine; rows 2 to 4 run the same engine and differ only in the flash model.", "[engine] lines are differences between the two engines (the audio-clock setup included);", "This separates engine behaviour from flash-chip behaviour; it says nothing about how a physical FM-1 behaves."]) assert.ok(t.includes(s), s);
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

  await test("runComparison on the real engines: four rows in a fixed order; an unaffected package (quadro-fm1) shows the chip effect only, an affected one (CTL-1) the engine effect only", async () => {
    const LABELS = ["Default (original engine)", "Original flash model on the unified engine", "Older FM-1 flash: Puya P25Q80H profile", "Newer FM-1 flash: UC25HQ80 profile"];
    const c = await cmp.runComparison({ engines: modules, pkg: QUADRO, seconds: 4 });
    assert.deepEqual(c.rows.map((r) => r.label), LABELS);
    assert.ok(c.rows.every((r) => r.result), "all four ran");
    assert.ok(c.rows.every((r) => r.result.audioStarted === true && r.result.audioFrames > 0), "quadro-fm1 starts its audio engine in every row (measured the same way in all four)");
    assert.ok(!c.differences.some((s) => s.startsWith("[engine]")), "Default and the original flash model on the unified engine do not differ for quadro-fm1: " + c.differences.join(" | "));
    assert.ok(c.differences.some((s) => /^\[chip\] Newer FM-1 flash: UC25HQ80 profile vs Original flash model on the unified engine: flash writes differ \(0 sector\(s\) here, 1 in the reference\)/.test(s)), c.differences.join(" | "));
    assert.ok(c.differences.some((s) => /^\[chip\] Newer FM-1 flash: UC25HQ80 profile vs Older FM-1 flash: Puya P25Q80H profile: possible cause \(an inference, not verified\)/.test(s)));
    assert.ok(!c.differences.some((s) => /audio engine/.test(s)), "no audio-engine difference to report");
    // an affected package: the audio engine starts on the unified rows only, and that is attributed to the engine, not to a chip
    const CTL = new Uint8Array(catalogPackage("ctl")), ctl = await cmp.runComparison({ engines: modules, pkg: CTL, seconds: 3 });
    assert.deepEqual(ctl.rows.map((r) => r.result.audioStarted), [false, true, true, true], "CTL-1: not on Default, on all three unified rows");
    assert.equal(ctl.rows[0].result.audioFrames, 0);
    assert.ok(ctl.differences.includes("[engine] Original flash model on the unified engine vs Default (original engine): the audio engine started here but not in the reference (an engine difference: the flash model is the same in both)"), ctl.differences.join(" | "));
    assert.ok(!ctl.differences.some((s) => s.startsWith("[chip]") && /audio engine/.test(s)), "no chip is named for the audio difference");
    assert.ok(mode.pll0Entry(sha256(CTL), PLL0) && !mode.pll0Entry(sha256(QUADRO), PLL0), "CTL-1's package is on the PLL0 list, quadro-fm1's is not");
    const bad = await cmp.runComparison({ engines: { shipped: modules.shipped, unified: modules.shipped }, pkg: QUADRO, seconds: 1 });
    assert.equal(bad.rows[0].result.halted, false);
    assert.ok(bad.rows[1].result && bad.rows[0].result, "the two original-model rows run");
    assert.ok(bad.rows.slice(2).every((r) => /no flash chip profiles/.test(r.error)), "the shipped engine cannot take a chip profile: said, not silently run as the original model");
    await assert.rejects(cmp.runConfig({ module: modules.unified, pkg: new Uint8Array(64), seconds: 1 }), /not an FM-1 update package/);
    const text = mode.buildReport({ ...D, comparison: c });
    assert.ok(text.includes("[Newer FM-1 flash: UC25HQ80 profile]") && text.includes("flash: 0 sector(s) changed") && text.includes("audio engine: started"));
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
  for (const id of ["chipmode", "chiptiming", "chip-copy", "chip-compare", "chip-status", "chip-report", "chip-notice"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /<p id="chip-notice"[^>]*\bhidden\b/, "the PLL0 notice starts hidden");
  const test = read("chiptest.js");
  assert.match(test, /panelNotice\(\{ mode, entry: pll0Entry\(hashOfLoaded\(\), pll0\) \}\)/, "the notice is decided by the package hash and the mode");
  assert.match(test, /pll0: pll0Entry\(hashOfLoaded\(\), pll0\),/, "so is the report's firmware note");
  assert.ok(!/pll0\.entries|\.entries\.find|fw\??\.id ===? ?["']/.test(test), "no id or name classification in the page code");
  assert.match(html, /Not confirmed to match a physical FM-1's chip/);
  assert.match(html, />Copy report</, "the button is a general-purpose \"Copy report\"");
});

console.log(`PASS: ${passed} chip mode tests${FULL ? " (full)" : ""}`);
