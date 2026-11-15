#!/usr/bin/env node
// The boot-area diagnostic's scenarios and its committed layout fixture (Component 7, Stage 7B). Every result is an emulator-defined diagnostic (bootarea.mjs), never a statement about
// a physical FM-1.
//
//   node ci/machine/bootareacatalogue.mjs            check that ci/machine/fixtures/bootarea-layout.json is exactly what the 277 catalogue packages yield (exit 1 if not)
//   node ci/machine/bootareacatalogue.mjs --write    regenerate it
//
// The fixture stores structure only (offsets, sizes, counts, 8-hex SHA-256 prefixes of the SPL bodies and the decode status of each body from the static scan): no firmware bytes.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EMULATOR_DIR } from "./engine.mjs";
import { rawFlash, unmask, head, chipKey, unscramble } from "./fwscport.mjs";
import { deriveLayout, FLASH_BYTES, REGION_ORDER, BOOT_AREA_REGIONS, BOOT_CODE_REGIONS, KEY_SECTOR, SPL_STATUS } from "./bootarea.mjs";

export const LAYOUT_VERSION = 1;
export const LAYOUT_PATH = resolve(import.meta.dirname, "fixtures/bootarea-layout.json");
export const SPL_FINDINGS_PATH = resolve(import.meta.dirname, "fixtures/bootarea-spl-findings.json");
const sha8 = (u8) => createHash("sha256").update(u8).digest("hex").slice(0, 8);

/** The package's flash image padded with 0xFF to the 1 MiB flash. (The engine's own flash also holds data outside the package's image; the machine adapter uses the engine's base flash.) */
export function paddedFlash(pkg) {
  const raw = rawFlash(pkg), out = new Uint8Array(FLASH_BYTES).fill(0xff);
  out.set(raw);
  return out;
}

export function catalogueEntries() {
  return JSON.parse(readFileSync(resolve(EMULATOR_DIR, "firmwares.json"), "utf8")).firmwares.filter((e) => e.package).map((e) => ({ id: e.id, bytes: new Uint8Array(readFileSync(resolve(EMULATOR_DIR, e.package))) }));
}

// ---------------------------------------------------------------- damage operations (pure, on a copy)
/** The offset of the directory head named `name` in `image` (the heads are masked on flash: they are unmasked here on copies). Throws if absent. */
export function headAt(image, name) {
  for (let o = 0x20; o + 32 <= image.length; o += 32) {
    const g = image.slice(o, o + 32);
    unmask(g, 0, 32, 0xffff);
    const h = head(g, 0);
    if (h.name === name) return { at: o, ...h };
    if (h.last) break;
  }
  throw new Error(`no directory head ${name}`);
}

/**
 * Apply damage operations to a copy of `image`:
 *   { kind: "fill", at, len, value }   bytes become `value`
 *   { kind: "xor", at, mask }          one byte XOR mask
 *   { kind: "blob-bit", effect }       flip one bit of the 32-byte key blob: effect "key" = the first bit that changes the derived key, "same" = the first that leaves it unchanged
 *   { kind: "blob-crc" }               the blob's stored CRC-16 (the two bytes after the blob) XOR 0xFFFF
 *   { kind: "rename-head", name }      one character of the named directory head changed (the head is unmasked, edited, masked again), so the unpacker no longer finds it
 *   { kind: "truncate", length }       the image is cut to `length` bytes
 */
export function applyOps(image, ops) {
  let out = image.slice();
  for (const op of ops) {
    if (op.kind === "fill") out.fill(op.value, op.at, op.at + op.len);
    else if (op.kind === "xor") out[op.at] ^= op.mask;
    else if (op.kind === "blob-bit") {
      const cfg = headAt(out, "isd_config.ini"), blob = out.slice(cfg.offset, cfg.offset + 32), key = chipKey(blob);
      let hit = null;
      for (let i = 0; i < 32 && !hit; i++) for (let b = 0; b < 8 && !hit; b++) { const t = blob.slice(); t[i] ^= 1 << b; if ((chipKey(t) !== key) === (op.effect === "key")) hit = [i, b]; }
      if (!hit) throw new Error(`no single-bit blob flip with effect ${op.effect}`);
      out[cfg.offset + hit[0]] ^= 1 << hit[1];
    } else if (op.kind === "blob-crc") { const cfg = headAt(out, "isd_config.ini"); out[cfg.offset + 32] ^= 0xff; out[cfg.offset + 33] ^= 0xff; }
    else if (op.kind === "rename-head") {
      const h = headAt(out, op.name), g = out.slice(h.at, h.at + 32);
      unmask(g, 0, 32, 0xffff); g[16] ^= 0x20; unmask(g, 0, 32, 0xffff);
      out.set(g, h.at);
    } else if (op.kind === "truncate") out = out.slice(0, op.length);
    else throw new Error(`unknown damage operation ${op.kind}`);
  }
  return out;
}

/**
 * A SYNTHETIC 1 KiB flash image the emulator's unpacker ACCEPTS but whose directory never terminates: three heads (uboot.boot, isd_config.ini, app_dir_head), then every later 32-byte slot
 * decodes to a head with a zero "last" field, so the walk runs to the end of the image. It exists to test the unterminated-directory rules, which no catalogue package and no single-fault
 * damage of one can reach. Synthetic: it is not a firmware and says nothing about any package or about hardware.
 */
export function syntheticUnterminatedImage() {
  const LEN = 0x400, img = new Uint8Array(LEN).fill(0xff), ks = new Uint8Array(32);
  unmask(ks, 0, 32, 0xffff);                                       // the head keystream: a masked byte equal to ks[i] unmasks to 0
  const putHead = (at, name, offset, size, flags) => {
    const g = new Uint8Array(32), dv = new DataView(g.buffer);
    dv.setUint32(4, offset, true); dv.setUint32(8, size, true); g[12] = flags;     // bytes 14 and 15 (the "last" field) stay 0
    for (let i = 0; i < name.length; i++) g[16 + i] = name.charCodeAt(i);
    unmask(g, 0, 32, 0xffff);
    img.set(g, at);
  };
  const zeroLast = (from) => { for (let s = from; s + 32 <= LEN; s += 32) { img[s + 14] = ks[14]; img[s + 15] = ks[15]; } };
  putHead(0x20, "uboot.boot", 0x80, 0x20, 0x00);
  putHead(0x40, "isd_config.ini", 0x100, 34, 0x00);
  putHead(0x60, "app_dir_head", 0x200, 0xffffffff, 0x81);
  for (let i = 0; i < 32; i++) img[0x100 + i] = (i * 37 + 11) & 0xff;           // the key blob (its CRC is not set: the unchecked key is used)
  zeroLast(0x80);
  const key = chipKey(img.subarray(0x100, 0x120));
  const area = new Uint8Array(0x60);
  new DataView(area.buffer).setUint32(8, 0x60, true);                            // the app area's own head: size 0x60
  img.set(area, 0x200);
  unscramble(img, 0x200, 0x60, 0x200, key);
  for (let o = 0x200; o < 0x260; o += 32) unmask(img, o, 32, 0xffff);           // the walk unmasks every slot in place before the area is unscrambled, so the area is stored masked
  zeroLast(0x200);
  return img;
}

// ---------------------------------------------------------------- scenarios
// Pure scenarios: one firmware's flash (padded package image) damaged by `ops`, optionally with indeterminate ranges, diagnosed against the intact image. `expect` is what the
// classifier must say: the primary label, the emulator verdict, flags that must / must not be present, and the exact refusal when the unpacker refuses.
export const PURE_FIRMWARE = "felucca";
const none = ["emulator-unbootable", "boot-area-written", "unmodelled", "boot-area-at-risk", "boot-code-unknown"];
const without = (...keep) => none.filter((f) => !keep.includes(f));
export const PURE_SCENARIOS = [
  { id: "header-bit", why: "one bit of the 32-byte header: the emulator never checks the header, the mask ROM and SPL are unknown", ops: [{ kind: "xor", at: 3, mask: 1 }],
    expect: { primary: "boot-code-unknown", bootability: "emulator-bootable", has: ["header-changed", "boot-code-unknown", "emulator-bootable"], lacks: without("boot-code-unknown") } },
  { id: "sector-0-zeroed", why: "the whole boot sector zeroed: the directory is gone, so the emulator's unpacker refuses", ops: [{ kind: "fill", at: 0, len: 4096, value: 0 }],
    expect: { primary: "emulator-unbootable", bootability: "emulator-unbootable", refusal: "no chip key or app area in the flash image", has: ["emulator-unbootable", "boot-code-unknown", "header-changed", "directory-changed", "spl-changed", "unpack-refused"], lacks: ["unmodelled", "boot-area-at-risk", "emulator-bootable"] } },
  { id: "sector-0-erased", why: "the whole boot sector erased to 0xFF (a blank flash start)", ops: [{ kind: "fill", at: 0, len: 4096, value: 0xff }],
    expect: { primary: "emulator-unbootable", bootability: "emulator-unbootable", has: ["emulator-unbootable", "boot-code-unknown", "directory-changed"], lacks: ["unmodelled", "boot-area-at-risk"] } },
  { id: "key-blob-changes-key", why: "one blob bit that changes the derived key (the CRC then fails and the unchecked key is used): the app head decrypts to garbage and the unpacker refuses", ops: [{ kind: "blob-bit", effect: "key" }],
    expect: { primary: "emulator-unbootable", bootability: "emulator-unbootable", keyDiffers: true, refusal: "app area runs past the flash image", has: ["emulator-unbootable", "boot-code-unknown", "derived-key-differs", "keyBlob-changed"], lacks: ["unmodelled", "boot-area-at-risk"] } },
  { id: "key-blob-bad-crc-same-key", why: "one blob bit that leaves the derived key unchanged: the CRC fails, the fallback key is the same key, the unpacker accepts: a bad CRC alone is NOT unbootable", ops: [{ kind: "blob-bit", effect: "same" }],
    expect: { primary: "boot-code-unknown", bootability: "emulator-bootable", keyDiffers: false, windowDiffers: false, has: ["key-blob-crc-fails", "keyBlob-changed", "boot-code-unknown", "emulator-bootable"], lacks: [...without("boot-code-unknown"), "derived-key-differs"] } },
  { id: "key-blob-stored-crc-only", why: "only the stored CRC of the blob changed: same key, fallback, same window", ops: [{ kind: "blob-crc" }],
    expect: { primary: "boot-code-unknown", bootability: "emulator-bootable", keyDiffers: false, windowDiffers: false, has: ["key-blob-crc-fails", "keyBlob-changed", "emulator-bootable"], lacks: [...without("boot-code-unknown"), "derived-key-differs"] } },
  { id: "app-dir-head-renamed", why: "the app_dir_head directory entry renamed: the emulator finds no app area", ops: [{ kind: "rename-head", name: "app_dir_head" }],
    expect: { primary: "emulator-unbootable", bootability: "emulator-unbootable", refusal: "no chip key or app area in the flash image", has: ["emulator-unbootable", "boot-code-unknown", "directory-changed", "unpack-refused"], lacks: ["unmodelled", "boot-area-at-risk"] } },
  { id: "key-entry-renamed", why: "the isd_config.ini directory entry renamed: the emulator finds no key", ops: [{ kind: "rename-head", name: "isd_config.ini" }],
    expect: { primary: "emulator-unbootable", bootability: "emulator-unbootable", refusal: "no chip key or app area in the flash image", has: ["emulator-unbootable", "boot-code-unknown", "directory-changed"], lacks: ["unmodelled", "boot-area-at-risk"] } },
  { id: "spl-bit", why: "one bit of the uboot.boot body: never judged (nothing about SPL validation is established)", ops: [{ kind: "xor", at: 0x200, mask: 1 }],
    expect: { primary: "boot-code-unknown", bootability: "emulator-bootable", has: ["spl-changed", "boot-code-unknown", "emulator-bootable"], lacks: without("boot-code-unknown") } },
  { id: "spl-uncertain", why: "bytes of the uboot.boot body physically unknown after an interrupted cycle, the image bytes unchanged", ops: [], indeterminate: [[0x200, 0x2ff]],
    expect: { primary: "boot-area-at-risk", bootability: "emulator-bootable", has: ["boot-area-at-risk", "boot-code-unknown", "spl-indeterminate", "emulator-bootable"], lacks: ["unmodelled", "emulator-unbootable", "boot-area-written", "spl-changed"] } },
  { id: "gap-written", why: "one byte written into the 0xFF gap before the app area", ops: [{ kind: "fill", at: 0x3fff, len: 1, value: 0 }],
    expect: { primary: "boot-area-written", bootability: "emulator-bootable", has: ["gap-changed", "boot-area-written", "emulator-bootable"], lacks: without("boot-area-written") } },
  { id: "key-sector-written", why: "a byte written at 0xFF000 (named by the key_mac head; contents and role unknown)", ops: [{ kind: "fill", at: 0xff000, len: 1, value: 0 }],
    expect: { primary: "unmodelled", bootability: "emulator-bootable", has: ["unmodelled", "keySector-changed", "emulator-bootable"], lacks: without("unmodelled") } },
  { id: "app-area-only", why: "one byte inside the app area: a different window would run; not a boot-area finding", ops: [{ kind: "xor", at: 0x5000, mask: 1 }],
    expect: { primary: "emulator-bootable", bootability: "emulator-bootable", windowDiffers: true, has: ["appArea-changed", "app-window-differs", "emulator-bootable"], lacks: none } },
  { id: "directory-unterminated", why: "the image ends inside the directory (three heads, no terminating head): the walk never terminates and no later offset is invented; the missing bytes include 0xFF000, so the precedence makes it unmodelled while the refusal is still reported", ops: [{ kind: "truncate", length: 0x80 }],
    expect: { primary: "unmodelled", bootability: "emulator-unbootable", directoryTerminated: false, directoryEntries: 3, rules: { "directory-unterminated": "applies", "key-blob-crc-fails": "not-evaluable", "derived-key-differs": "not-evaluable", "app-window-differs": "not-evaluable", "emulator-unpack-refuses": "applies" }, refusal: "no chip key or app area in the flash image", has: ["directory-unterminated", "emulator-unbootable", "unpack-refused", "image-length-differs", "keySector-changed", "unmodelled"], lacks: ["boot-area-at-risk"] } },
  { id: "old-outcome-sector-0", why: "an interrupted sector-0 cycle whose synthetic outcome restored the old bytes: nothing differs from the reference, the sector is still at risk", ops: [], indeterminate: [[0, 4095]],
    expect: { primary: "boot-area-at-risk", bootability: "not-evaluable", has: ["boot-area-at-risk", "boot-code-unknown", "header-indeterminate", "directory-indeterminate", "spl-indeterminate", "emulator-result-on-placeholder-bytes"], lacks: ["unmodelled", "emulator-unbootable", "emulator-bootable", "header-changed"] } },
  { id: "old-outcome-key-sector", why: "an interrupted 0xFF000 cycle whose outcome left the bytes identical: still unmodelled, and at risk", ops: [], indeterminate: [[0xff000, 0xfffff]],
    expect: { primary: "unmodelled", bootability: "emulator-bootable", has: ["unmodelled", "boot-area-at-risk", "keySector-indeterminate", "emulator-bootable"], lacks: ["emulator-unbootable", "boot-area-written", "keySector-changed"] } },
];

/**
 * Full-tier scenarios on the chip-profile engine: the HARNESS issues a 4 KiB erase at `address` (the firmware never writes there: survey L14), the power is cut at 50 %, and the machine
 * is diagnosed twice: powered off (the range holds the engine's labelled placeholder) and after powerCycle with an explicit synthetic outcome. `expect` is for BOTH. The outcome policies
 * are synthetic inputs; the datasheets do not say what an interrupted erase leaves.
 */
export const LIVE_SCENARIOS = [
  { id: "sector-0-erase-cut-old", address: 0x0, policy: { kind: "old" }, expect: { primary: "boot-area-at-risk", regionHit: ["header", "directory", "spl"], keySectorTouched: false, changedAfterReboot: false } },
  { id: "sector-0-erase-cut-ff", address: 0x0, policy: { kind: "ff" }, expect: { primary: "boot-area-at-risk", regionHit: ["header", "directory", "spl"], keySectorTouched: false, changedAfterReboot: true } },
  { id: "sector-0-erase-cut-zero", address: 0x0, policy: { kind: "zero" }, expect: { primary: "boot-area-at-risk", regionHit: ["header", "directory", "spl"], keySectorTouched: false, changedAfterReboot: true } },
  { id: "key-sector-erase-cut-old", address: 0xff000, policy: { kind: "old" }, expect: { primary: "unmodelled", regionHit: ["keySector"], keySectorTouched: true, changedAfterReboot: false } },
  { id: "key-sector-erase-cut-ff", address: 0xff000, policy: { kind: "ff" }, expect: { primary: "unmodelled", regionHit: ["keySector"], keySectorTouched: true, changedAfterReboot: false } },
  { id: "key-sector-erase-cut-zero", address: 0xff000, policy: { kind: "zero" }, expect: { primary: "unmodelled", regionHit: ["keySector"], keySectorTouched: true, changedAfterReboot: true } },
];

// ---------------------------------------------------------------- the layout fixture
/** Pure: the fixture for the catalogue's entries ([{ id, bytes }]) and the SPL findings fixture. */
export function buildLayoutFixture(entries, findings) {
  const layouts = new Map(), bodies = new Map();
  const decodeOf = new Map(findings.bodies.map((b) => [`${b.sha8}:${b.size}`, b.class === "code-like" ? "decoded-code-like" : "not-decodable-under-tried-transforms"]));
  const undecoded = [];
  for (const { id, bytes } of entries) {
    const flash = paddedFlash(bytes), l = deriveLayout(flash);
    if (!l.ok) throw new Error(`${id}: ${l.error}`);
    const spl = l.regions.spl[0], key = `${sha8(flash.subarray(spl.lo, spl.hi))}:${spl.bytes}`;
    if (!decodeOf.has(key)) throw new Error(`${id}: the SPL body ${key} is not in the static-scan findings`);
    if (decodeOf.get(key) !== "decoded-code-like") undecoded.push({ id, body: key });
    const regions = Object.fromEntries(BOOT_AREA_REGIONS.map((k) => [k, l.regions[k].map((r) => [r.lo, r.hi])]));
    const sig = JSON.stringify({ regions, appOffset: l.appOffset, keySectorFromHead: l.keySectorFromHead });
    const e = layouts.get(sig) ?? { packages: 0, regions, appOffset: l.appOffset, keySectorFromHead: l.keySectorFromHead, splBody: key, splDecode: decodeOf.get(key) };
    e.packages++;
    layouts.set(sig, e);
    bodies.set(key, (bodies.get(key) ?? 0) + 1);
  }
  const lists = [...layouts.values()].sort((a, b) => b.packages - a.packages || a.splBody.localeCompare(b.splBody));
  return {
    version: LAYOUT_VERSION,
    evidenceLevel: "PACKAGE",
    note: "Boot-head layout of the catalogue's packages as the diagnostic derives it from each package's own directory, and the decode status of each uboot.boot body from the read-only static scan (DECODED, never executed). Structure only: no firmware bytes. The SPL status of every package is boot-code-unknown whatever its decode status.",
    packages: entries.length,
    regionOrder: REGION_ORDER,
    bootAreaRegions: BOOT_AREA_REGIONS,
    bootCodeRegions: BOOT_CODE_REGIONS,
    keySector: KEY_SECTOR,
    splStatus: SPL_STATUS,
    layouts: lists,
    splDecode: Object.fromEntries([...decodeOf.entries()].sort()),
    undecodedSplPackages: { count: undecoded.length, splStatus: SPL_STATUS, packages: undecoded.sort((a, b) => a.id.localeCompare(b.id)) },
  };
}

export const serializeLayout = (f) => JSON.stringify(f, null, 1) + "\n";
export const findings = () => JSON.parse(readFileSync(SPL_FINDINGS_PATH, "utf8"));

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const text = serializeLayout(buildLayoutFixture(catalogueEntries(), findings()));
  if (process.argv.includes("--write")) { mkdirSync(resolve(LAYOUT_PATH, ".."), { recursive: true }); writeFileSync(LAYOUT_PATH, text); console.log(`wrote ${LAYOUT_PATH}: ${text.length} bytes`); }
  else if (readFileSync(LAYOUT_PATH, "utf8").replace(/\r\n/g, "\n") !== text) { console.error("the committed layout differs from what the catalogue yields: run with --write"); process.exit(1); }
  else console.log("the layout fixture matches the catalogue");
}
