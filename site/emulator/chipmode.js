// Emulation modes and the diagnostic report (Component 8, Stage 2). Plain functions, no DOM: the page, the worker and the Node tests (ci/chip-mode-tests.mjs) import it.
//
// Default is the original application: the shipped engine (fm1_web.wasm), its saves, nothing changed. The other modes run the same firmware on the unified engine
// (fm1_web_unified.wasm: the chip-profile engine with the USB host and USB audio in), where the FM-1's SPI flash is a datasheet-based model, the Puya P25Q80H
// reference profile (the older FM-1s) or the UC25HQ80 (the newer ones), with the chip's own status register, write enable, busy (WIP), protection, page wrap and
// cycle times. Both are REFERENCE profiles built from datasheets; neither has been confirmed to match a physical FM-1's chip.
//
// A chip-test session is EPHEMERAL: it starts from the package's own flash, never reads the user's saved patches and never writes them (main.js).

export const ENGINE_FILES = {
  shipped: { file: "fm1_web.wasm", v: 25 },
  unified: { file: "fm1_web_unified.wasm", v: 1 },
};

/** id: the select's value and the `?mode=` parameter. engine: which wasm runs it. chip: null (the original flash model) or the profile name fm1_flash_chip takes. */
export const MODES = [
  { id: "default", label: "Default (original engine)", engine: "shipped", chip: null, test: false,
    note: "The application as it was: the original engine and flash model, your saved patches." },
  { id: "puya", label: "Older FM-1 flash: Puya P25Q80H profile", engine: "unified", chip: "puya", test: true,
    note: "Test mode. Datasheet-based reference profile of the older units' flash chip (JEDEC 85 60 14). Starts from the package's own flash; nothing is saved." },
  { id: "uc25hq80", label: "Newer FM-1 flash: UC25HQ80 profile", engine: "unified", chip: "uc25hq80", test: true,
    note: "Test mode. Datasheet-based reference profile of the newer units' flash chip (JEDEC B3 60 14). Starts from the package's own flash; nothing is saved." },
  { id: "original-unified", label: "Original flash model on the unified engine (reference)", engine: "unified", chip: null, test: true,
    note: "Test mode. The unified engine with the original instantaneous flash model: the baseline to compare the chip profiles against. Nothing is saved." },
];
export const TIMINGS = [{ id: "typical", label: "typical cycle times" }, { id: "maximum", label: "maximum cycle times" }];
export const CHIP_IDS = { puya: 1, uc25hq80: 2 };
export const TIMING_IDS = { typical: 0, maximum: 1 };
export const JEDEC = { puya: [0x85, 0x60, 0x14], uc25hq80: [0xb3, 0x60, 0x14] };
export const DEFAULT_MODE = "default";

export const modeById = (id) => MODES.find((m) => m.id === id) ?? null;
/** The mode a `?mode=` value names (case-insensitive; "old" and "new" as the harness's aliases), or the default. */
export function modeFromParam(value) {
  const v = String(value ?? "").trim().toLowerCase();
  const alias = { old: "puya", new: "uc25hq80", original: "original-unified", legacy: "original-unified" }[v] ?? v;
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
  };
}

const hex = (n, w = 2) => `0x${Number(n).toString(16).toUpperCase().padStart(w, "0")}`;
const yn = (v) => (v === null || v === undefined ? "not available on this engine" : v ? "yes" : "no");

/** One line per fact that a run showed, for a configuration's summary (shared by the single-session report and the comparison table). */
export function describeRun(r) {
  const out = [];
  out.push(r.halted ? "the emulated CPU HALTED (a CPU fault: the firmware crashed)" : "the emulated CPU kept running");
  if (r.firstFrameMs === null) out.push("no screen content was drawn"); else out.push(`first screen content at about ${r.firstFrameMs} ms`);
  out.push(`audio: ${r.audioRms > 0.0005 ? "sound was produced" : "silent"} (RMS ${r.audioRms.toFixed(4)}, peak ${r.audioPeak.toFixed(3)})`);
  out.push(`flash: ${r.changedSectors} sector(s) changed from the package's flash${r.changedList.length ? ` (${r.changedList.slice(0, 8).map((a) => hex(a, 5)).join(", ")}${r.changedList.length > 8 ? ", …" : ""})` : ""}`);
  if (r.wipSeen !== null) out.push(`WIP (flash busy) seen: ${yn(r.wipSeen)}`);
  if (r.unspecified !== null) out.push(`chip commands the datasheets leave unspecified (ignored): ${r.unspecified}; opcodes outside the model: ${r.notModeled}${r.notModeled ? ` (last ${hex(r.lastNotModeled)})` : ""}`);
  return out;
}

const DISCLAIMER = [
  "How to read this report:",
  "- The Puya P25Q80H and UC25HQ80 profiles are REFERENCE models built from the manufacturers' datasheets. Neither has been confirmed to match a physical FM-1's chip,",
  "  and the physical identity of the chip in any given unit is unresolved. This report is emulator output, not a hardware measurement, and says nothing about whether",
  "  a firmware would run, brick or recover on a real FM-1.",
  "- \"Unspecified\" counts commands whose behaviour the datasheets leave open or contradictory: the model ignores them and counts them. \"Outside the model\" counts",
  "  opcodes the model does not implement (e.g. 4Bh unique ID has no value unless one is configured). Both point at something to look at, not at a proven fault.",
  "- A difference between profiles means the firmware behaved differently under the two models in this run; the cause (for example a JEDEC ID check) is an inference.",
];

/**
 * The text of a report. `d`:
 *   generated      ISO time string (the caller's clock)
 *   app            { name, version? }
 *   mode           a MODES entry; timing (null unless a chip profile)
 *   engine         { file, sha256, bytes? }  and  defaultEngine: { file, sha256 } when it differs
 *   firmware       { id, name, sha256 }
 *   run            { mhz, jit, status: chipStatus(...), board, ephemeral }
 *   sectors        { count, list[] }   (flash sectors changed from the package's base flash in this session)
 *   comparison     null or { seconds, rows: [{ label, result: <describeRun input>, error? }], differences: [text] }
 */
export function buildReport(d) {
  const L = [];
  const push = (s = "") => L.push(s);
  push("FM-1 EMULATOR DIAGNOSTIC REPORT");
  push(`generated: ${d.generated}`);
  push(`application: ${d.app?.name ?? "FM-1 Emulator"}${d.app?.version ? ` ${d.app.version}` : ""}`);
  push();
  push("FIRMWARE");
  push(`  name: ${d.firmware?.name ?? "(none loaded)"}`);
  if (d.firmware?.id) push(`  id: ${d.firmware.id}`);
  if (d.firmware?.sha256) push(`  package sha256: ${d.firmware.sha256}`);
  push();
  push("EMULATION MODE");
  push(`  mode: ${d.mode.label}${d.mode.test ? "  [TEST MODE: nothing is saved]" : ""}`);
  push(`  engine: ${d.engine.file}${d.engine.sha256 ? ` (sha256 ${d.engine.sha256})` : ""}`);
  if (d.mode.chip) push(`  flash chip: ${d.mode.chip === "puya" ? "Puya P25Q80H reference profile" : "UC25HQ80 reference profile"}, JEDEC ${JEDEC[d.mode.chip].map((b) => hex(b)).join(" ")}, ${d.timing ?? "typical"} cycle times`);
  else push(`  flash chip: ${d.mode.test ? "the original instantaneous flash model (no status register, no busy, no protection)" : "the original flash model of the shipped engine"}`);
  if (d.run) {
    push(`  emulated clock: ${d.run.mhz} MHz; JIT: ${d.run.jit ? "on" : "off"}; board: ${d.run.board === 1 ? "SMK-37" : "FM-1"}`);
  }
  push();
  const s = d.run?.status;
  if (s) {
    push("THIS SESSION");
    push(`  emulated time: ${s.ms === null ? "n/a" : `${(s.ms / 1000).toFixed(1)} s`}; CPU: ${s.halted ? "HALTED (CPU fault)" : s.halted === null ? "n/a" : "running"}`);
    push(`  flash write cycle (WIP) running now: ${yn(s.wip)}`);
    push(`  flash revision (counts program/erase operations accepted): ${s.flashRevision ?? "n/a"}`);
    if (s.unspecified !== null) {
      push(`  commands the datasheets leave unspecified (ignored by the model): ${s.unspecified}`);
      push(`  opcodes outside the model: ${s.notModeled}${s.notModeled ? ` (last ${hex(s.lastNotModeled)})` : ""}`);
      push(`  4Bh unique-ID reads answered without a configured ID: ${s.uidUnknownReads}`);
    } else push("  chip counters: not available (the original engine has no chip model)");
    push(`  USB audio input: ${s.hasAudioIn === null ? "n/a" : s.hasAudioIn ? "the firmware takes USB audio in" : "not used by this firmware"}${s.audioPending ? `; ${s.audioPending} bytes queued` : ""}`);
    if (d.sectors) push(`  flash sectors changed from the package's flash: ${d.sectors.count}${d.sectors.list?.length ? ` (${d.sectors.list.slice(0, 16).map((a) => hex(a, 5)).join(", ")}${d.sectors.list.length > 16 ? ", …" : ""})` : ""}`);
    push();
  }
  if (d.comparison) {
    push(`COMPARISON (same firmware, same inputs, ${d.comparison.seconds} s of emulated time each, interpreter)`);
    for (const row of d.comparison.rows) {
      push(`  [${row.label}]`);
      if (row.error) push(`    could not run: ${row.error}`);
      else for (const line of describeRun(row.result)) push(`    ${line}`);
    }
    push("  differences:");
    if (d.comparison.differences.length) for (const t of d.comparison.differences) push(`    - ${t}`); else push("    - none seen in what was compared");
    push();
  }
  for (const t of DISCLAIMER) push(t);
  return L.join("\n") + "\n";
}

/** What differs between a reference row and another ({ label, result }), as short statements. `direct`: the two are the profiles being compared with each other, so the per-chip counters are reported for both. */
export function comparePair(refRow, row, direct = false) {
  const a = refRow.result, b = row.result, tag = `${row.label} vs ${refRow.label}`, out = [];
  if (a.halted !== b.halted) out.push(`${tag}: ${b.halted ? "the CPU halted (crashed) here but not in the reference" : "the reference halted (crashed) but this configuration did not"}`);
  if (a.lcdHash !== b.lcdHash) out.push(`${tag}: the screen differs at the end of the run`);
  if ((a.audioRms > 0.0005) !== (b.audioRms > 0.0005)) out.push(`${tag}: ${b.audioRms > 0.0005 ? "sound was produced here but not in the reference" : "silent here but sound in the reference"}`);
  if (a.changedSectors !== b.changedSectors || a.changedList.join() !== b.changedList.join()) out.push(`${tag}: flash writes differ (${b.changedSectors} sector(s) here, ${a.changedSectors} in the reference)`);
  if (direct && (a.changedSectors !== b.changedSectors || a.changedList.join() !== b.changedList.join())) out.push(`${tag}: possible cause (an inference, not verified): the firmware may check the chip's JEDEC ID, which is ${hex(JEDEC.puya[0])} ${hex(JEDEC.puya[1])} ${hex(JEDEC.puya[2])} on the Puya profile and ${hex(JEDEC.uc25hq80[0])} ${hex(JEDEC.uc25hq80[1])} ${hex(JEDEC.uc25hq80[2])} on the UC25HQ80 profile, or react to a chip behaviour that differs between the two models`);
  if (a.firstFrameMs !== b.firstFrameMs && (a.firstFrameMs === null || b.firstFrameMs === null)) out.push(`${tag}: screen content appeared in only one of them`);
  if (direct && (a.unspecified !== b.unspecified || a.notModeled !== b.notModeled)) out.push(`${tag}: the chip commands differ (unspecified ${b.unspecified} vs ${a.unspecified}, outside the model ${b.notModeled} vs ${a.notModeled})`);
  return out;
}

/** What differs between a run and the first (the reference), for each other one that ran; counters of ignored/unmodelled chip commands are noted for the chip profiles. */
export function compareRuns(rows) {
  const ok = rows.filter((r) => r.result);
  if (ok.length < 2) return [];
  const out = [];
  for (const r of ok.slice(1)) {
    out.push(...comparePair(ok[0], r));
    const b = r.result;
    if (b.unspecified) out.push(`${r.label}: ${b.unspecified} command(s) the datasheets leave unspecified were issued and ignored`);
    if (b.notModeled) out.push(`${r.label}: ${b.notModeled} opcode(s) outside the model were issued (last ${hex(b.lastNotModeled)})`);
  }
  return out;
}
