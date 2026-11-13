// Flash toolkit for the headless machine harness: sector records, diffs and deliberate corruption.
// Pure functions on byte arrays; no engine, no files.
//
// The record format is the one the engine's fm1_flash_restore accepts and the app saves
// (site/emulator/persistence.js packSectors): per 4 KiB sector, a 4-byte little-endian offset
// followed by the 4096 sector bytes.
export const SECTOR = 4096;
export const FLASH_SIZE = 1 << 20;
export const RECORD = SECTOR + 4;
export const MAX_RECORDS = FLASH_SIZE / SECTOR;

export function packRecords(sectors) {
  if (sectors.length > MAX_RECORDS) throw new Error("too many sectors");
  const out = new Uint8Array(sectors.length * RECORD);
  const seen = new Set();
  sectors.forEach((s, i) => {
    if (s.at % SECTOR || s.at < 0 || s.at >= FLASH_SIZE) throw new Error(`bad sector offset 0x${s.at.toString(16)}`);
    if (s.data.length !== SECTOR) throw new Error("a sector is exactly 4096 bytes");
    if (seen.has(s.at)) throw new Error(`sector 0x${s.at.toString(16)} listed twice`);
    seen.add(s.at);
    new DataView(out.buffer).setUint32(i * RECORD, s.at, true);
    out.set(s.data, i * RECORD + 4);
  });
  return out;
}

export function unpackRecords(bytes) {
  if (bytes.length % RECORD) throw new Error("flash record file is not a whole number of 4100-byte records");
  const sectors = [];
  for (let o = 0; o < bytes.length; o += RECORD) {
    sectors.push({ at: new DataView(bytes.buffer, bytes.byteOffset + o, 4).getUint32(0, true), data: bytes.slice(o + 4, o + RECORD) });
  }
  packRecords(sectors); // validates offsets, sizes and duplicates
  return sectors;
}

/** Sectors of `flash` that differ from `base`, as records. */
export function diffSectors(flash, base) {
  const out = [];
  for (let at = 0; at < FLASH_SIZE; at += SECTOR) {
    for (let i = 0; i < SECTOR; i++) {
      if (flash[at + i] !== base[at + i]) { out.push({ at, data: flash.slice(at, at + SECTOR) }); break; }
    }
  }
  return out;
}

// ---------------------------------------------------------------- corruption
// Spec strings (CLI and tests):  zero:ADDR[:LEN]   erase:ADDR[:LEN]   flip:ADDR:LEN:COUNT[:SEED]
//   zero  - bytes become 0x00      erase - bytes become 0xFF (an erased NOR flash)
//   flip  - COUNT single-bit flips at seeded pseudo-random places inside [ADDR, ADDR+LEN)
// ADDR/LEN accept decimal or 0x hex. LEN defaults to one sector.
const num = (s, what) => {
  const v = Number(s);
  if (!Number.isInteger(v) || v < 0) throw new Error(`bad ${what}: ${s}`);
  return v;
};

export function parseCorruption(text) {
  const [kind, ...p] = String(text).split(":");
  if (kind === "zero" || kind === "erase") {
    if (p.length < 1 || p.length > 2) throw new Error(`usage ${kind}:ADDR[:LEN]`);
    return { kind, at: num(p[0], "address"), len: p[1] === undefined ? SECTOR : num(p[1], "length") };
  }
  if (kind === "flip") {
    if (p.length < 3 || p.length > 4) throw new Error("usage flip:ADDR:LEN:COUNT[:SEED]");
    return { kind, at: num(p[0], "address"), len: num(p[1], "length"), count: num(p[2], "count"), seed: p[3] === undefined ? 1 : num(p[3], "seed") };
  }
  throw new Error(`unknown corruption "${kind}" (zero, erase, flip)`);
}

function rng(seed) {                         // xorshift32: deterministic, no dependencies
  let x = (seed >>> 0) || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
}

/** Apply corruption specs to a copy of `flash`; returns the sector records that now differ. */
export function corruptSectors(flash, specs) {
  const work = flash.slice();
  for (const raw of specs) {
    const s = typeof raw === "string" ? parseCorruption(raw) : raw;
    if (s.at >= FLASH_SIZE) throw new Error(`address 0x${s.at.toString(16)} is outside the 1 MiB flash`);
    const end = Math.min(FLASH_SIZE, s.at + s.len);
    if (s.kind === "zero") work.fill(0x00, s.at, end);
    else if (s.kind === "erase") work.fill(0xff, s.at, end);
    else if (s.kind === "flip") {
      if (end <= s.at) continue;
      const next = rng(s.seed);
      for (let k = 0; k < s.count; k++) work[s.at + (next() % (end - s.at))] ^= 1 << (next() % 8);
    } else throw new Error(`unknown corruption ${s.kind}`);
  }
  return diffSectors(work, flash);
}

/** Merge record lists; later lists win for the same sector. */
export function mergeSectors(...lists) {
  const map = new Map();
  for (const list of lists) for (const s of list) map.set(s.at, s);
  return [...map.values()].sort((a, b) => a.at - b.at);
}
