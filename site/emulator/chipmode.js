// Emulation modes and the diagnostic report (Component 8, Stage 2). Plain functions, no DOM: the page, the worker and the Node tests (ci/chip-mode-tests.mjs) import it.
//
// Default is the application's normal engine: the optimized unified engine (upstream fm1-emu v0.3.0 + the chip-profile and unified patches, with the USB host and USB audio in)
// with the validated CPU optimization (the settled-loop early exit of core 1) switched on, the original instantaneous flash model, and the user's saved patches. The shipped engine (fm1_web.wasm) is no
// longer what runs firmware: it still draws the front panel (fm1_skin) and is kept as a reference ("Previous engine", a test mode). The other modes are diagnostics: the same firmware on the unified engine
// without the optimization, where the FM-1's SPI flash is a datasheet-based model, the Puya P25Q80H reference profile (the older FM-1s) or the UC25HQ80 (the newer ones), with the chip's own status register,
// write enable, busy (WIP), protection, page wrap and cycle times. Both are REFERENCE profiles built from datasheets; neither has been confirmed to match a physical FM-1's chip.
//
// A test session is EPHEMERAL: it starts from the package's own flash, never reads the user's saved patches and never writes them (main.js). Default is the only mode that saves.

export const ENGINE_FILES = {
  // the engine that drew the application before (and still draws the front panel in main.js); a reference mode below
  shipped: { file: "fm1_web.wasm", v: 25 },
  // the unified engine as it is (the chip test modes): fetched only when one of them is chosen
  unified: { file: "fm1_web_unified.wasm", v: 2 },
  // the unified engine with the settled-loop early exit of core 1 (ci/engine/settled-loop.patch): the engine of Default
  optimized: { file: "fm1_web_frodhes_optimized.wasm", v: 2 },
};

/** short: the label on the chip button. effect: the one line under the buttons (what the mode does to the firmware). badge: the top bar's text while the mode runs ("" for Default). id: the select's value and the `?mode=` parameter. engine: which wasm runs it. chip: null (the original flash model) or the profile name fm1_flash_chip takes. */
export const MODES = [
  { id: "default", short: "Default", effect: "Normal mode. Your patches are saved. Flash writes are instant, with no chip behaviour.", restarted: "Restarted in Default mode", badge: "", label: "Default", engine: "optimized", chip: null, test: false, settledLoop: true,
    note: "The normal emulator, and the only mode that saves your patches in this browser. It runs the unified engine with the original flash model (flash writes finish instantly, with no chip status or busy states) and a CPU optimization that skips loops the second CPU core provably cannot leave. The chip modes below are tests: they use a datasheet-based flash chip model and save nothing." },
  { id: "puya", short: "Older chip", effect: "Older chip (Puya P25Q80H). Nothing is saved, and your saved patches aren't loaded. Writes take time and the chip can refuse commands, so a firmware may behave differently, including whether it saves.", restarted: "Restarted on the older chip", badge: "OLDER CHIP (Puya): test mode, nothing saved", label: "Older FM-1 flash: Puya P25Q80H profile", engine: "optimized", chip: "puya", test: true, settledLoop: true,
    note: "Test mode. Datasheet-based reference profile of the older units' flash chip (JEDEC 85 60 14). Starts from the package's own flash; nothing is saved." },
  { id: "uc25hq80", short: "Newer chip", effect: "Newer chip (UC25HQ80). Nothing is saved, and your saved patches aren't loaded. Writes take time and the chip can refuse commands, so a firmware may behave differently, including whether it saves.", restarted: "Restarted on the newer chip", badge: "NEWER CHIP (UC25HQ80): test mode, nothing saved", label: "Newer FM-1 flash: UC25HQ80 profile", engine: "optimized", chip: "uc25hq80", test: true, settledLoop: true,
    note: "Test mode. Datasheet-based reference profile of the newer units' flash chip (JEDEC B3 60 14). Starts from the package's own flash; nothing is saved." },
  { id: "original-unified", short: "Reference", effect: "Reference test mode: the unified engine with the original flash model and without the CPU optimization. Nothing is saved.", badge: "TEST MODE: nothing is saved", label: "Original flash model on the unified engine, no CPU optimization (reference)", engine: "unified", chip: null, test: true, hidden: true,
    note: "Test mode. The unified engine with the original instantaneous flash model and without the CPU optimization: the baseline to compare the chip profiles against. Nothing is saved." },
  { id: "previous-engine", short: "Previous engine", effect: "Reference test mode: the engine this application ran before, with the original flash model. Nothing is saved.", badge: "TEST MODE: nothing is saved", label: "Previous engine, fm1_web.wasm (reference)", engine: "shipped", chip: null, test: true, hidden: true,
    note: "Test mode. The engine this application ran before, with the original flash model: a reference to compare Default against. Nothing is saved." },
];
/** The modes the Emulation select offers: Default and the two chips. A `hidden` mode is a developer reference (the unified engine without the optimization, the previous shipped engine): still reachable with ?mode= and still used by Compare chips, never listed. */
export const visibleModes = () => MODES.filter((m) => !m.hidden);
export const TIMINGS = [{ id: "typical", label: "typical cycle times" }, { id: "maximum", label: "maximum cycle times" }];
export const CHIP_IDS = { puya: 1, uc25hq80: 2 };
export const TIMING_IDS = { typical: 0, maximum: 1 };
export const JEDEC = { puya: [0x85, 0x60, 0x14], uc25hq80: [0xb3, 0x60, 0x14] };
export const DEFAULT_MODE = "default";

// ---- the PLL0 audio-clock difference between the unified engine (Default) and the previous shipped engine (Component 8, Stage 6; the roles changed when the unified engine became Default)
// site/emulator/pll0-firmware.json lists, by package SHA-256 only, the bundled firmware whose audio engine starts on the unified engine and never on the previous shipped engine (ci/pll0-audit.mjs checks it).
/** The package's entry in the PLL0 list, or null. Matched by the package's SHA-256 alone (never by id or name: another version of the same firmware may behave differently). */
export function pll0Entry(sha256, data) {
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256) || !Array.isArray(data?.entries)) return null;
  return data.entries.find((e) => e.sha256 === sha256) ?? null;
}
export const PLL0_PANEL_NOTICE =
  "Audio-clock difference: on this previous engine this firmware may stay silent, while on Default its audio engine starts, because the two engines set up the audio clock (PLL0) differently. " +
  "It may still make no sound until it is played, and not every firmware does. Default's PLL0 values come from the upstream emulator and have not been verified on a physical FM-1. " +
  "To compare flash chip models, use Default or \"Original flash model on the unified engine\" rather than this engine.";
/** The notice under the mode note: only in the previous-engine test mode (the one that leaves the audio clock at zero), only for a package whose SHA-256 is on the list. */
export const panelNotice = ({ mode, entry }) => (mode?.test && mode.engine === "shipped" && entry ? PLL0_PANEL_NOTICE : null);
export const modeById = (id) => MODES.find((m) => m.id === id) ?? null;
/** The mode a `?mode=` value names (case-insensitive; "old" and "new" as the harness's aliases), or the default. */
export function modeFromParam(value) {
  const v = String(value ?? "").trim().toLowerCase();
  const alias = { old: "puya", new: "uc25hq80", original: "original-unified", legacy: "original-unified", previous: "previous-engine", shipped: "previous-engine" }[v] ?? v;
  return modeById(alias) ?? modeById(DEFAULT_MODE);
}

/** The engine's own chip selection, before the first render and after any flash restore. Returns what was applied, or null for the original model. */
export function applyChipProfile(x, chip, timing = "typical") {
  if (!chip) return null;
  if (!(chip in CHIP_IDS)) throw new Error(`unknown flash chip ${JSON.stringify(chip)}`);
  if (!(timing in TIMING_IDS)) throw new Error(`unknown flash timing ${JSON.stringify(timing)}`);
  if (!x.fm1_flash_chip || !x.fm1_flash_timing) throw new Error("this engine has no flash chip profiles");
  if (x.fm1_flash_chip(CHIP_IDS[chip]) !== 0) throw new Error(`the engine refused flash chip ${chip}`);
  if (x.fm1_flash_timing(TIMING_IDS[timing]) !== 0) throw new Error(`the engine refused flash timing ${timing}`);
  return { chip, timing, jedec: JEDEC[chip] };
}

/** The CPU optimization (a mode with `settledLoop`: Default): switched on after the boot, on an engine that has it. The engine's own switch is off in every new boot, so a mode that does not ask for it (and a later reboot that does not) runs without it.
 *  Returns what was applied, or null when the mode does not ask for it. Never silently runs the original path when asked: an engine without the switch is an error. */
export function applyCpuOptimization(x, on) {
  if (!on) return null;
  if (typeof x.fm1_settled_loop !== "function") throw new Error("this engine has no CPU optimization switch");
  x.fm1_settled_loop(1);
  return { settledLoop: true };
}

/** What a running instance can say about its flash chip and itself. Every export is optional: the shipped engine has none of the chip ones. */
export function chipStatus(x) {
  const has = (n) => typeof x[n] === "function";
  return {
    ms: has("fm1_ms") ? x.fm1_ms() : null,
    halted: has("fm1_halted") ? x.fm1_halted() === 1 : null,
    flashRevision: has("fm1_flash_revision") ? x.fm1_flash_revision() : null,
    wip: has("fm1_flash_wip") ? x.fm1_flash_wip() === 1 : null,
    unspecified: has("fm1_flash_events") ? x.fm1_flash_events(0) : null,
    notModeled: has("fm1_flash_events") ? x.fm1_flash_events(1) : null,
    lastNotModeled: has("fm1_flash_events") ? x.fm1_flash_events(2) : null,
    uidUnknownReads: has("fm1_flash_events") ? x.fm1_flash_events(3) : null,
    hasAudioIn: has("fm1_has_audio_in") ? x.fm1_has_audio_in() === 1 : null,
    audioPending: has("fm1_audio_pending") ? x.fm1_audio_pending() : null,
    usbConfigured: has("fm1_usb_conf_len") ? x.fm1_usb_conf_len() > 0 : null,
    settledLoop: has("fm1_settled_loop_stat") ? { callsSkipped: x.fm1_settled_loop_stat(0), instructionsSkipped: x.fm1_settled_loop_stat(2), callsHeldOff: x.fm1_settled_loop_stat(5) } : null,
  };
}

const hex = (n, w = 2) => `0x${Number(n).toString(16).toUpperCase().padStart(w, "0")}`;

/** One line per fact that a run showed, for a configuration's summary (shared by the single-session report and the comparison table). */
export function describeRun(r) {
  const out = [];
  out.push(r.halted ? "the emulated CPU HALTED (a CPU fault: the firmware crashed)" : "the emulated CPU kept running");
  if (r.firstFrameMs === null) out.push("no screen content was drawn"); else out.push(`first screen content at about ${r.firstFrameMs} ms`);
  if (r.audioStarted !== undefined && r.audioStarted !== null) out.push(`audio engine: ${r.audioStarted ? "started" : "did NOT start"} (${r.audioFrames} real audio frames of ${r.audioRequested} rendered)`);
  out.push(`audible output: ${r.audioRms > 0.0005 ? "sound was produced" : "silent"} (RMS ${r.audioRms.toFixed(4)}, peak ${r.audioPeak.toFixed(3)})`);
  out.push(`flash writes: ${r.changedSectors} sector(s) written${r.changedList.length ? ` (${r.changedList.slice(0, 8).map((a) => hex(a, 5)).join(", ")}${r.changedList.length > 8 ? ", …" : ""})` : ""}`);
  return out;
}

const DISCLAIMER = [
  "How to read this report:",
  "- The Puya P25Q80H and UC25HQ80 profiles are REFERENCE models built from the manufacturers' datasheets. Neither has been confirmed to match a physical FM-1's chip,",
  "  and the physical identity of the chip in any given unit is unresolved. This report is emulator output, not a hardware measurement, and says nothing about whether",
  "  a firmware would run, brick or recover on a real FM-1.",
  "- A difference between the two chip models means the firmware behaved differently under them in this run; the cause is an inference.",
  "- Only a test on a physical unit can confirm how a firmware behaves.",
];

/**
 * The text of the comparison report: only what concerns the firmware under test (no engine, app, counter or live-session detail). `d`:
 *   generated      ISO time string (the caller's clock)
 *   firmware       { id, name, sha256 }
 *   comparison     { seconds, timing, rows: [{ label, chip, result: <describeRun input>, error? }], chipDifferences: [text], verdict }; only rows with a `chip` are listed
 */
export function buildReport(d) {
  const L = [];
  const push = (s = "") => L.push(s);
  push("FM-1 EMULATOR FLASH CHIP REPORT");
  push(`generated: ${d.generated}`);
  push();
  push("FIRMWARE");
  push(`  name: ${d.firmware?.name ?? "(none loaded)"}`);
  if (d.firmware?.id) push(`  id: ${d.firmware.id}`);
  if (d.firmware?.sha256) push(`  package sha256: ${d.firmware.sha256}`);
  push();
  if (d.comparison) {
    push(`COMPARISON (same firmware, same inputs, nothing pressed, ${d.comparison.seconds} s of emulated time each${d.comparison.timing ? `, ${d.comparison.timing} cycle times` : ""})`);
    if (d.comparison.verdict) for (const line of verdictLines(d.comparison.verdict)) push(line);
    for (const row of d.comparison.rows.filter((r) => r.chip)) {
      push(`  [${row.label}]`);
      if (row.error) push(`    could not run: ${row.error}`);
      else for (const line of describeRun(row.result)) push(`    ${line}`);
    }
    push("  differences between the two chips:");
    const diffs = d.comparison.chipDifferences ?? [];
    if (diffs.length) for (const t of diffs) push(`    - ${t}`); else push("    - none seen in what was compared");
    push();
  }
  for (const t of DISCLAIMER) push(t);
  return L.join("\n") + "\n";
}

/** What differs between a reference row and another ({ label, result }), as short statements. `direct`: the two are the profiles being compared with each other, so the per-chip counters are reported for both. */
export function comparePair(refRow, row, direct = false, scope = "") {
  const a = refRow.result, b = row.result, tag = `${scope ? `[${scope}] ` : ""}${row.label} vs ${refRow.label}`, out = [];
  if (a.audioStarted !== undefined && a.audioStarted !== null && a.audioStarted !== b.audioStarted) {
    const what = b.audioStarted ? "started here but not in the reference" : "started in the reference but not here";
    out.push(`${tag}: the audio engine ${what}${scope === "engine" ? " (an engine difference: the flash model is the same in both)" : scope === "chip" ? " (same engine, only the flash model differs)" : ""}`);
  }
  if (a.halted !== b.halted) out.push(`${tag}: ${b.halted ? "the CPU halted (crashed) here but not in the reference" : "the reference halted (crashed) but this configuration did not"}`);
  if (a.lcdHash !== b.lcdHash) out.push(`${tag}: the screen differs at the end of the run`);
  if ((a.audioRms > 0.0005) !== (b.audioRms > 0.0005)) out.push(`${tag}: ${b.audioRms > 0.0005 ? "sound was produced here but not in the reference" : "silent here but sound in the reference"}`);
  if (a.changedSectors !== b.changedSectors || a.changedList.join() !== b.changedList.join()) out.push(`${tag}: flash writes differ (${b.changedSectors} sector(s) here, ${a.changedSectors} in the reference)`);
  if (direct && (a.changedSectors !== b.changedSectors || a.changedList.join() !== b.changedList.join())) out.push(`${tag}: possible cause (an inference, not verified): the firmware may check the chip's JEDEC ID, which is ${hex(JEDEC.puya[0])} ${hex(JEDEC.puya[1])} ${hex(JEDEC.puya[2])} on the Puya profile and ${hex(JEDEC.uc25hq80[0])} ${hex(JEDEC.uc25hq80[1])} ${hex(JEDEC.uc25hq80[2])} on the UC25HQ80 profile, or react to a chip behaviour that differs between the two models`);
  if (a.firstFrameMs !== b.firstFrameMs && (a.firstFrameMs === null || b.firstFrameMs === null)) out.push(`${tag}: screen content appeared in only one of them`);
  if (direct && (a.unspecified !== b.unspecified || a.notModeled !== b.notModeled)) out.push(`${tag}: the chip commands differ (unspecified ${b.unspecified} vs ${a.unspecified}, outside the model ${b.notModeled} vs ${a.notModeled})`);
  return out;
}

/**
 * The comparison, in scopes that keep the engine apart from the flash chip. `rows`: { def, original, puya, uc } (each { label, result } or with an error):
 *   [engine]  the Default engine against the same firmware on the unified engine with the original flash model (nothing about the flash chip changes between them)
 *   [chip]    each flash profile against the original flash model on the SAME engine, and the two profiles against each other
 * A profile is never compared with Default: that pair differs in both the engine and the chip, so a difference there could not be attributed.
 */
export function compareScoped({ def, original, puya, uc }) {
  const out = [];
  if (def?.result && original?.result) out.push(...comparePair(def, original, false, "engine"));
  for (const p of [puya, uc]) {
    if (!p?.result) continue;
    if (original?.result) out.push(...comparePair(original, p, false, "chip"));
    const b = p.result;
    if (b.unspecified) out.push(`[chip] ${p.label}: ${b.unspecified} command(s) the datasheets leave unspecified were issued and ignored`);
    if (b.notModeled) out.push(`[chip] ${p.label}: ${b.notModeled} opcode(s) outside the model were issued (last ${hex(b.lastNotModeled)})`);
  }
  if (puya?.result && uc?.result) out.push(...comparePair(puya, uc, true, "chip"));
  return out;
}

// ---- the verdict of a comparison, in plain words (the Compare chips result card and the top of the report's comparison)
/** The closing line of every verdict. */
export const VERDICT_CLOSING = "This is a model, not a real unit. Only Default mode saves; the chip models keep nothing, so this shows only whether the firmware wrote to flash on each one.";
const ASK_NEWER = "Check which chip your FM-1 has using a tool like M-Flasher. If it's the newer one, ask the firmware's author whether it supports it.";
const ASK_OLDER = "Check which chip your FM-1 has using a tool like M-Flasher. If it's the older one, ask the firmware's author whether it supports it.";
/** Started: the CPU did not halt and the screen was drawn. Wrote: the firmware wrote to the flash. Both are what the comparison measured in its few seconds, nothing more. */
const startedOn = (r) => !!r && r.halted !== true && r.firstFrameMs !== null && r.firstFrameMs !== undefined;
const wroteOn = (r) => !!r && r.changedSectors > 0;
const chipRow = (label, row) => {
  if (!row || row.error) return { label, state: "error", text: "could not run" };
  const r = row.result;
  if (!startedOn(r)) return { label, state: "did-not-start", text: r.halted ? "did not start (the CPU halted)" : "did not start" };
  return wroteOn(r) ? { label, state: "wrote", text: "started, wrote to flash" } : { label, state: "no-write", text: "started, no flash write" };
};
/**
 * The plain-language verdict of a comparison. `rows`: { original, puya, uc } (each { label, result } or { label, error }; original is the same engine with the original flash model).
 * It says what the model did in the comparison's few seconds with nothing pressed, never that a firmware works or is compatible. Returns { key, tone, headline, meaning, reasons, next, rows, closing }.
 */
export function chipVerdict({ original, puya, uc }) {
  const rows = [chipRow("Older chip", puya), chipRow("Newer chip", uc)];
  const base = { rows, closing: VERDICT_CLOSING };
  const failed = [["older", puya], ["newer", uc]].find(([, row]) => !row || row.error);
  if (failed) {
    return { ...base, key: "error", tone: "info", headline: "Couldn't compare on one chip.", reasons: "",
      meaning: `The comparison could not run on the ${failed[0]} chip model${failed[1]?.error ? `: ${failed[1].error}` : ""}.`, next: "Try again, or load the firmware in Default to see whether it runs there." };
  }
  const o = startedOn(puya.result), n = startedOn(uc.result), so = wroteOn(puya.result), sn = wroteOn(uc.result);
  const plain = wroteOn(original?.result), plainStarted = startedOn(original?.result);
  if (!o && !n) {
    return { ...base, key: "neither-start", tone: "bad", headline: "Didn't start on either chip.", meaning: "The cause may not be the chip.",
      reasons: plainStarted ? "It starts with the emulator's plain flash model, so the chip models are changing the result." : "", next: "Load it in Default first, to see whether it runs there." };
  }
  if (o !== n) {
    const which = o ? "newer" : "older";
    return { ...base, key: `${which}-no-start`, tone: "bad", headline: `Didn't start on the ${which} chip.`, meaning: "The firmware stopped or showed nothing on that chip model.", reasons: "",
      next: "Compare it against Default to see whether the chip or the emulator is the cause." };
  }
  if (so && sn) {
    return { ...base, key: "both", tone: "ok", headline: "Started and wrote to flash on both chips.", reasons: "",
      meaning: "In this test the firmware behaved the same on both chips. That's a good sign, but this test only runs a few seconds with nothing pressed.",
      next: "If it only writes to flash after you press something, test that by hand on the chip you care about." };
  }
  if (so) {
    return { ...base, key: "older-only", tone: "warn", headline: "Wrote to flash on the older chip, but not on the newer one.",
      meaning: "This firmware wrote to flash when it ran on the older chip model, but not on the newer one. It may behave differently on an FM-1 with the newer chip.",
      reasons: "It may only accept the older chip's ID, or may not wait long enough for the newer chip.", next: ASK_NEWER };
  }
  if (sn) {
    return { ...base, key: "newer-only", tone: "warn", headline: "Wrote to flash on the newer chip, but not on the older one.",
      meaning: "The reverse of the usual problem: this firmware may behave differently on an FM-1 with the older chip.",
      reasons: "It may only accept the newer chip's ID, or may not wait long enough for the older chip.", next: ASK_OLDER };
  }
  return { ...base, key: "none", tone: "info", headline: "No flash write on either chip.",
    meaning: "That doesn't mean it failed. Many firmware only write to flash after you press a key or change a setting, and this test presses nothing.",
    reasons: plain ? "It wrote to flash with the emulator's plain flash model, so the chip models are changing the result." : "",
    next: "Use the firmware in a chip mode yourself and make a change to see whether it behaves differently. Saving itself can only be tested on a real unit." };
}
/** The verdict as report lines. */
export function verdictLines(v) {
  const L = [`  VERDICT: ${v.headline}`, `    ${v.meaning}`];
  if (v.reasons) L.push(`    Possible reasons: ${v.reasons}`);
  L.push(`    What to try: ${v.next}`);
  if (v.code) L.push(`    Code check: ${v.code.text}`, `    ${CODE_CHECK_NOTE}`);
  for (const r of v.rows) L.push(`    ${r.label}: ${r.text}`);
  L.push(`    ${v.closing}`);
  return L;
}

// ---- the code check: which of the two flash chips' IDs does the firmware's own code contain?
// Validated on the 277 bundled packages (audio-audit/codeid, 6 s of emulated time per chip model, nothing pressed): of 108 firmware whose code has both IDs none saved on one chip and not the other;
// of the 31 whose code has only the older ID and that saved on the older chip model, 29 did not save on the newer one (2 did); all 29 firmware whose save differed between the chip models were of that kind;
// no bundled firmware has only the newer ID; the 6 with neither ID behaved the same on both. The other "older ID only" firmware did not save at all in that window, so they say nothing either way.
export const CODE_CHECK_NOTE = "Reading the code is an indication, not proof: it shows which IDs the code contains, not what it does with them.";
export const CODE_CHECK_TEXT = {
  both: "This firmware's code recognises both chips' IDs.",
  "older-only": "This firmware's code recognises only the older chip's ID, so it may not support the newer chip.",
  "newer-only": "This firmware's code recognises only the newer chip's ID, so it may not support the older chip.",
  neither: "This firmware's code doesn't contain either chip's ID, so it probably doesn't check the chip.",
  unreadable: "Couldn't read this firmware's code.",
};
export const CODE_AGREES = " Both the test and the code point the same way.";
/** Count the older (85 60 14) and newer (B3 60 14) JEDEC ID byte sequences in a firmware's decoded app image (a Uint8Array), as stored in either byte order (a 32-bit constant holds them reversed). */
export function countChipIds(app) {
  let older = 0, newer = 0;
  for (let i = 0; i + 3 <= app.length; i++) {
    if (app[i + 1] !== 0x60) continue;
    const a = app[i], c = app[i + 2];
    if ((a === 0x85 && c === 0x14) || (a === 0x14 && c === 0x85)) older++;
    else if ((a === 0xb3 && c === 0x14) || (a === 0x14 && c === 0xb3)) newer++;
  }
  return { older, newer };
}
export const classifyChipIds = ({ older, newer }) => (older > 0 && newer > 0 ? "both" : older > 0 ? "older-only" : newer > 0 ? "newer-only" : "neither");
/** Add the code check to a verdict: `cls` is classifyChipIds(...) or null when the code could not be read. The test and the code are said to agree only when both name the same chip as the only one that saved. */
export function withCodeCheck(v, cls) {
  if (!v) return v;
  const key = cls && CODE_CHECK_TEXT[cls] ? cls : "unreadable";
  const agrees = (key === "older-only" && v.key === "older-only") || (key === "newer-only" && v.key === "newer-only");
  return { ...v, code: { class: key, text: CODE_CHECK_TEXT[key] + (agrees ? CODE_AGREES : ""), agrees } };
}
