#!/usr/bin/env node
// Cross-checks the JS port of the emulator's package unpacker (fwscport.mjs) against the real engine (the shipped fm1_web.wasm, through `fm1_boot_fwsc` and `fm1_xip`).
//
//   node ci/machine/fwscportcheck.mjs            the 17 surveyed firmware, every condition below
//   node ci/machine/fwscportcheck.mjs --all      the "unchanged package" condition for every catalogue package (277)
//
// Conditions (each compared with what the ENGINE does with the same package bytes):
//   unchanged        the decrypted app window the port computes equals the engine's XIP window, byte for byte
//   key-changed      one bit of isd_config.ini's 32-byte blob flipped so that the derived key differs: its CRC now fails, the unchecked key is used (fwsc.rs fallback). The port and the engine
//                    must AGREE (the same window, or both refuse the package)
//   same-key-bad-crc a blob bit flipped that leaves the derived key unchanged (the key function ignores most single-bit changes): the CRC fails, the key and the window do not change
//   crc-field-only   only the stored CRC changed: the fallback key is the same key, the window is unchanged
//   no-app-area      the app_dir_head directory entry renamed: both refuse
//   no-key-entry     the isd_config.ini directory entry renamed: both refuse
// Evidence level: EMULATOR (it compares two implementations of the same emulator rules). It says nothing about the mask ROM, the SPL or hardware.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEngine, EMULATOR_DIR } from "./engine.mjs";
import { DEFAULT_SET } from "./firmware-survey.mjs";
import { container, rawFlash, unpackFlash, chipKey, unmask, le16, le32 } from "./fwscport.mjs";

const all = process.argv.includes("--all");
const engine = await loadEngine();
const manifest = JSON.parse(readFileSync(resolve(EMULATOR_DIR, "firmwares.json"), "utf8")).firmwares.filter((e) => e.package);
const entries = all ? manifest : manifest.filter((e) => DEFAULT_SET.includes(e.id));

const engineBoot = (pkg) => {
  const x = engine.instantiate();
  const p = x.fm1_alloc(pkg.length);
  new Uint8Array(x.memory.buffer, p, pkg.length).set(pkg);
  const rc = x.fm1_boot_fwsc(p, pkg.length, 0, 0, 100);
  return rc !== 0 ? { rc } : { rc, xip: new Uint8Array(x.memory.buffer, x.fm1_xip(), x.fm1_xip_len()).slice() };
};
const equal = (a, b, n) => { for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; return true; };
/** The position in the package FILE of a byte of the flash image (the image follows the header blocks, whose markers the stream drops). */
function filePos(file, flashOffset) {
  const blocks = container(file);
  const hdr = new Uint8Array(blocks * 0x2f);
  for (let i = 0; i < blocks; i++) hdr.set(file.subarray(i * 0x30, i * 0x30 + 0x2f), i * 0x2f);
  unmask(hdr, 0, 0x40, 0xffff);
  for (let k = 0; k < le16(hdr, 8); k++) {
    const e = hdr.slice(0x40 + k * 0x50, 0x90 + k * 0x50);
    unmask(e, 0, 0x50, 0xffff);
    if (le16(e, 0) === 0) return le32(e, 8) + flashOffset - hdr.length + blocks * 0x30;
  }
  throw new Error("no flash image");
}

const T = { packages: 0, unchanged: 0, keyChanged: 0, keyChangedRefusedByBoth: 0, sameKeyBadCrc: 0, crcFieldOnly: 0, noAppArea: 0, noKeyEntry: 0, mismatches: [] };
const blobs = new Map();
for (const e of entries) {
  const pkg = new Uint8Array(readFileSync(resolve(EMULATOR_DIR, e.package)));
  T.packages++;
  const raw = rawFlash(pkg), u = unpackFlash(raw);
  const cfg = u.entries.find((h) => h.name === "isd_config.ini"), app = u.entries.find((h) => h.name === "app_dir_head");
  const base = engineBoot(pkg);
  if (u.ok && base.rc === 0 && equal(base.xip, u.xip, u.size)) T.unchanged++; else T.mismatches.push(`${e.id}: unchanged`);
  const blob = raw.slice(cfg.offset, cfg.offset + 32);
  const bk = Buffer.from(blob).toString("hex");
  const sens = blobs.get(bk) ?? { firmware: e.id, packages: 0, key: u.key, singleBitFlipsChangingTheKey: 0, singleBitFlipsLeavingTheKey: 0 };
  if (sens.packages === 0) for (let i = 0; i < 32; i++) for (let b = 0; b < 8; b++) { const t = blob.slice(); t[i] ^= 1 << b; if (chipKey(t) !== u.key) sens.singleBitFlipsChangingTheKey++; else sens.singleBitFlipsLeavingTheKey++; }
  sens.packages++; blobs.set(bk, sens);
  if (all) continue;
  let change = null, same = null;
  for (let i = 0; i < 32 && !(change && same); i++) for (let b = 0; b < 8; b++) {
    const t = blob.slice(); t[i] ^= 1 << b;
    if (chipKey(t) !== u.key) change ??= [i, b]; else same ??= [i, b];
  }
  const variant = (fn) => { const f = pkg.slice(); fn(f); return f; };
  {
    const f = variant((x) => { x[filePos(pkg, cfg.offset + change[0])] ^= 1 << change[1]; });
    const r = unpackFlash(rawFlash(f)), eb = engineBoot(f);
    const agree = (r.ok && eb.rc === 0 && equal(eb.xip, r.xip, r.size)) || (!r.ok && eb.rc !== 0);
    if (agree) { T.keyChanged++; if (!r.ok) T.keyChangedRefusedByBoth++; } else T.mismatches.push(`${e.id}: key-changed (port ok=${r.ok}, engine rc=${eb.rc})`);
  }
  {
    const f = variant((x) => { x[filePos(pkg, cfg.offset + same[0])] ^= 1 << same[1]; });
    const r = unpackFlash(rawFlash(f)), eb = engineBoot(f);
    if (r.ok && r.keyFromFallback && r.key === u.key && eb.rc === 0 && equal(eb.xip, base.xip, u.size) && equal(eb.xip, r.xip, r.size)) T.sameKeyBadCrc++; else T.mismatches.push(`${e.id}: same-key-bad-crc`);
  }
  {
    const f = variant((x) => { x[filePos(pkg, cfg.offset + 32)] ^= 0xff; });
    const r = unpackFlash(rawFlash(f)), eb = engineBoot(f);
    if (r.ok && r.keyFromFallback && r.key === u.key && eb.rc === 0 && equal(eb.xip, base.xip, u.size)) T.crcFieldOnly++; else T.mismatches.push(`${e.id}: crc-field-only`);
  }
  {
    const f = variant((x) => { x[filePos(pkg, app.at + 16)] ^= 0x20; });
    if (!unpackFlash(rawFlash(f)).ok && engineBoot(f).rc !== 0) T.noAppArea++; else T.mismatches.push(`${e.id}: no-app-area`);
  }
  {
    const f = variant((x) => { x[filePos(pkg, cfg.at + 16)] ^= 0x20; });
    if (!unpackFlash(rawFlash(f)).ok && engineBoot(f).rc !== 0) T.noKeyEntry++; else T.mismatches.push(`${e.id}: no-key-entry`);
  }
}
console.log(JSON.stringify({ mode: all ? "all catalogue packages" : "17 surveyed firmware", ...T, blobVariants: [...blobs.values()] }, null, 1));
process.exit(T.mismatches.length ? 1 : 0);
