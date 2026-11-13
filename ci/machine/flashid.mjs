// Selectable SPI-flash JEDEC ID for the headless harness (ID selection only; NOT chip emulation).
//
// What this is: the engine's flash model keeps the chip's 3 ID bytes in a plain field in memory.
// For ONE exact, validated engine build (engine.mjs: FLASH_ID_LAYOUTS) we find the live field and
// rewrite it right after boot, so firmware that probes the chip sees the other hardware revision.
// The engine file itself is never modified.
//
// What this is not: it does not make the engine behave like a UC25HQ80 in any other way (timing,
// status bits, other commands). Only the bytes returned by the JEDEC read (0x9F) change.
//
// Safety, in order: (1) the engine hash must be in the validated table; (2) the field is found from
// the engine's own flash pointer (fm1_flash()) with a known ID at the validated offset; (3) the engine
// leaves stale copies of its chip structure in memory, so the LIVE one is PROVEN, not guessed: write a
// sentinel into a candidate's revision word and see whether the engine's own getter
// (fm1_flash_revision) returns it; (4) exactly one live copy, and exactly the validated number of
// copies, or nothing is touched. Every probe write is undone before anything else runs.
export class FlashIdError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = "FlashIdError"; }
}

export const FLASH_IDS = {
  puya: { name: "puya", bytes: [0x85, 0x60, 0x14], part: "Puya P25Q80H" },          // older hardware
  uc25hq80: { name: "uc25hq80", bytes: [0xb3, 0x60, 0x14], part: "UC25HQ80" },      // newer hardware
};
const KNOWN = [...Object.values(FLASH_IDS).map((p) => p.bytes), [0xeb, 0x60, 0x14]];   // + the SMK-37's own, recognised not selectable
const KNOWN_NAMES = new Map([[0x856014, "puya"], [0xb36014, "uc25hq80"], [0xeb6014, "smk37"]]);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const asNumber = (b) => (b[0] << 16) | (b[1] << 8) | b[2];

/** Normalise a requested ID: "puya"/"old", "uc25hq80"/"new", or the exact hex of either. Anything else is refused. */
export function parseFlashId(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : null;
  const alias = { old: "puya", puya: "puya", p25q80: "puya", new: "uc25hq80", uc25hq80: "uc25hq80" };
  if (text && alias[text]) return FLASH_IDS[alias[text]];
  let n = null;
  if (text && /^(0x)?[0-9a-f]{6}$/.test(text)) n = parseInt(text.replace(/^0x/, ""), 16);
  else if (Array.isArray(value) && value.length === 3 && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) n = asNumber(value);
  const hit = Object.values(FLASH_IDS).find((p) => asNumber(p.bytes) === n);
  if (!hit) throw new FlashIdError("invalid-id", `unsupported flash ID ${JSON.stringify(value)}: choose puya (85 60 14) or uc25hq80 (B3 60 14)`);
  return hit;
}

const SENTINELS = [0x5a5aa5a5, 0xa5a55a5a];
const revision = (x) => x.fm1_flash_revision() >>> 0;       // the engine returns a signed i32 for a u32

// The memory ranges that hold flash/firmware bytes (a pointer-looking value there is just data).
function bigRegions(x) {
  const len = x.fm1_flash_len();
  const r = [[x.fm1_flash(), len], [x.fm1_xip(), x.fm1_xip_len()]];
  if (x.fm1_flash_base) r.push([x.fm1_flash_base(), len]);
  return r;
}

/**
 * Find the live flash-ID field. `layout` comes from the validated table. Returns
 * { address, bytes, name, candidates, copies } or throws FlashIdError (nothing is left modified).
 */
export function locateLiveFlashId(x, layout) {
  if (!layout) throw new FlashIdError("unsupported-engine", "this engine build has no validated flash-ID layout");
  const buffer = x.memory.buffer, mem = new Uint8Array(buffer), view = new DataView(buffer);
  const ptr = x.fm1_flash();
  const big = bigRegions(x);
  const at = (i) => big.some(([p, l]) => i >= p && i < p + l);

  // (2) every 4-aligned place holding the flash pointer, with a known ID at the validated offset
  const candidates = [];
  for (let c = 0; c + 4 <= mem.length; c += 4) {
    if (view.getUint32(c, true) !== ptr || at(c)) continue;
    const o = c + layout.jedecOffsetFromFlashPtr;
    if (o + 3 > mem.length) continue;
    if (KNOWN.some((k) => same(k, [mem[o], mem[o + 1], mem[o + 2]]))) candidates.push(c);
  }
  if (candidates.length !== layout.copies) {
    throw new FlashIdError("layout-mismatch", `expected ${layout.copies} chip-structure copies with a known ID at +${layout.jedecOffsetFromFlashPtr}, found ${candidates.length}`);
  }

  // (3) prove which copies are live with the engine's own getter, undoing every probe write
  const before = revision(x);
  const live = [];
  for (const c of candidates) {
    for (let d = -layout.searchWindow; d < layout.searchWindow; d += 4) {
      const w = c + d;
      if (w < 0 || w + 4 > mem.length) continue;
      const saved = view.getUint32(w, true);
      let echoed = false;
      try {
        view.setUint32(w, SENTINELS[0], true);
        if (revision(x) === SENTINELS[0]) {
          view.setUint32(w, SENTINELS[1], true);
          echoed = revision(x) === SENTINELS[1];                // two different values: no coincidence
        }
      } finally {
        view.setUint32(w, saved, true);
      }
      if (echoed) { live.push(c); break; }
    }
  }
  if (revision(x) !== before) throw new FlashIdError("probe-damage", "the liveness probe did not restore the engine's state; stop");
  if (live.length === 0) throw new FlashIdError("no-live-copy", "none of the candidate copies is the engine's live chip structure");
  if (live.length > 1) throw new FlashIdError("ambiguous", `${live.length} copies look live; refusing to guess`);

  const address = live[0] + layout.jedecOffsetFromFlashPtr;
  const bytes = [mem[address], mem[address + 1], mem[address + 2]];
  return { address, bytes, name: KNOWN_NAMES.get(asNumber(bytes)) ?? "unknown", candidates, copies: candidates.length };
}

export function readFlashId(x, layout) {
  const found = locateLiveFlashId(x, layout);
  return { bytes: found.bytes, name: found.name, address: found.address };
}

/** Write `preset` into the live field (only that copy) and read it back. Returns what changed. */
export function applyFlashId(x, layout, preset) {
  const found = locateLiveFlashId(x, layout);
  const mem = new Uint8Array(x.memory.buffer);
  const previous = found.bytes.slice();
  mem.set(preset.bytes, found.address);
  const now = [mem[found.address], mem[found.address + 1], mem[found.address + 2]];
  if (!same(now, preset.bytes)) throw new FlashIdError("write-failed", "the flash ID did not read back as written");
  return { method: "runtime-patch", address: found.address, previous, current: now, name: preset.name };
}
