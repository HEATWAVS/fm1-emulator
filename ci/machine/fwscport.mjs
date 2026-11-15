// A JavaScript port of the flash-image rules of the emulator's own package unpacker (ci/engine upstream crates/fm1-soc/src/fwsc.rs), for the boot-area
// diagnostic (Component 7). EVIDENCE LEVEL: EMULATOR. Every function here reproduces what fwsc.rs does on a package's flash image, including its
// unchecked-key fallback (a bad isd_config.ini CRC does NOT refuse a package: the key is then taken unchecked). It says what THIS EMULATOR's unpacker does and nothing
// about the mask ROM, the SPL or a physical FM-1. Validated against the engine (ci/machine/fwscportcheck.mjs); see docs/dev/BOOT-AREA.md.
//
// Pure functions over byte arrays: no engine, no machine, no I/O.
export const le16 = (b, o) => b[o] | (b[o + 1] << 8);
export const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export function unmask(buf, from, n, key) {
  for (let i = 0; i < n; i++) {
    buf[from + i] ^= key & 0xff;
    key = ((key << 1) ^ (key & 0x8000 ? 0x1021 : 0)) & 0xffff;      // Rust: (key << 1) ^ poly on u16 (wrapping shift)
  }
}
export function crc16(buf, from, n) {
  let crc = 0;
  for (let i = 0; i < n; i++) {
    crc ^= buf[from + i] << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
/** fwsc.rs container(): the number of 0x30-byte header blocks. */
export function container(file) {
  const marker = (i) => (i * 0x30 + 0x2f < file.length ? file[i * 0x30 + 0x2f] : undefined);
  let n = 0;
  for (;;) { const m = marker(n); if (m === undefined) break; if (n >= 20 && m !== 0x7d) break; n++; }
  return n;
}
/** fwsc.rs raw_flash_n(): the flash image inside a package, as stored. */
export function rawFlash(file, blocks = container(file)) {
  if (file.length < blocks * 0x30 || blocks < 20) throw new Error("too short");
  const hdr = new Uint8Array(blocks * 0x2f);
  for (let i = 0; i < blocks; i++) hdr.set(file.subarray(i * 0x30, i * 0x30 + 0x2f), i * 0x2f);
  unmask(hdr, 0, 0x40, 0xffff);
  if (crc16(hdr, 2, 0x3e) !== le16(hdr, 0)) throw new Error("package header CRC");
  const count = le16(hdr, 8);
  for (let k = 0; k < count; k++) {
    const at = 0x40 + k * 0x50;
    if (at + 0x50 > hdr.length) break;
    const e = hdr.slice(at, at + 0x50);
    unmask(e, 0, 0x50, 0xffff);
    if (le16(e, 0) === 0) {
      const off = le32(e, 8), len = le32(e, 12);
      const stream = new Uint8Array(hdr.length + file.length - blocks * 0x30);
      stream.set(hdr); stream.set(file.subarray(blocks * 0x30), hdr.length);
      if (off + len > stream.length) throw new Error("truncated");
      return stream.slice(off, off + len);
    }
  }
  throw new Error("no flash image");
}
/** fwsc.rs head(): a 32-byte JLFS head that is already unmasked, at `o`. */
export function head(b, o) {
  let name = "";
  for (let i = 0; i < 16 && b[o + 16 + i] !== 0; i++) name += String.fromCharCode(b[o + 16 + i]);
  return { name, offset: le32(b, o + 4), size: le32(b, o + 8), flags: b[o + 12], last: le16(b, o + 14) !== 0 };
}
/** fwsc.rs chip_key(): the 16-bit key from isd_config.ini's 32-byte blob. */
export function chipKey(blob) {
  let sum = 0; for (let i = 0; i < 16; i++) sum += blob[i]; sum &= 0xff;
  if (sum >= 0xe0) sum = 0xaa; else if (sum <= 0x10) sum = 0x55;
  let key = 0;
  for (let i = 0; i < 16; i++) if ((blob[16 + i] ^ blob[15 - i]) < sum) key |= 1 << i;
  return key;
}
/** fwsc.rs unscramble(). */
export function unscramble(buf, from, len, base, key) {
  for (let i = 0; i < len; i += 32) {
    const n = Math.min(32, len - i);
    unmask(buf, from + i, n, (key ^ ((from + i - base) >> 2)) & 0xffff);
  }
}
/**
 * fwsc.rs unpack_n(), reproduced including the unchecked-key fallback. Works on a COPY of the flash. Returns
 * { ok, error, key, keyChecked, keyFromFallback, area, size, dir, xip, entries } where `xip` is the app area unscrambled from its start.
 */
export function unpackFlash(rawFlashImage) {
  const flash = rawFlashImage.slice();
  let key = null, area = null, keyUnchecked = null, keyChecked = null;
  const entries = [];
  let o = 32;
  while (o + 32 <= flash.length) {
    unmask(flash, o, 32, 0xffff);
    const h = head(flash, o);
    entries.push({ at: o, ...h });
    if (h.name === "isd_config.ini" && h.offset + 34 <= flash.length) {
      const k = chipKey(flash.subarray(h.offset, h.offset + 32));
      if (crc16(flash, h.offset, 32) === le16(flash, h.offset + 32)) keyChecked = k; else keyUnchecked = k;
    }
    if (h.name === "app_dir_head" && h.flags === 0x81 && area === null) area = h.offset;
    if (h.last) break;
    o += 32;
  }
  // Rust: key.or(key_unchecked): the LAST checked key wins over any unchecked (key = Some(k) is overwritten per match; keep last checked), else the last unchecked
  key = keyChecked ?? keyUnchecked;
  if (key === null || area === null) return { ok: false, error: "no chip key or app area in the flash image", entries };
  const first = ((area + 32 + 31) & ~31) - area;
  unscramble(flash, area, first, area, key);
  const size = head(flash, area).size;
  if (area + size > flash.length) return { ok: false, error: "app area runs past the flash image", entries, key, area, size };
  if (size > first) unscramble(flash, area + first, size - first, area, key);
  return { ok: true, key, keyChecked: keyChecked !== null, keyFromFallback: keyChecked === null, area, size, entries, xip: flash.slice(area, area + size) };
}
