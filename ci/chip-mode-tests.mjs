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

await test("modes: Default is the normal emulator (the optimized unified engine with the CPU optimization, and the only mode that saves); the test modes are the unified engine (chip profiles, the baseline) and the previous shipped engine as a reference; no experimental mode remains", () => {
  assert.equal(mode.MODES[0].id, "default");
  assert.equal(mode.DEFAULT_MODE, "default");
  assert.deepEqual(mode.MODES.map((m) => [m.id, m.engine, m.chip, m.test]), [
    ["default", "optimized", null, false], ["puya", "optimized", "puya", true], ["uc25hq80", "optimized", "uc25hq80", true], ["original-unified", "unified", null, true], ["previous-engine", "shipped", null, true]]);
  for (const m of mode.MODES) assert.ok(m.label && m.note, m.id);
  assert.ok(mode.MODES.filter((m) => m.test).every((m) => /nothing is saved/i.test(m.note)), "every test mode says nothing is saved");
  assert.deepEqual(mode.MODES.filter((m) => m.settledLoop).map((m) => m.id), ["default", "puya", "uc25hq80"], "Default and the two chip modes ask for the CPU optimization (validated on all 277 packages under both chip models)");
  assert.ok(mode.MODES.every((m) => !m.experimental && !/experimental|adaptive/i.test(m.label + m.note)), "no experimental or adaptive mode is offered");
  assert.ok(!mode.modeById("adaptive-cpu"), "the temporary validation mode is gone");
});

await test("modes: the select offers Default and the two chips only; the two reference modes are hidden but stay test modes, reachable by ?mode= and used by Compare chips", () => {
  assert.deepEqual(mode.visibleModes().map((m) => m.id), ["default", "puya", "uc25hq80"]);
  assert.deepEqual(mode.MODES.filter((m) => m.hidden).map((m) => m.id), ["original-unified", "previous-engine"]);
  assert.ok(mode.MODES.filter((m) => m.hidden).every((m) => m.test && /nothing is saved/i.test(m.note)), "a hidden mode is still a test mode that saves nothing");
  assert.ok(mode.visibleModes().every((m) => !m.hidden));
  assert.equal(mode.modeFromParam("previous").id, "previous-engine"); assert.equal(mode.modeFromParam("original").id, "original-unified");
  const chiptestSrc = read("chiptest.js");
  assert.match(chiptestSrc, /for \(const m of MODES\) if \(!m\.hidden \|\| m === mode\) sel\.add\(/, "the select lists the visible modes, plus a hidden one only while it is the one running");
  assert.match(chiptestSrc, /modeById\("previous-engine"\)/, "Compare chips still takes the previous engine's bytes");
});

await test("modes: ?mode= takes ids, the harness's aliases (old, new, original, previous) and falls back to Default for anything else, the removed experimental names included", () => {
  const id = (v) => mode.modeFromParam(v).id;
  assert.equal(id(null), "default"); assert.equal(id(""), "default"); assert.equal(id("nonsense"), "default");
  assert.equal(id("puya"), "puya"); assert.equal(id("OLD"), "puya"); assert.equal(id("new"), "uc25hq80"); assert.equal(id("UC25HQ80"), "uc25hq80");
  assert.equal(id("original"), "original-unified"); assert.equal(id("legacy"), "original-unified");
  assert.equal(id("previous"), "previous-engine"); assert.equal(id("shipped"), "previous-engine"); assert.equal(id("previous-engine"), "previous-engine");
  for (const v of ["adaptive-cpu", "adaptive", "optimized"]) assert.equal(id(v), "default", `${v}: the validation mode's names are not special any more`);
});

await test("engine files: Default's is the optimized unified engine, the unified engine and the shipped engine (panel drawing, reference mode) are kept, all present", () => {
  assert.deepEqual(Object.keys(mode.ENGINE_FILES), ["shipped", "unified", "optimized"]);
  for (const e of Object.values(mode.ENGINE_FILES)) assert.ok(existsSync(resolve(SITE, e.file)), e.file);
  assert.equal(mode.ENGINE_FILES.shipped.file, "fm1_web.wasm");
  assert.equal(mode.ENGINE_FILES.unified.file, "fm1_web_unified.wasm");
  assert.equal(mode.ENGINE_FILES.optimized.file, "fm1_web_frodhes_optimized.wasm");
  assert.equal(mode.ENGINE_FILES[mode.modeById("default").engine].file, "fm1_web_frodhes_optimized.wasm", "Default runs the optimized unified engine");
  assert.match(read("main.js"), new RegExp(`fm1_web\\.wasm\\?v=${mode.ENGINE_FILES.shipped.v}\\b`), "the page's own copy of the shipped engine (it draws the panel) is the version chipmode.js names");
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

const D = { generated: "2026-11-16T00:00:00.000Z", firmware: { id: "quadro-fm1", name: "quadro-fm1", sha256: "ab".repeat(32) }, comparison: null };

await test("report: only the firmware under test and its comparison (name, id, hash, the verdict and the two chip rows); the profiles are reference models and nothing claims hardware accuracy; no live session, mode, engine, app, audio-clock or counter detail", () => {
  const cmp = { seconds: 3, timing: "typical", rows: [{ label: "Older chip", chip: "puya", result: result({ changedSectors: 1, changedList: [0xd6000] }) }, { label: "Newer chip", chip: "uc25hq80", result: result() }], differences: [], chipDifferences: [] };
  const t = mode.buildReport({ ...D, comparison: cmp });
  for (const s of ["FM-1 EMULATOR FLASH CHIP REPORT", "name: quadro-fm1", "id: quadro-fm1", "package sha256: " + "ab".repeat(32), "COMPARISON (same firmware, same inputs, nothing pressed, 3 s of emulated time each, typical cycle times)",
    "flash writes: 1 sector(s) written (0xD6000)", "REFERENCE models", "Neither has been confirmed to match a physical FM-1's chip", "not a hardware measurement"]) assert.ok(t.includes(s), s);
  for (const s of ["TEST SETUP", "THIS SESSION", "mode:", "[TEST MODE", "emulated time:", "flash writes in this session", "fm1_web", "application:", "PLL0", "audio clock", "XIP", "CPU optimization", "emulated clock", "JIT", "flash revision", "unspecified", "outside the model", "unique-ID", "settled-loop", "USB audio", "firmware note", "POSSIBLE reasons"]) assert.ok(!t.includes(s), "not in the report: " + s);
  assert.ok(!/matches (the )?(real|physical) (hardware|chip)/i.test(t.replace(/Neither has been confirmed to match a physical/g, "")), "no accuracy claim");
  assert.equal(t, mode.buildReport({ ...D, comparison: cmp }), "deterministic");
});

await test("report: a comparison lists only the two chip rows (a row that could not run says so) and the differences between the two chips; the engine control rows and engine lines are not in it", () => {
  const t = mode.buildReport({ ...D, comparison: { seconds: 3, timing: "typical", rows: [{ label: "Previous engine", chip: null, result: result() }, { label: "Original", chip: null, result: result() }, { label: "Older chip", chip: "puya", result: result() }, { label: "Newer chip", chip: "uc25hq80", error: "boom" }],
    differences: ["[engine] Original vs Previous engine: the audio engine started here but not in the reference"], chipDifferences: ["[chip] Newer chip vs Older chip: flash writes differ (0 sector(s) here, 1 in the reference)"] } });
  assert.ok(t.includes("COMPARISON (same firmware, same inputs, nothing pressed, 3 s of emulated time each, typical cycle times)"));
  assert.ok(t.includes("[Older chip]") && t.includes("[Newer chip]") && t.includes("could not run: boom"));
  for (const s of ["[Previous engine]", "[Original]", "[engine]", "Rows 1 and 2 differ only in the engine"]) assert.ok(!t.includes(s), "not in the report: " + s);
  assert.ok(t.includes("differences between the two chips:") && t.includes("- [chip] Newer chip vs Older chip: flash writes differ (0 sector(s) here, 1 in the reference)"));
  assert.ok(mode.buildReport({ ...D, comparison: { seconds: 3, rows: [], differences: [] } }).includes("- none seen in what was compared"));
});

await test("report: it is the comparison's alone, so it does not depend on the mode the page is running or on a live session, and it says nothing of the CPU optimization", () => {
  const cmp = { seconds: 3, timing: "typical", rows: [{ label: "Older chip", chip: "puya", result: result() }, { label: "Newer chip", chip: "uc25hq80", result: result() }], differences: [], chipDifferences: [] };
  const a = mode.buildReport({ ...D, comparison: cmp, mode: mode.modeById("default") }), b = mode.buildReport({ ...D, comparison: cmp, mode: mode.modeById("puya"), run: { status: { ms: 1, halted: true } }, sectors: { count: 9, list: [1] } });
  assert.equal(a, b, "a live mode, status or sector list changes nothing in it");
  assert.ok(!a.includes("experimental") && !a.includes("CPU optimization"));
});

await test("report area: on the page from the start, Copy report starts off, every Compare and report message goes to the report's own status line, the mode status only says a mode restarted, and the verdict colours follow the renamed states", () => {
  const html = read("index.html"), chiptest = read("chiptest.js"), css = read("style.css");
  assert.match(html, /<button type="button" id="chip-copy"[^>]*\bdisabled\b/, "Copy report starts off: there is nothing to copy before a comparison");
  assert.match(html, /<details id="chip-report-wrap" open>/, "the report area is on the page from the start");
  assert.ok(!/id="chip-report-wrap"[^>]*\bhidden\b/.test(html), "and is not hidden");
  assert.ok(html.indexOf('id="chip-compare"') < html.indexOf('id="chip-copy"') && html.indexOf('id="chip-copy"') < html.indexOf('id="chip-report-wrap"'), "Compare, then Copy report, then the report");
  assert.ok(html.slice(html.indexOf('id="chip-compare"'), html.indexOf('id="chip-copy"')).includes("</div>"), "Compare both chips has its own row; Copy report is in a row of its own");
  assert.ok(html.indexOf('id="chip-verdict"') > html.indexOf('id="chip-compare"') && html.indexOf('id="chip-verdict"') < html.indexOf('id="chip-copy"'), "the verdict card is under Compare and above Copy report");
  assert.ok(html.indexOf('id="chip-copy"') < html.indexOf('id="chip-report-wrap"') && !html.slice(html.indexOf('id="chip-report-wrap"')).split("</details>")[0].includes('id="chip-copy"'), "Copy report sits above the Report fold and outside it, so it does not fold with the results");
  assert.ok(html.indexOf('id="chip-cmp-status"') > html.indexOf('id="chip-report-wrap"') && html.indexOf('id="chip-cmp-status"') < html.indexOf('id="chip-report"'), "the Compare status line is inside the report area, above the text");
  assert.match(html, /<pre id="chip-report" tabindex="0">The report appears here after you compare the chips\.<\/pre>/, "an empty report says what it is for");
  assert.ok(html.indexOf('id="chip-status"') < html.indexOf('id="chip-compare"'), "the mode status stays under the chip buttons");
  const cmp = chiptest.slice(chiptest.indexOf("// The report area is always"));
  assert.ok(cmp.length > 1500 && !/\bsetStatus\(/.test(cmp), "nothing about Compare or the report goes to the mode status");
  assert.match(cmp, /copyBtn\.addEventListener\("click", async \(\) => \{\n    if \(!comparison\) return;/, "Copy report does nothing without a comparison");
  assert.match(cmp, /copyBtn\.disabled = false;/); assert.match(cmp, /\$\("chip-report-wrap"\)\?\.scrollIntoView\(\{ block: "nearest" \}\);/, "starting a comparison brings the report area (and its progress line) into view"); assert.match(cmp, /comparison = null; renderVerdict\(null\); clearReport\(\);/, "a new comparison starts from an empty report");
  assert.ok(!/askStatus|changedSectorList|ctx\.flush/.test(chiptest), "the report no longer reads the live session");
  assert.match(css, /\.chip-box #chip-cmp-status \{/);
  assert.match(css, /\[data-state="wrote"\]/); assert.match(css, /\[data-state="no-write"\]/); assert.ok(!/data-state="(saved|not-saved)"/.test(css), "the verdict row colours follow the renamed states");
});

await test("desktop window: opens maximized, keeping its bounds for restoring", () => {
  const m = readFileSync(resolve(root, "main.js"), "utf8").replace(/\r\n/g, "\n");
  const create = m.slice(m.indexOf("function createWindow() {"));
  assert.ok(create.indexOf("new BrowserWindow(") > 0 && create.indexOf("win.maximize();") > create.indexOf("new BrowserWindow("), "maximized right after the window is created");
  assert.ok(create.indexOf("win.maximize();") < create.indexOf("let recovering = false;"), "before anything else is set up");
  assert.match(m, /\.\.\.windowBounds\(\),/, "the bounds are still given, for restoring");
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

await test("panel notice: only in the previous-engine test mode (the one that leaves the audio clock at zero) and only for a listed hash; plain wording that promises no sound and states the unverified hardware caveat", () => {
  const entry = PLL0.entries[0], N = mode.PLL0_PANEL_NOTICE;
  for (const m of mode.MODES) {
    assert.equal(mode.panelNotice({ mode: m, entry }), m.id === "previous-engine" ? N : null, `${m.id} with a listed package`);
    assert.equal(mode.panelNotice({ mode: m, entry: null }), null, `${m.id} with an unlisted package`);
  }
  assert.equal(mode.panelNotice({ mode: null, entry }), null);
  for (const s of ["this firmware may stay silent", "while on Default its audio engine starts", "the audio clock (PLL0) differently", "may still make no sound until it is played", "not every firmware does", "have not been verified on a physical FM-1", "Original flash model on the unified engine"]) assert.ok(N.includes(s), s);
  assert.ok(!/will (produce|make|play|start)|always|guaranteed|every (affected|listed)/i.test(N), "no promise of sound");
  assert.ok(N.length < 700, "short enough to read in the panel");
});

await test("report: the engine notes (audio clock, XIP tail, CPU optimization, firmware note) are gone from the report code, and the panel notice for the previous engine is untouched", () => {
  const src = read("chipmode.js");
  for (const gone of ["PLL0_ENGINE_LINE", "PLL0_PREVIOUS_ENGINE_LINE", "XIP_TAIL_ENGINE_LINE", "pll0FirmwareNote"]) assert.ok(!src.includes(gone), gone);
  assert.equal(mode.panelNotice({ mode: mode.modeById("previous-engine"), entry: PLL0.entries[0] }), mode.PLL0_PANEL_NOTICE);
  assert.equal(mode.panelNotice({ mode: mode.modeById("default"), entry: PLL0.entries[0] }), null);
});

await test("report: the closing notes say the profiles are reference models, that a difference between the chips is an inference and that only a real unit can confirm; no list of generic reasons, and no claim of hardware accuracy or compatibility", () => {
  const t = mode.buildReport(D), block = t.slice(t.indexOf("How to read this report:"));
  for (const s of ["How to read this report:", "A difference between the two chip models means the firmware behaved differently under them in this run; the cause is an inference.", "Only a test on a physical unit can confirm how a firmware behaves."]) assert.ok(t.includes(s), s);
  for (const s of ["POSSIBLE reasons", "command 4Bh", "Chip timing"]) assert.ok(!t.includes(s), s);
  assert.ok(!/matches (the )?(real|physical)|will (work|save|run)|compatible|safe\b/i.test(block), "no hardware or compatibility claim");
  assert.equal(t, mode.buildReport(D), "deterministic");
});

await test("Flash chip box: its own box under Now running (not inside it), foldable like the radar, with every control and sentence of the original panel, no tabs and no link to hide anything, a hidden select as the source of truth, and a top-bar badge that only jumps to it", () => {
  const html = read("index.html"), compat = read("compat.js"), chiptest = read("chiptest.js"), css = read("style.css");
  assert.ok(!html.includes('id="compat-pop"') && !html.includes("compat-btn") && !html.includes("compat-menu-item"), "the floating panel and its header button are gone");
  const now = html.slice(html.indexOf('<section class="box" aria-labelledby="h-now">'), html.indexOf("</aside>", html.indexOf('<section class="box" aria-labelledby="h-now">')));
  assert.ok(now.length > 2000, "the Now running box was found");
  assert.ok(now.indexOf('id="bank"') > 0 && now.indexOf('id="bank"') < now.indexOf("</section>") && now.indexOf("</section>") < now.indexOf('id="chip-box"'), "the Flash chip box comes after the Now running box has closed: a box of its own in the left sidebar");
  const chip = now.slice(now.indexOf('<section class="box chip-box" id="chip-box"'));
  assert.ok(chip.length > 3000, "the section is there in full");
  assert.match(chip, /<h2 class="chip-h" id="h-chip">Flash chip<\/h2>/); assert.match(chip, /<p class="dim chip-small chip-lead" id="chip-lead">Tests the firmware loaded in Now running\.<\/p>/, "one line says what it tests");
  assert.match(chip, /<select id="chipmode" aria-label="Emulation mode" hidden><\/select>/, "the select stays as the source of truth, hidden");
  assert.match(chip, /<div class="chip-seg" id="chip-seg" role="radiogroup" aria-label="Flash chip"><\/div>/, "the chip buttons are a labelled radio group");
  for (const id of ["chipnote", "chip-status", "chip-notice", "chip-timing-wrap", "chiptiming", "chip-warning", "chip-compare", "chip-copy", "chip-report-wrap", "chip-report", "chip-what", "chip-what-code", "chip-what-limits", "chip-unit", "chip-lead"]) assert.ok(chip.includes(`id="${id}"`), `${id} is in the section`);
  assert.ok(!/role="tab"|role="tablist"/.test(chip) && !/Why\?/.test(chip) && !/>About</.test(chip), "no tabs, no Why? link, no About: everything is always showing");
  assert.ok(!/<details[^>]*>(?:(?!<\/details>)[^])*chip-warning/.test(chip), "the warning is not inside a fold");
  assert.match(html, /<label>CPU clock <select id="mhz" aria-label="Emulated CPU clock"><\/select><\/label>/, "the sidebar's Clock is the CPU clock, not the transport bar's MIDI Clock");
  assert.match(html, /<button type="button" id="test-badge" class="test-badge" hidden /, "the badge starts hidden");
  assert.match(html, /<script src="compat\.js\?v=5"><\/script>/, "compat.js is loaded");
  const layout = read("layout.js");
  assert.ok(layout.includes('{ id: "chip", label: "Flash chip", sel: "aside.side-left > section.chip-box" }') && layout.includes('sel: "aside.side-left > section.box:not(.update-box):not(.chip-box)"'), "the layout list folds it on its own and Now running's selector no longer matches it");
  assert.match(html, /<script type="module" src="layout\.js\?v=5"><\/script>/);
  assert.match(compat, /lay-boxoff/, "the badge opens the box if it was folded away");
  assert.match(compat, /getElementById\("chip-box"\)/); assert.match(compat, /scrollIntoView/, "the badge scrolls to the section");
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(compat), "compat.js stores nothing");
  assert.match(chiptest, /role", "radio"/, "the chip buttons are radios"); assert.match(chiptest, /ArrowRight/, "and the arrow keys move between them");
  assert.match(chiptest, /sel\.value = id; sel\.dispatchEvent\(new Event\("change"\)\)/, "a click picks the mode through the select, which restarts the firmware");
  assert.match(chiptest, /setStatus\(mode\.restarted \?\? `Restarted in \$\{mode\.short \?\? mode\.label\} mode`\)/, "the status says the firmware restarted");
  assert.match(chiptest, /badge\.hidden = !mode\.test; badge\.textContent = mode\.badge \|\| "TEST MODE: nothing is saved"/, "the badge names the chip for every test mode and is hidden for Default");
  assert.ok(!/MutationObserver/.test(chiptest), "it is a box of its own now: nothing has to keep it last in Now running");
  assert.match(css, /\.test-badge\[hidden\] \{ display: none; \}/);
  assert.match(css, /@media \(min-width: 1400px\) \{ \.side\.bar\.side-left, \.side\.bar\.side-right \{ flex: 0 1 300px; max-width: 300px; \} \}/, "a fixed, non-growing wider column on wide windows only");
  assert.match(css, /\.side\.bar\.side-left, \.side\.bar\.side-right \{ flex: 0 1 168px; max-width: 168px; min-width: 0; \}/, "the 168 px column of the layout rule is untouched below that");
});

await test("Flash chip section text: every sentence of the original panel is there and always showing (the warning word for word, what Compare chips checks and does not check, what Default is, the chip-ID note), scoped to the chip tests, promising nothing; each mode says what it does and the badge names the chip", () => {
  const html = read("index.html"), box = html.slice(html.indexOf('<section class="box chip-box" id="chip-box"'), html.indexOf("</aside>", html.indexOf('<section class="box" aria-labelledby="h-now">')));
  assert.ok(box.length > 3000 && box.includes('id="h-chip"'), "the section's markup was found (not an empty slice)");
  const text = box.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  for (const s of ["This shows whether a firmware should work with the selected flash chip. It can't confirm that it will.", "The chip models are built from datasheets and haven't been verified on a physical FM-1. The chip tests run without a bootloader (a real unit has one, and it may change how saving works), real chip timing may differ, and Compare chips presses no keys or buttons. Only a test on a real unit can confirm how a firmware behaves.",
    "Timing here comes from the datasheet. Use maximum to test a slow chip.", "What Compare chips checks", "It runs the firmware for 3 seconds with nothing pressed on the older and newer chip models (at the Chip timing you chose, typical by default), and checks whether it started, showed a screen, started its audio and wrote to flash.", "Two extra runs without a chip model show whether a difference comes from the emulator rather than the chip.", "It also scans the firmware's code for the two chips' IDs. If the newer chip's ID is there, the firmware may support newer units; only a test on a real unit can confirm.", "It doesn't test longer than 3 seconds or the chip ID on its own, so a firmware that only writes to flash after you press something may show no difference.",
    "Not sure which chip your unit has?", "older chip 85 60 14, newer chip B3 60 14", "We can't vouch for any tool", "a unit's logo or date doesn't reliably tell the chip", "The chip test never connects to a unit or writes to one."]) assert.ok(text.includes(s), s);
  assert.ok(!/never connects to (or writes to )?(your|a) unit/i.test(text.replace("The chip test never connects to a unit or writes to one.", "")), "the no-connection statement is about the chip test only (the application can flash a unit)");
  assert.ok(!/(will|should always) (work|save|run)|guarantee|compatible with|is safe/i.test(text), "no promise");
  const def = mode.modeById("default"), old = mode.modeById("puya"), neu = mode.modeById("uc25hq80");
  assert.equal(def.effect, "Normal mode. Your patches are saved. Flash writes are instant, with no chip behaviour."); assert.equal(def.restarted, "Restarted in Default mode"); assert.equal(def.badge, "");
  for (const [m, lead, restarted] of [[old, "Older chip (Puya P25Q80H).", "Restarted on the older chip"], [neu, "Newer chip (UC25HQ80).", "Restarted on the newer chip"]]) {
    assert.equal(m.effect, lead + " Nothing is saved, and your saved patches aren't loaded. Writes take time and the chip can refuse commands, so a firmware may behave differently, including whether it saves.", m.id);
    assert.equal(m.restarted, restarted, m.id);
    assert.ok(/ test mode, nothing saved$/.test(m.badge), m.id);
  }
  assert.equal(old.badge, "OLDER CHIP (Puya): test mode, nothing saved"); assert.equal(neu.badge, "NEWER CHIP (UC25HQ80): test mode, nothing saved");
  assert.deepEqual(mode.visibleModes().map((m) => m.short), ["Default", "Older chip", "Newer chip"]);
  for (const m of mode.MODES) { assert.ok(m.effect && typeof m.short === "string", m.id); if (m.test) assert.ok(m.badge && /nothing (is )?saved/.test(m.badge) && /nothing is saved/i.test(m.effect + m.note), m.id); }
  const dn = def.note;
  for (const s of ["the only mode that saves your patches", "unified engine with the original flash model", "flash writes finish instantly", "skips loops the second CPU core provably cannot leave", "The chip modes below are tests", "save nothing"]) assert.ok(dn.includes(s), s);
  assert.ok(!/experimental/i.test(dn));
});

await test("verdict: every outcome of a comparison has a plain headline, what it means, what to try and the per-chip rows; it says what the model did in a few seconds and never that a firmware works or is compatible", () => {
  const row = (label, o = {}) => ({ label, result: result({ firstFrameMs: 52, halted: false, changedSectors: 0, changedList: [], ...o }) });
  const saved = { changedSectors: 1, changedList: [0xd6000] }, dead = { firstFrameMs: null }, halted = { halted: true, firstFrameMs: null };
  const run = (orig, o, n) => mode.chipVerdict({ original: orig, puya: o, uc: n });
  const plainSaved = row("Original", saved), plainNothing = row("Original");
  const cases = [
    ["both", run(plainSaved, row("Puya", saved), row("UC", saved)), "ok", "Started and wrote to flash on both chips."],
    ["older-only", run(plainSaved, row("Puya", saved), row("UC")), "warn", "Wrote to flash on the older chip, but not on the newer one."],
    ["newer-only", run(plainSaved, row("Puya"), row("UC", saved)), "warn", "Wrote to flash on the newer chip, but not on the older one."],
    ["none", run(plainSaved, row("Puya"), row("UC")), "info", "No flash write on either chip."],
    ["newer-no-start", run(plainSaved, row("Puya", saved), row("UC", dead)), "bad", "Didn't start on the newer chip."],
    ["older-no-start", run(plainSaved, row("Puya", halted), row("UC", saved)), "bad", "Didn't start on the older chip."],
    ["neither-start", run(plainSaved, row("Puya", dead), row("UC", dead)), "bad", "Didn't start on either chip."],
    ["error", run(plainSaved, row("Puya", saved), { label: "UC", error: "boom" }), "info", "Couldn't compare on one chip."],
  ];
  for (const [key, v, tone, headline] of cases) {
    assert.equal(v.key, key); assert.equal(v.tone, tone, key); assert.equal(v.headline, headline, key);
    assert.ok(v.meaning && v.next && v.rows.length === 2 && v.closing === mode.VERDICT_CLOSING, key);
    assert.equal(v.closing, "This is a model, not a real unit. Only Default mode saves; the chip models keep nothing, so this shows only whether the firmware wrote to flash on each one.", key);
  }
  // the exact approved wording
  const split = cases[1][1], rev = cases[2][1];
  assert.equal(split.meaning, "This firmware wrote to flash when it ran on the older chip model, but not on the newer one. It may behave differently on an FM-1 with the newer chip.");
  assert.equal(split.next, "Check which chip your FM-1 has using a tool like M-Flasher. If it's the newer one, ask the firmware's author whether it supports it.");
  assert.equal(rev.next, "Check which chip your FM-1 has using a tool like M-Flasher. If it's the older one, ask the firmware's author whether it supports it.");
  assert.equal(cases[3][1].meaning, "That doesn't mean it failed. Many firmware only write to flash after you press a key or change a setting, and this test presses nothing.");
  assert.deepEqual(split.rows.map((r) => [r.label, r.state]), [["Older chip", "wrote"], ["Newer chip", "no-write"]]);
  assert.equal(cases[5][1].rows[0].text, "did not start (the CPU halted)");
  // a reason is named only when the comparison shows one
  assert.ok(split.reasons.includes("may only accept the older chip's ID") && cases[3][1].reasons.includes("plain flash model"), "reasons are possibilities, and the plain-model one needs the plain model to have saved");
  assert.equal(run(plainNothing, row("Puya"), row("UC")).reasons, "", "no plain-model reason when the plain model did not save either");
  assert.equal(cases[0][1].reasons, "");
  // wording rules: no promise, no compatibility claim, possibilities as "may"
  for (const [, v] of cases) {
    const text = [v.headline, v.meaning, v.reasons, v.next, ...v.rows.map((r) => r.text)].join(" ");
    assert.ok(!/\b(compatible|safe|guarantee[ds]?|will (work|save|run)|works (fine|well|on both)|is fine)\b/i.test(text), `no promise: ${text}`);
  }
  // the report starts its comparison with the verdict
  const c = { seconds: 3, rows: [{ label: "A", chip: "puya", result: result() }], differences: [], verdict: split };
  const t = mode.buildReport({ ...D, comparison: c });
  assert.ok(t.indexOf("COMPARISON (") < t.indexOf("VERDICT: Wrote to flash on the older chip, but not on the newer one.") && t.indexOf("VERDICT:") < t.indexOf("[A]"), "the verdict heads the comparison");
  for (const line of mode.verdictLines(split)) assert.ok(t.includes(line), line);
  assert.ok(!mode.buildReport({ ...D, comparison: { ...c, verdict: undefined } }).includes("VERDICT:"), "no verdict line when there is none");
});

await test("code check: counts the two chip IDs in a firmware's code in either byte order, classifies them, adds one plain line to the verdict (agreeing with the test only when both name the same chip), and never overstates", () => {
  const bytes = (...parts) => Uint8Array.from(parts.flat());
  assert.deepEqual(mode.countChipIds(bytes([1, 2, 3])), { older: 0, newer: 0 });
  assert.deepEqual(mode.countChipIds(bytes([9, 0x85, 0x60, 0x14, 9])), { older: 1, newer: 0 }, "85 60 14");
  assert.deepEqual(mode.countChipIds(bytes([0x14, 0x60, 0x85, 0x00])), { older: 1, newer: 0 }, "the same ID inside a little-endian 32-bit constant");
  assert.deepEqual(mode.countChipIds(bytes([0xb3, 0x60, 0x14, 0x14, 0x60, 0xb3])), { older: 0, newer: 2 }, "B3 60 14 in both orders");
  assert.deepEqual(mode.countChipIds(bytes([0x85, 0x61, 0x14, 0x85, 0x60, 0x15])), { older: 0, newer: 0 }, "near misses are not IDs");
  assert.deepEqual(["both", "older-only", "newer-only", "neither"], [{ older: 1, newer: 1 }, { older: 2, newer: 0 }, { older: 0, newer: 1 }, { older: 0, newer: 0 }].map(mode.classifyChipIds));
  const row = (o = {}) => ({ label: "x", result: result({ firstFrameMs: 52, halted: false, changedSectors: 0, changedList: [], ...o }) });
  const saved = { changedSectors: 1, changedList: [0xd6000] };
  const split = mode.chipVerdict({ original: row(saved), puya: row(saved), uc: row() }), both = mode.chipVerdict({ original: row(saved), puya: row(saved), uc: row(saved) });
  const a = mode.withCodeCheck(split, "older-only");
  assert.equal(a.code.class, "older-only"); assert.equal(a.code.agrees, true);
  assert.equal(a.code.text, mode.CODE_CHECK_TEXT["older-only"] + " Both the test and the code point the same way.");
  assert.equal(mode.withCodeCheck(split, "both").code.agrees, false, "a verdict that one chip failed is not 'confirmed' by code that names both");
  assert.equal(mode.withCodeCheck(both, "older-only").code.agrees, false, "and code naming one chip does not agree with a test where both saved");
  assert.equal(mode.withCodeCheck(split, null).code.text, "Couldn't read this firmware's code."); assert.equal(mode.withCodeCheck(split, "nonsense").code.class, "unreadable");
  assert.equal(mode.withCodeCheck(null, "both"), null);
  assert.deepEqual(Object.keys(mode.CODE_CHECK_TEXT).sort(), ["both", "neither", "newer-only", "older-only", "unreadable"]);
  for (const t of [...Object.values(mode.CODE_CHECK_TEXT), mode.CODE_CHECK_NOTE]) assert.ok(!/\b(compatible|safe|guarantee[ds]?|will (work|save|run)|works (fine|well))\b/i.test(t), `no promise: ${t}`);
  assert.equal(mode.CODE_CHECK_TEXT["older-only"], "This firmware's code recognises only the older chip's ID, so it may not support the newer chip.");
  assert.equal(mode.CODE_CHECK_TEXT.both, "This firmware's code recognises both chips' IDs."); assert.equal(mode.CODE_CHECK_TEXT["newer-only"], "This firmware's code recognises only the newer chip's ID, so it may not support the older chip."); assert.equal(mode.CODE_CHECK_TEXT.neither, "This firmware's code doesn't contain either chip's ID, so it probably doesn't check the chip.");
  for (const t of Object.values(mode.CODE_CHECK_TEXT)) assert.ok(!/bundled|\d{2,}/.test(t), "the line is about this firmware only, with no figures from other firmware: " + t);
  assert.equal(mode.CODE_CHECK_NOTE, "Reading the code is an indication, not proof: it shows which IDs the code contains, not what it does with them.");
  const t = mode.buildReport({ ...D, comparison: { seconds: 3, rows: [{ label: "A", result: result() }], differences: [], verdict: a } });
  assert.ok(t.includes("Code check: " + a.code.text) && t.includes(mode.CODE_CHECK_NOTE), "the report carries the code check");
  assert.ok(!mode.buildReport({ ...D, comparison: { seconds: 3, rows: [{ label: "A", result: result() }], differences: [], verdict: split } }).includes("Code check:"), "and omits it when there is none");
  const chiptest = read("chiptest.js");
  assert.match(chiptest, /import \{ appFromPackage \} from "\.\/fwsc\.js";/); assert.match(chiptest, /classifyChipIds\(countChipIds\(appFromPackage\(/); assert.match(chiptest, /result\.verdict = withCodeCheck\(result\.verdict, codeClass\);/);
  assert.match(chiptest, /add\("p", "chip-vl", "Code check"\)/, "the card shows the code check");
});

await test("verdict card: the page has a status region for it, the button says Compare both chips, the card is text only (textContent) and is cleared when another firmware loads", () => {
  const html = read("index.html"), chiptest = read("chiptest.js"), css = read("style.css");
  assert.match(html, /<div id="chip-verdict" class="chip-verdict" role="status" aria-live="polite" data-empty="true"><p class="chip-vempty">The verdict appears here after you compare the chips\.<\/p><\/div>/);
  assert.match(html, />Compare both chips<\/button>/);
  assert.ok(html.indexOf('id="chip-verdict"') > html.indexOf('id="chip-compare"') && html.indexOf('id="chip-verdict"') < html.indexOf('id="chip-report-wrap"'), "between the buttons and the report");
  assert.match(chiptest, /renderVerdict\(result\.verdict\);/); assert.match(chiptest, /renderVerdictLater = \(\) => \{ renderVerdict\(null\); clearReport\(\); \};/, "a new firmware clears the card and the report");
  const render = chiptest.slice(chiptest.indexOf("const renderVerdict = (v) => {"), chiptest.indexOf("// The report area is always"));
  assert.ok(render.length > 400 && !/innerHTML|insertAdjacentHTML|outerHTML/.test(render), "the card is built from text, never from markup");
  assert.match(chiptest, /Comparing… step \$\{m\.text\} \(\$\{COMPARE_SECONDS\} s each\)/, "a progress line while it runs");
  assert.ok(!/id="chip-verdict"[^>]*\bhidden\b/.test(html), "the verdict card is on the page from the start, not hidden");
  assert.ok(chiptest.includes('const VERDICT_PLACEHOLDER = "The verdict appears here after you compare the chips.";') && /if \(!v\) \{ delete verdictBox\.dataset\.tone; delete verdictBox\.dataset\.key; verdictBox\.dataset\.empty = "true"; add\("p", "chip-vempty", VERDICT_PLACEHOLDER\); return; \}/.test(chiptest), "with no verdict the card shows its one-line placeholder, never an empty or hidden box");
  assert.ok(!/verdictBox\.hidden/.test(chiptest), "nothing hides the card");
  assert.match(css, /\.chip-box \.chip-verdict \.chip-vempty \{/);
  for (const tone of ["ok", "warn", "bad"]) assert.ok(css.includes(`.chip-verdict[data-tone="${tone}"]`), tone);
});

await test("Firmware radar: in the right sidebar under Install firmware (its markup is last in that sidebar and Install firmware is inserted before it), the layout list names it there, every control still exists once, and the left sidebar keeps Now running and Flash chip only", () => {
  const html = read("index.html"), layout = read("layout.js"), install = read("install.js");
  const aside = (cls) => { const a = html.indexOf('<aside class="side bar ' + cls + '"'); return html.slice(a, html.indexOf("</aside>", a)); };
  const right = aside("side-right"), left = aside("side-left");
  assert.ok(right.includes('<section class="box update-box" aria-labelledby="h-radar">') && right.indexOf("h-radar") > right.indexOf("h-play-from"), "the radar is the last section of the right sidebar's markup");
  assert.ok(!left.includes("h-radar") && left.includes('aria-labelledby="h-now"') && left.includes('aria-labelledby="h-chip"'), "the left sidebar keeps Now running and Flash chip only");
  for (const id of ["firmware-radar-scan", "firmware-radar-updates", "firmware-radar-apply", "firmware-radar-discard", "firmware-radar-reset", "firmware-radar-status", "firmware-radar-filters", "firmware-radar-list", "firmware-radar-meta"]) assert.equal(html.split('id="' + id + '"').length, 2, id + " exists once");
  assert.ok(layout.includes('{ id: "radar", label: "Firmware radar", sel: "aside.side-right > section.update-box" }'), "the layout list finds it in the right sidebar");
  assert.ok(install.includes('side.querySelector(":scope > section.update-box")') && install.includes("side.insertBefore(box, radar)"), "Install firmware is put in above the radar");
  assert.match(html, /install\.js\?v=102/); assert.match(html, /layout\.js\?v=5/);
});

await test("layout: the synth panel leaves room beside the columns (FIT_SLACK in deck.js), so the Install firmware column cannot drop under the left sidebar when the window is maximized, and the 300 px column is for wide windows only", () => {
  const deck = read("deck.js"), css = read("style.css"), html = read("index.html");
  assert.match(deck, /const FIT_SLACK = 24;/, "the panel is fitted 24 px short of the width it is given");
  assert.match(deck, /const avail = Math\.max\(RIG_W \* 0\.4, \(deck\.clientWidth \|\| RIG_W\) - FIT_SLACK\);/, "and the slack comes off the measured width");
  assert.match(html, /<script src="deck\.js\?v=119"><\/script>/, "the changed deck.js has its own version");
  assert.match(css, /@media \(min-width: 1400px\) \{ \.side\.bar\.side-left, \.side\.bar\.side-right \{ flex: 0 1 300px; max-width: 300px; \} \}/);
});

await test("comparison text: describeRun separates the audio engine's start from audible output and from flash, and the report lists the flash writes", () => {
  const lines = mode.describeRun(result({ audioStarted: false, audioFrames: 0, audioRequested: 176400, changedSectors: 2, changedList: [0xde000, 0xdf000] }));
  const at = (re) => lines.findIndex((l) => re.test(l));
  assert.ok(lines.includes("audio engine: did NOT start (0 real audio frames of 176400 rendered)"));
  assert.ok(at(/^audio engine:/) >= 0 && at(/^audible output:/) > at(/^audio engine:/) && at(/^flash writes:/) > at(/^audible output:/), "three separate statements, in that order");
  assert.ok(mode.describeRun(result()).includes("audio engine: started (87000 real audio frames of 88320 rendered)"));
  assert.ok(!mode.describeRun(result({ audioStarted: undefined })).some((l) => /^audio engine:/.test(l)), "no invented value when a row has none");
  const t = mode.buildReport({ ...D, comparison: { seconds: 3, rows: [{ label: "Older chip", chip: "puya", result: result({ changedSectors: 2, changedList: [0xde000, 0xdf000] }) }], differences: [] } });
  for (const s of ["flash writes: 2 sector(s) written (0xDE000, 0xDF000)", "audio engine: started"]) assert.ok(t.includes(s), s);
});

// ---- the CPU optimization (settled-loop early exit of core 1) in the normal execution path: Default asks for it, nothing else does, and nothing about it is selectable or stored
await test("Default and the CPU optimization: Default is the optimized unified engine with the optimization on and saves; the two chip modes run the same engine with the same optimization (and save nothing); the references run without it", () => {
  const m = mode.modeById("default");
  assert.deepEqual([m.engine, m.chip, m.test, m.settledLoop], ["optimized", null, false, true]);
  assert.equal(m.experimental, undefined);
  assert.deepEqual(mode.MODES.filter((x) => x.settledLoop).map((x) => x.id), ["default", "puya", "uc25hq80"]);
  assert.equal(mode.MODES.find((x) => x.id === "original-unified").engine, "unified", "the baseline runs the unified engine as it is");
  assert.equal(mode.MODES.find((x) => x.id === "previous-engine").engine, "shipped");
  assert.notEqual(m.engine, "unified", "its own engine key: the worker's compiled-module cache is keyed by it, so it can never return the unified module (or the other way round)");
  assert.deepEqual(mode.MODES.filter((x) => x.chip).map((x) => x.engine), ["optimized", "optimized"], "the chip modes run the optimized engine");
  assert.equal(new Set(Object.keys(mode.ENGINE_FILES)).size, 3);
});

await test("applyCpuOptimization: does nothing unless asked, switches the optimization on once when asked, and refuses (never silently runs the original path) on an engine without the switch", () => {
  const calls = [];
  const x = { fm1_settled_loop: (n) => calls.push(n) };
  assert.equal(mode.applyCpuOptimization(x, false), null); assert.equal(mode.applyCpuOptimization(x, undefined), null); assert.deepEqual(calls, []);
  assert.deepEqual(mode.applyCpuOptimization(x, true), { settledLoop: true }); assert.deepEqual(calls, [1]);
  assert.throws(() => mode.applyCpuOptimization({}, true), /no CPU optimization switch/);
  assert.equal(mode.applyCpuOptimization({}, false), null, "an engine without the switch is fine when it is not asked");
  assert.equal(mode.chipStatus({}).settledLoop, null);
  assert.deepEqual(mode.chipStatus({ fm1_settled_loop_stat: (i) => [3, 0, 900, 0, 0, 7][i] }).settledLoop, { callsSkipped: 3, instructionsSkipped: 900, callsHeldOff: 7 });
  assert.ok(!("applyExperimental" in mode), "the validation-era name is gone");
});

await test("Default, the engine selection and persistence (source-shape guards): the optimized file is named only in chipmode.js, the flag reaches the worker only from the mode, the shipped engine still draws the panel, and nothing about the mode or engine is stored", () => {
  const mainSrc = read("main.js"), chiptestSrc = read("chiptest.js"), chipmodeSrc = read("chipmode.js"), workletSrc = read("worklet.js");
  assert.match(mainSrc, /const wasm = await \(await fetch\("fm1_web\.wasm\?v=25"\)\)\.arrayBuffer\(\);/, "the page still fetches the shipped engine: it draws the front panel (fm1_skin) and is the reference mode");
  assert.match(mainSrc, /const engineBytes = \{ shipped: wasm \};/, "the shipped bytes are held for the reference mode; the engine of the selected mode is fetched on first use");
  assert.match(mainSrc, /const ui = \(await WebAssembly\.instantiate\(wasm,/, "the panel is drawn by the shipped engine's own instance in every mode");
  for (const f of ["main.js", "chiptest.js", "worklet.js", "engine.js", "chipcompare.js", "chipcompare-worker.js", "index.html"]) assert.ok(!/frodhes_optimized/.test(read(f)), `${f} never names the optimized file (only ENGINE_FILES in chipmode.js does)`);
  assert.equal((chipmodeSrc.match(/fm1_web_frodhes_optimized\.wasm/g) || []).length, 1);
  assert.match(mainSrc, /chip: mode\.chip, chipTiming, settledLoop: !!mode\.settledLoop, package:/, "the boot message carries the flag only as the mode's own setting");
  assert.equal((workletSrc.match(/applyCpuOptimization\(/g) || []).length, 1);
  assert.match(workletSrc, /applyCpuOptimization\(x, m\.settledLoop === true\);/, "only a boot message that says true switches it on");
  assert.match(workletSrc, /this\.moduleId !== engineId/, "the compiled module is cached by engine id");
  for (const f of ["main.js", "chiptest.js", "worklet.js", "chipmode.js", "index.html"]) assert.ok(!/adaptive-cpu|Adaptive CPU|applyExperimental|experimental: true/.test(read(f)), `${f}: no trace of the experimental selection`);
  const html = read("index.html"), panel = html.slice(html.indexOf('<section class="box chip-box" id="chip-box"'), html.indexOf("</aside>", html.indexOf('<section class="box" aria-labelledby="h-now">')));
  assert.ok(panel.length > 2000, "the panel's markup was found (not an empty slice)");
  assert.ok(!/experimental/i.test(panel), "the chip panel offers no experimental mode");
  const storage = /localStorage|sessionStorage|indexedDB|document\.cookie|saveStore|store\(/;
  assert.ok(!storage.test(chiptestSrc), "chiptest.js stores nothing");
  assert.ok(!storage.test(chipmodeSrc), "chipmode.js stores nothing");
  // (every call of the page's store() helper and every direct storage write; the helper's own definition line and comments are not calls)
  const code = (l) => l.replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "");
  const writes = mainSrc.split("\n").filter((l) => !/^\s*const store = /.test(l) && (/\bstore\(/.test(code(l)) || /(localStorage|sessionStorage)\.setItem/.test(code(l))));
  assert.ok(writes.length > 0, "the scan finds the page's storage writes (so it is not passing on an empty set)");
  // (what is stored must not mention the emulation mode, the engine or the optimization: a storage key naming them, or the chip-test state, an engine table or the mode object as the value; the unrelated A/B-compare setting "abMode" is not the emulation mode)
  const forbidden = /chipTest|\bmode\.|ENGINE_FILES|engineBytes|settledLoop|chipmode|["'`][^"'`]*(chip|engine|settled|optimi|emulation)/i;
  for (const line of writes) assert.ok(!forbidden.test(code(line)), `main.js stores nothing about the mode or engine: ${line.trim()}`);
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(workletSrc), "the worker stores nothing");
});

await test("cache-busting: every importer of chipmode.js, chipcompare.js, chiptest.js, worklet.js and engine.js names the version this change set, so a returning browser cannot mix old and new modules", () => {
  const files = ["main.js", "chiptest.js", "chipcompare.js", "chipcompare-worker.js", "worklet.js", "engine.js", "index.html"];
  const versions = (name) => files.flatMap((f) => [...read(f).matchAll(new RegExp(`(?<![A-Za-z0-9_-])${name.replace(".", "\\.")}\\?v=(\\d+)`, "g"))].map((m) => `${f}:${m[1]}`));
  for (const [name, v] of [["chipmode.js", "15"], ["chipcompare.js", "15"], ["chiptest.js", "18"], ["chipcompare-worker.js", "15"], ["worklet.js", "45"], ["engine.js", "15"]]) {
    const all = versions(name);
    assert.ok(all.length > 0, name);
    assert.ok(all.every((e) => e.endsWith(`:${v}`)), `${name} ${all.join(" ")}`);
  }
  assert.match(read("index.html"), /main\.js\?v=133/);
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

  // the CPU optimization on the real engines, through the page's own switch (applyCpuOptimization, as worklet.js calls it after a boot): the optimized engine without the switch behaves as the unified engine, with it as without
  await test("the CPU optimization (Default) on the real engines: the optimized engine with the switch off equals the unified engine, with it on equals off (display, audio, flash, clock), interpreted and compiled, and Frodhes really skips", async () => {
    const optimized = await loadEngine({ wasmPath: resolve(SITE, mode.ENGINE_FILES.optimized.file), name: mode.ENGINE_FILES.optimized.file });
    const seen = (engine, pkg, { on, jit, ms }) => {
      const m = Fm1Machine.boot(engine, pkg, { usb: true, jit });
      if (on !== null) mode.applyCpuOptimization(m.x, on);
      m.run(ms);
      return { obs: m.observe(), flash: m.flashHash(), skipped: m.x.fm1_settled_loop_stat ? m.x.fm1_settled_loop_stat(2) : null };
    };
    for (const [id, jit, ms] of [["quadro-fm1", false, 3000], ["frodhes", true, 2000], ["frodhes", false, 1500]]) {
      const pkg = new Uint8Array(catalogPackage(id));
      const u = seen(unified, pkg, { on: null, jit, ms }), off = seen(optimized, pkg, { on: false, jit, ms }), on = seen(optimized, pkg, { on: true, jit, ms });
      assert.deepEqual(off.obs, u.obs, `${id} jit ${jit}: switch off = unified engine`); assert.equal(off.flash, u.flash);
      assert.deepEqual(on.obs, off.obs, `${id} jit ${jit}: switch on = off`); assert.equal(on.flash, off.flash);
      assert.equal(off.skipped, 0, "nothing is skipped with the switch off");
      if (id === "frodhes") assert.ok(on.skipped > 0, `frodhes jit ${jit}: the optimization skipped nothing`);
    }
  });

  // the regression Stage 2 found in the first optimized engine (v4): a core 1 that computes with registers that never repeat does nothing observable and finds no loop, so the lookups were paid for forever (fm1dock 3.7x, duell 2.4x slower).
  // Counters, not timings: v5 stops looking for whole calls after such a call (v4 held off about 1,400 calls in this run, v5 over 100,000), and the machine still ends exactly as with the optimization off.
  await test("the optimization stops looking on a core 1 that computes without ever repeating a state (fm1dock): most calls are held off, nothing is skipped that matters, and the machine ends exactly as with it off", async () => {
    const optimized = await loadEngine({ wasmPath: resolve(SITE, mode.ENGINE_FILES.optimized.file), name: mode.ENGINE_FILES.optimized.file });
    const pkg = new Uint8Array(catalogPackage("fm1dock"));
    const seen = (on) => { const m = Fm1Machine.boot(optimized, pkg, { usb: true, jit: true }); mode.applyCpuOptimization(m.x, on); m.run(2000); return { obs: m.observe(), flash: m.flashHash(), held: m.x.fm1_settled_loop_stat(5), skipped: m.x.fm1_settled_loop_stat(2) }; };
    const off = seen(false), on = seen(true);
    assert.deepEqual(on.obs, off.obs); assert.equal(on.flash, off.flash);
    assert.equal(off.held, 0, "the switch off examines nothing");
    assert.ok(on.held > 50_000, `the hold-off did not engage on a core that never repeats a state: ${on.held} calls held off`);
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
    const LABELS = ["Previous engine (shipped fm1_web.wasm)", "Original flash model on the unified engine", "Older FM-1 flash: Puya P25Q80H profile", "Newer FM-1 flash: UC25HQ80 profile"];
    const c = await cmp.runComparison({ engines: modules, pkg: QUADRO, seconds: 4 });
    assert.deepEqual(c.rows.map((r) => r.label), LABELS);
    assert.ok(c.rows.every((r) => r.result), "all four ran");
    assert.ok(c.rows.every((r) => r.result.audioStarted === true && r.result.audioFrames > 0), "quadro-fm1 starts its audio engine in every row (measured the same way in all four)");
    assert.ok(!c.differences.some((s) => s.startsWith("[engine]")), "the previous engine and the original flash model on the unified engine do not differ for quadro-fm1: " + c.differences.join(" | "));
    assert.ok(c.differences.some((s) => /^\[chip\] Newer FM-1 flash: UC25HQ80 profile vs Original flash model on the unified engine: flash writes differ \(0 sector\(s\) here, 1 in the reference\)/.test(s)), c.differences.join(" | "));
    assert.ok(c.differences.some((s) => /^\[chip\] Newer FM-1 flash: UC25HQ80 profile vs Older FM-1 flash: Puya P25Q80H profile: possible cause \(an inference, not verified\)/.test(s)));
    assert.ok(!c.differences.some((s) => /audio engine/.test(s)), "no audio-engine difference to report");
    // an affected package: the audio engine starts on the unified rows only, and that is attributed to the engine, not to a chip
    const CTL = new Uint8Array(catalogPackage("ctl")), ctl = await cmp.runComparison({ engines: modules, pkg: CTL, seconds: 3 });
    assert.deepEqual(ctl.rows.map((r) => r.result.audioStarted), [false, true, true, true], "CTL-1: not on the previous engine, on all three unified rows");
    assert.equal(ctl.rows[0].result.audioFrames, 0);
    assert.ok(ctl.differences.includes("[engine] Original flash model on the unified engine vs Previous engine (shipped fm1_web.wasm): the audio engine started here but not in the reference (an engine difference: the flash model is the same in both)"), ctl.differences.join(" | "));
    assert.ok(!ctl.differences.some((s) => s.startsWith("[chip]") && /audio engine/.test(s)), "no chip is named for the audio difference");
    assert.ok(mode.pll0Entry(sha256(CTL), PLL0) && !mode.pll0Entry(sha256(QUADRO), PLL0), "CTL-1's package is on the PLL0 list, quadro-fm1's is not");
    const bad = await cmp.runComparison({ engines: { shipped: modules.shipped, unified: modules.shipped }, pkg: QUADRO, seconds: 1 });
    assert.equal(bad.rows[0].result.halted, false);
    assert.ok(bad.rows[1].result && bad.rows[0].result, "the two original-model rows run");
    assert.ok(bad.rows.slice(2).every((r) => /no flash chip profiles/.test(r.error)), "the shipped engine cannot take a chip profile: said, not silently run as the original model");
    await assert.rejects(cmp.runConfig({ module: modules.unified, pkg: new Uint8Array(64), seconds: 1 }), /not an FM-1 update package/);
    const fwscMod = await import(new URL("../site/emulator/fwsc.js", import.meta.url));
    const classOf = (id) => mode.classifyChipIds(mode.countChipIds(fwscMod.appFromPackage(new Uint8Array(catalogPackage(id)))));
    assert.equal(classOf("quadro-fm1"), "older-only", "quadro-fm1's code has only the older ID, as its behaviour on the chip models shows"); assert.equal(classOf("fm1-field"), "older-only");
    for (const id of ["felucca", "aurora", "frodhes", "x0x", "melodee"]) assert.equal(classOf(id), "both", id);
    for (const id of ["dx747", "clatter"]) assert.equal(classOf(id), "neither", id);
    assert.equal(c.verdict.key, "older-only", "quadro-fm1 saves on the older chip model and not on the newer one: " + JSON.stringify(c.verdict.rows));
    assert.equal(c.verdict.headline, "Wrote to flash on the older chip, but not on the newer one.");
    assert.deepEqual(c.rows.map((r) => r.chip), [null, null, "puya", "uc25hq80"], "the rows say which are the two chips");
    assert.ok(c.chipDifferences.some((t) => /^\[chip\] Newer FM-1 flash: UC25HQ80 profile vs Older FM-1 flash: Puya P25Q80H profile: flash writes differ \(0 sector\(s\) here, 1 in the reference\)/.test(t)) && !c.chipDifferences.some((t) => /Original|\[engine\]|possible cause/.test(t)), "the report's differences are the two chips against each other: " + c.chipDifferences.join(" | "));
    const text = mode.buildReport({ ...D, comparison: c });
    assert.ok(text.includes("VERDICT: Wrote to flash on the older chip, but not on the newer one."));
    assert.ok(text.includes("[Newer FM-1 flash: UC25HQ80 profile]") && text.includes("flash writes: 0 sector(s) written") && text.includes("audio engine: started") && !text.includes("[Previous engine") && !text.includes("[Original flash model"), "the report lists the two chips only");
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

await test("main.js and worklet.js: the shipped engine's own instance still draws the panel in every mode, and the chip is applied after the flash restore and the USB host, the optimization last", () => {
  assert.match(main, /const engineBytes = \{ shipped: wasm \};/);
  assert.match(main, /const ui = \(await WebAssembly\.instantiate\(wasm,/, "the panel is drawn by the shipped engine's own instance in every mode");
  const boot = worklet.slice(worklet.indexOf("async boot(m, token)"), worklet.indexOf("observeFlash()"));
  const order = ["fm1_boot_fwsc", "fm1_flash_restore", "fm1_usb_plug", "applyChipProfile", "applyCpuOptimization", "this.x = x"].map((s) => boot.indexOf(s));
  assert.ok(order.every((i) => i > 0) && order.every((v, i) => !i || v > order[i - 1]), `boot order: ${order}`);
  assert.match(boot, /const engineId = m\.engineId \|\| "shipped";/, "a boot message without an engine id (an older caller) is the shipped engine");
  assert.match(boot, /flash chip test modes are for the FM-1 board/);
  assert.match(worklet, /m\.type === "chip-status"/);
  const html = read("index.html");
  for (const id of ["chipmode", "chiptiming", "chip-copy", "chip-compare", "chip-status", "chip-report", "chip-notice"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /<p id="chip-notice"[^>]*\bhidden\b/, "the PLL0 notice starts hidden");
  const test = read("chiptest.js");
  assert.match(test, /panelNotice\(\{ mode, entry: pll0Entry\(hashOfLoaded\(\), pll0\) \}\)/, "the notice is decided by the package hash and the mode");
  assert.ok(!/buildReport\(\{[^}]*pll0:/s.test(test) && !/engineIdentity/.test(test), "the report no longer takes the audio-clock note or the engine's identity");
  assert.ok(!/pll0\.entries|\.entries\.find|fw\??\.id ===? ?["']/.test(test), "no id or name classification in the page code");
  assert.match(test, /modeById\("previous-engine"\)/, "the comparison's first row is the previous shipped engine");
  assert.match(html, /The chip models are built from datasheets and haven't been verified on a physical FM-1\./, "the always-visible warning says the chip models are not confirmed against a physical FM-1 (it replaces the separate \"Not confirmed to match a physical FM-1's chip\" paragraph)");
  assert.match(html, />Copy report</, "the button is a general-purpose \"Copy report\"");
});

console.log(`PASS: ${passed} chip mode tests${FULL ? " (full)" : ""}`);
