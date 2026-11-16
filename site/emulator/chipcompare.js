// Headless comparison of one firmware package across the original engine and the two flash-chip profiles (Component 8, Stage 2). Plain ES module: the page's
// worker (chipcompare-worker.js) and the Node tests (ci/chip-mode-tests.mjs) both use it. It touches no storage and no audio device: each configuration is a fresh
// machine run for a fixed amount of emulated time with NO key presses, on the interpreter (the deterministic reference), USB plugged.
import { applyPackageResources } from "./package-resources.js?v=1";
import { applyChipProfile, chipStatus, compareRuns, comparePair } from "./chipmode.js?v=1";

const SAMPLE_RATE = 44100, QUANTUM = 128, FLASH_LEN = 1 << 20, SECTOR = 4096;
const hashU16 = (a) => { let h = 0x811c9dc5; for (let i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); };
const coloursOf = (a) => { const s = new Set(); for (let i = 0; i < a.length && s.size < 64; i++) s.add(a[i]); return s.size; };

/** The sector addresses where `flash` differs from `base` (both Uint8Array of the whole 1 MiB flash). */
export function changedSectorList(base, flash) {
  const out = [];
  for (let at = 0; at < FLASH_LEN; at += SECTOR) {
    for (let i = at; i < at + SECTOR; i++) if (flash[i] !== base[i]) { out.push(at); break; }
  }
  return out;
}

/**
 * Run one configuration. `module`: a compiled WebAssembly.Module of the engine. `chip`: null (the engine's original flash model), "puya" or "uc25hq80".
 * Returns the facts of the run (see chipmode.js describeRun); throws if the package is rejected, the board is not the FM-1's, or the engine has no chip model.
 */
export async function runConfig({ module, pkg, mhz = 100, chip = null, timing = "typical", seconds = 3, usb = true }) {
  const instance = await WebAssembly.instantiate(module, { env: { fm1_jit_compile: () => 0 } });
  const x = instance.exports ?? instance.instance.exports;
  x.fm1_jit(0, 16);
  x.fm1_ahead?.(1024);
  const p = x.fm1_alloc(pkg.length);
  new Uint8Array(x.memory.buffer, p, pkg.length).set(pkg);
  if (x.fm1_boot_fwsc(p, pkg.length, 0, 0, mhz) !== 0) throw new Error("not an FM-1 update package");
  applyPackageResources(x, pkg.buffer.slice(pkg.byteOffset, pkg.byteOffset + pkg.byteLength));
  if (usb) x.fm1_usb_plug?.();
  if (chip && x.fm1_board() !== 0) throw new Error("flash chip profiles are for the FM-1 board only");
  const applied = applyChipProfile(x, chip, timing);
  const base = new Uint8Array(x.memory.buffer, x.fm1_flash_base(), x.fm1_flash_len()).slice();
  const quanta = Math.ceil((seconds * SAMPLE_RATE) / QUANTUM), step = Math.round(SAMPLE_RATE * 0.05 / QUANTUM);   // look at the screen every 50 ms
  let sumSq = 0, n = 0, peak = 0, firstFrameMs = null, wipSeen = x.fm1_flash_wip ? false : null;
  for (let i = 0; i < quanta; i++) {
    if (x.fm1_halted()) break;
    x.fm1_render(QUANTUM, 4_000_000);
    const l = new Float32Array(x.memory.buffer, x.fm1_out_l(), QUANTUM);
    for (let k = 0; k < QUANTUM; k++) { const v = l[k]; sumSq += v * v; if (Math.abs(v) > peak) peak = Math.abs(v); }
    n += QUANTUM;
    if (x.fm1_flash_wip && !wipSeen && x.fm1_flash_wip() === 1) wipSeen = true;
    if (firstFrameMs === null && i % step === 0 && coloursOf(new Uint16Array(x.memory.buffer, x.fm1_lcd(), 240 * 240)) > 1) firstFrameMs = Math.round((n * 1000) / SAMPLE_RATE);
  }
  const lcd = new Uint16Array(x.memory.buffer, x.fm1_lcd(), 240 * 240);
  const flash = new Uint8Array(x.memory.buffer, x.fm1_flash(), x.fm1_flash_len());
  const list = changedSectorList(base, flash), st = chipStatus(x);
  return {
    chip: applied, emulatedMs: st.ms, halted: st.halted === true, firstFrameMs, audioRms: n ? Math.sqrt(sumSq / n) : 0, audioPeak: peak,
    lcdHash: hashU16(lcd), lcdColours: coloursOf(lcd), changedSectors: list.length, changedList: list, wipSeen,
    unspecified: st.unspecified, notModeled: st.notModeled, lastNotModeled: st.lastNotModeled, uidUnknownReads: st.uidUnknownReads,
    flashRevision: st.flashRevision, hasAudioIn: st.hasAudioIn,
  };
}

/**
 * The comparison: the original engine, then the unified engine under the Puya and the UC25HQ80 profiles. `engines`: { shipped: Module, unified: Module }.
 * Returns { seconds, rows: [{ label, result | error }], differences: [text] }. A configuration that cannot run is reported, never skipped silently.
 */
export async function runComparison({ engines, pkg, mhz = 100, seconds = 3, timing = "typical", onProgress = () => {} }) {
  const plan = [
    { label: "Default (original engine)", module: engines.shipped, chip: null },
    { label: "Older FM-1 flash: Puya P25Q80H profile", module: engines.unified, chip: "puya" },
    { label: "Newer FM-1 flash: UC25HQ80 profile", module: engines.unified, chip: "uc25hq80" },
  ];
  const rows = [];
  for (const [i, c] of plan.entries()) {
    onProgress(`${i + 1} of ${plan.length}: ${c.label}`);
    try { rows.push({ label: c.label, result: await runConfig({ module: c.module, pkg, mhz, chip: c.chip, timing, seconds }) }); }
    catch (error) { rows.push({ label: c.label, error: String(error?.message ?? error) }); }
  }
  const differences = compareRuns(rows);
  const puya = rows[1], uc = rows[2];
  if (puya.result && uc.result) differences.push(...comparePair(puya, uc, true));
  return { seconds, timing, rows, differences };
}
