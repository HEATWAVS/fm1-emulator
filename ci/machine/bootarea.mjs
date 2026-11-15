// The boot-area diagnostic classifier (Component 7, Stage 7B). PURE: byte arrays in, a JSON-serialisable report out; no engine, no machine, no files, no clock.
//
// WHAT THIS IS. A diagnostic of a flash image against an intact reference, under the rules THIS EMULATOR implements (the validated port of fwsc.rs, fwscport.mjs) and the structure of the
// catalogue's packages. It is NOT a boot gate (the emulator's boot path is untouched and never consults it) and NOT a statement about a physical FM-1: `hardwareBootability` is
// fixed to "unknown", an unpacker refusal is not proof that real hardware is bricked, and an image the unpacker accepts is not proof that real hardware boots. The mask ROM, the SPL,
// USB and download mode are not modelled.
//
// EVIDENCE LABELS (docs/dev/BOOT-AREA.md): EMULATOR, PACKAGE, DECODED, INFERRED, DOCUMENTED, UNKNOWN. Every rule below names the labels it rests on and its consequence.
//
// REGIONS (derived from the INTACT REFERENCE's directory, never from the damaged image, so a broken directory cannot move a boundary): header, directory, spl (uboot.boot body),
// keyBlob (isd_config.ini body), gap (bytes below the app area that none of those cover), appArea, keySector (0xFF000, named by the key_mac head), other. Each byte belongs to
// exactly one (first match in that order).
//
// COUNTS. Per region the report keeps three INDEPENDENT numbers: `changed` (bytes that differ from the reference), `indeterminate` (bytes physically unknown after an interrupted
// cycle) and `both` (bytes counted in both). A byte inside an indeterminate range holds a placeholder or a synthetic fill, so it is NOT evidence of a write: the rules use `changedKnown`
// (changed outside the indeterminate ranges) for "was written" and `indeterminate` for "at risk". An interrupted cycle whose synthetic outcome leaves every byte equal to the reference
// (`old`) therefore still puts its region at risk.
//
// PRIMARY LABEL, in this precedence: unmodelled > boot-area-at-risk > emulator-unbootable > boot-code-unknown > boot-area-written > emulator-bootable. `flags` always lists every
// applicable label and every detail flag, even when a higher label wins. When no label applies the primary is "not-evaluable".
import { unpackFlash } from "./fwscport.mjs";

export const BOOTAREA_VERSION = 1;
export const EVIDENCE_LEVELS = Object.freeze(["EMULATOR", "PACKAGE", "DECODED", "INFERRED", "DOCUMENTED", "UNKNOWN"]);
export const PRIMARY_ORDER = Object.freeze(["unmodelled", "boot-area-at-risk", "emulator-unbootable", "boot-code-unknown", "boot-area-written", "emulator-bootable"]);
export const REGION_ORDER = Object.freeze(["header", "directory", "spl", "keyBlob", "gap", "appArea", "keySector", "other"]);
/** Regions whose damage or interruption is "boot area" for the at-risk label (the app area and everything else are firmware data). */
export const BOOT_AREA_REGIONS = Object.freeze(["header", "directory", "spl", "keyBlob", "gap", "keySector"]);
/** Regions whose uncertainty or change leaves the boot CODE's behaviour unknown (the emulator does not run the SPL). */
export const BOOT_CODE_REGIONS = Object.freeze(["header", "directory", "spl", "keyBlob"]);
export const FLASH_BYTES = 1 << 20;
export const HEADER_BYTES = 0x20;
export const HEAD_BYTES = 32;
export const KEY_SECTOR = Object.freeze({ offset: 0xff000, size: 0x1000 });
export const HARDWARE_BOOTABILITY = "unknown";
export const SPL_STATUS = "boot-code-unknown";

export const DISCLAIMER = "Emulator-defined diagnostic against an intact reference. It runs the emulator's own package-unpacker rules on a flash image; it is not a boot gate and not a statement about a physical FM-1. " +
  "An unpacker refusal is not proof that hardware is bricked, an accepted image is not proof that hardware boots, and no recovery path is modelled. hardwareBootability is always unknown.";

/** The assumptions a caller may ask for. They are labelled HYPOTHETICAL, never evidence, and never change the default `recovery-unknown` assessment. */
export const HYPOTHETICAL_ASSUMPTIONS = Object.freeze({
  "download-mode-available": "recoverable-by-reinstall",
  "external-programmer-available": "recoverable-by-external-reflash",
  "pessimistic-no-recovery-path": "unrecoverable",
});

/** Every rule: the labels it rests on, the region it concerns and what it leads to. The report lists each with a status, so no rule is ever applied silently. */
export const RULES = Object.freeze([
  { id: "emulator-unpack-refuses", evidence: ["EMULATOR"], region: "directory", consequence: "emulator-unbootable", says: "the ported unpacker (fwsc.rs rules) refuses the image while it accepts the reference; says nothing about the SPL, the mask ROM or hardware" },
  { id: "key-blob-crc-fails", evidence: ["EMULATOR"], region: "keyBlob", consequence: "flag-only", says: "the key blob's CRC-16 fails; the unpacker falls back to the unchecked key, so this alone is not a refusal" },
  { id: "derived-key-differs", evidence: ["EMULATOR"], region: "keyBlob", consequence: "flag-only", says: "the key derived from the blob differs from the reference's; the unpack result decides what follows" },
  { id: "app-window-differs", evidence: ["EMULATOR"], region: "appArea", consequence: "flag-only", says: "the decrypted app window differs from the reference's (different bytes would run; not a boot-area finding)" },
  { id: "header-touched", evidence: ["PACKAGE", "EMULATOR", "UNKNOWN"], region: "header", consequence: "boot-code-unknown", says: "all 277 packages share one header and the emulator never checks it; what the mask ROM or SPL does with it is unknown" },
  { id: "directory-touched", evidence: ["EMULATOR", "PACKAGE", "UNKNOWN"], region: "directory", consequence: "boot-code-unknown", says: "the emulator reads the directory for the key blob and app head only; its meaning to the SPL is unknown" },
  { id: "spl-touched", evidence: ["PACKAGE", "DECODED", "UNKNOWN"], region: "spl", consequence: "boot-code-unknown", says: "a changed or uncertain uboot.boot body is never judged: nothing about SPL validation or rejection is established" },
  { id: "key-blob-touched", evidence: ["EMULATOR", "UNKNOWN"], region: "keyBlob", consequence: "boot-code-unknown", says: "the emulator derives the app key from the blob; how the SPL treats a changed blob is unknown" },
  { id: "gap-written", evidence: ["PACKAGE", "UNKNOWN"], region: "gap", consequence: "boot-area-written", says: "the gap is 0xFF in every package; bytes written there are a boot-area write with no known meaning" },
  { id: "key-sector-touched", evidence: ["PACKAGE", "UNKNOWN"], region: "keySector", consequence: "unmodelled", says: "the key_mac head names 0xFF000 (PACKAGE); its contents and role are not established, so any change or uncertainty there is unmodelled" },
  { id: "boot-area-indeterminate", evidence: ["EMULATOR"], region: "boot area", consequence: "boot-area-at-risk", says: "an interrupted cycle left bytes of the boot area physically unknown; at risk even if a synthetic outcome restored the old bytes" },
  { id: "directory-unterminated", evidence: ["EMULATOR"], region: "directory", consequence: "flag-only", says: "the damaged image's directory has no terminating head within the image; locations that depend on it are not evaluable and no offset is invented" },
  { id: "app-dir-head2", evidence: ["INFERRED"], region: "directory", consequence: "none", says: "the SPL's name table lists app_dir_head2 but no package carries it; the meaning is inferred only and supports no claim of redundancy, fallback or recovery" },
  { id: "spl-decode-status", evidence: ["DECODED"], region: "spl", consequence: "flag-only", says: "whether the reference's uboot.boot body decoded as code under the static scan; the SPL status stays boot-code-unknown either way" },
  { id: "hardware-bootability", evidence: ["UNKNOWN"], region: "all", consequence: "none", says: "physical bootability is not established by any rule here" },
  { id: "recovery", evidence: ["UNKNOWN"], region: "all", consequence: "none", says: "no recovery path (ROM download mode, programmer, reinstall) is modelled; the default is recovery-unknown" },
]);

const range = (lo, hi) => ({ lo, hi, bytes: hi - lo });
const same = (a, b) => { if (a === b) return true; if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

/** Inclusive [lo, hi] byte ranges, validated: integers, lo <= hi, not negative. Anything else is a caller error, not a diagnostic. */
export function normalizeRanges(ranges) {
  if (ranges === null || ranges === undefined) return [];
  if (!Array.isArray(ranges)) throw new RangeError("indeterminate ranges must be an array of [lo, hi]");
  return ranges.map((r) => {
    if (!Array.isArray(r) || r.length !== 2 || !Number.isInteger(r[0]) || !Number.isInteger(r[1]) || r[0] < 0 || r[1] < r[0]) throw new RangeError(`bad indeterminate range ${JSON.stringify(r)}`);
    return [r[0], r[1]];
  });
}

/**
 * The package layout of an INTACT reference image, from its own directory (the unpacker's walk). Never throws for a bad image: `ok` is false and `error` says why.
 * Regions are half-open [lo, hi) byte ranges; `gap` may be several intervals.
 */
export function deriveLayout(reference) {
  if (!(reference instanceof Uint8Array) || reference.length < HEADER_BYTES + HEAD_BYTES) return { ok: false, error: "the reference is not a flash image", unpack: null };
  const unpack = unpackFlash(reference);
  if (!unpack.ok) return { ok: false, error: `the reference itself is refused by the unpacker (${unpack.error})`, unpack };
  const by = (n) => unpack.entries.find((e) => e.name === n);
  const spl = by("uboot.boot"), cfg = by("isd_config.ini"), app = by("app_dir_head"), keyMac = by("key_mac");
  const last = unpack.entries[unpack.entries.length - 1];
  const terminated = last.last;
  const missing = [["uboot.boot", spl], ["isd_config.ini", cfg], ["app_dir_head", app]].filter(([, e]) => !e).map(([n]) => n);
  if (missing.length || !terminated) return { ok: false, error: `the reference directory lacks ${missing.join(", ") || "a terminating head"}`, unpack };
  const within = (e) => e.offset + e.size <= reference.length;
  const regions = {
    header: [range(0, HEADER_BYTES)],
    directory: [range(HEADER_BYTES, last.at + HEAD_BYTES)],
    spl: within(spl) ? [range(spl.offset, spl.offset + spl.size)] : [],
    keyBlob: within(cfg) ? [range(cfg.offset, cfg.offset + cfg.size)] : [],
    appArea: [range(app.offset, app.offset + unpack.size)],
    keySector: [keyMac && keyMac.offset + keyMac.size <= FLASH_BYTES ? range(keyMac.offset, keyMac.offset + keyMac.size) : range(KEY_SECTOR.offset, KEY_SECTOR.offset + KEY_SECTOR.size)],
  };
  const keySectorFromHead = !!(keyMac && keyMac.offset + keyMac.size <= FLASH_BYTES);
  // the gap: bytes below the app area that header, directory, spl and keyBlob do not cover (derived, so a layout with a different body size has a different gap)
  const owned = new Uint8Array(app.offset);
  for (const k of ["header", "directory", "spl", "keyBlob"]) for (const r of regions[k]) owned.fill(1, Math.min(r.lo, app.offset), Math.min(r.hi, app.offset));
  const gap = [];
  for (let i = 0; i < app.offset; i++) if (!owned[i]) { let j = i; while (j < app.offset && !owned[j]) j++; gap.push(range(i, j)); i = j; }
  regions.gap = gap;
  return {
    ok: true, error: null, unpack, regions, keySectorFromHead, appOffset: app.offset, appBytes: unpack.size, splBytes: spl.size,
    entries: unpack.entries.map((e) => ({ name: e.name, at: e.at, offset: e.offset, size: e.size, flags: e.flags, last: e.last })),
  };
}

/** Sorted, disjoint, inclusive-to-half-open [lo, hi) intervals from inclusive [lo, hi] ranges (overlapping or touching ranges merge, so no byte is counted twice). */
function mergeRanges(ranges) {
  const out = [];
  for (const [lo, hi] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi + 1); else out.push([lo, hi + 1]);
  }
  return out;
}

/**
 * The region of every byte, as non-overlapping segments [lo, hi, regionIndex] that tile [0, n). Where regions overlap the earlier one in REGION_ORDER wins; bytes in none are "other".
 */
function segments(layout, n) {
  const cuts = new Set([0, n]);
  const spans = [];
  for (const name of REGION_ORDER) for (const r of layout.regions[name] ?? []) { const lo = Math.min(r.lo, n), hi = Math.min(r.hi, n); if (hi > lo) { spans.push([lo, hi, REGION_ORDER.indexOf(name)]); cuts.add(lo); cuts.add(hi); } }
  const pts = [...cuts].sort((x, y) => x - y), out = [], other = REGION_ORDER.indexOf("other");
  for (let i = 0; i + 1 < pts.length; i++) {
    const lo = pts[i], hi = pts[i + 1];
    let best = other;
    for (const [a, b, idx] of spans) if (a <= lo && hi <= b && idx < best) best = idx;
    const last = out[out.length - 1];
    if (last && last[2] === best && last[1] === lo) last[1] = hi; else out.push([lo, hi, best]);
  }
  return out;
}

/** Per-region byte counts of the image against the reference and the indeterminate ranges (the three kept apart, plus `changedKnown`). Cost grows with the changed bytes, not the flash. */
function regionStats(layout, image, reference, ranges, identical = false) {
  const n = Math.max(image.length, reference.length, FLASH_BYTES);
  const seg = segments(layout, n), unk = mergeRanges(ranges.map(([lo, hi]) => [Math.min(lo, n), Math.min(hi, n - 1)]).filter(([lo, hi]) => lo <= hi && lo < n));
  const stats = Object.fromEntries(REGION_ORDER.map((k) => [k, { bytes: 0, changed: 0, indeterminate: 0, both: 0, changedKnown: 0 }]));
  for (const [lo, hi, idx] of seg) stats[REGION_ORDER[idx]].bytes += Math.min(hi, Math.max(image.length, reference.length)) - Math.min(lo, Math.max(image.length, reference.length));
  for (const [ulo, uhi] of unk) for (const [lo, hi, idx] of seg) { const o = Math.min(hi, uhi) - Math.max(lo, ulo); if (o > 0) stats[REGION_ORDER[idx]].indeterminate += o; }
  // changed bytes: one pass over the bytes, then a walk of the segments and unknown ranges in step (both ascending)
  let si = 0, ui = 0;
  const m = Math.max(image.length, reference.length);
  for (let i = 0; i < (identical ? 0 : m); i++) {
    if (image[i] === reference[i]) continue;
    while (seg[si][1] <= i) si++;
    while (ui < unk.length && unk[ui][1] <= i) ui++;
    const s = stats[REGION_ORDER[seg[si][2]]];
    s.changed++;
    if (ui < unk.length && unk[ui][0] <= i) s.both++;
  }
  for (const s of Object.values(stats)) s.changedKnown = s.changed - s.both;
  return stats;
}

/**
 * The damaged image's own directory walk, as the unpacker performs it (the damaged image is never used to locate a region). `terminated` is false when no head within the image
 * carries the "last" marker: the walk then ran to the end of the image over arbitrary bytes.
 */
function directoryOfImage(unpack, layout) {
  const entries = unpack.entries;
  const terminated = entries.length > 0 && entries[entries.length - 1].last;
  const ref = layout?.entries ?? null;
  const matches = ref ? entries.length === ref.length && entries.every((e, i) => e.name === ref[i].name && e.offset === ref[i].offset && e.size === ref[i].size && e.flags === ref[i].flags && e.last === ref[i].last) : null;
  return { terminated, entryCount: entries.length, matchesReference: matches, names: entries.map((e) => e.name) };
}

function hypothetical(assume, applicable) {
  if (assume === null || assume === undefined) return null;
  if (!(assume in HYPOTHETICAL_ASSUMPTIONS)) throw new RangeError(`unknown hypothetical assumption "${assume}" (one of ${Object.keys(HYPOTHETICAL_ASSUMPTIONS).join(", ")})`);
  return {
    HYPOTHETICAL: true, assumption: assume, evidence: "UNKNOWN",
    outcome: applicable ? HYPOTHETICAL_ASSUMPTIONS[assume] : "nothing-to-recover",
    note: "HYPOTHETICAL: an assumption the caller asked for, not evidence and not modelled behaviour. It does not change the default assessment (recovery-unknown).",
  };
}

/**
 * Diagnose `image` (the flash as it is) against `reference` (the intact image). Options:
 *   indeterminate  [[lo, hi], ...] inclusive byte ranges physically unknown after an interrupted cycle (the chip-profile engine's list); default none
 *   assume         one of HYPOTHETICAL_ASSUMPTIONS or null (default): fills `recovery.hypothetical`, never the assessment
 *   splDecode      optional map { "<sha8>:<size>": status } of the static SPL scan (the layout fixture), for the informational `spl.decode` field; null = unknown
 *   hash8          optional pure function (bytes) => 8 hex digits, used with splDecode to name the reference's uboot.boot body (this module does no hashing itself)
 * Never throws for a bad image or reference (that is a result); throws RangeError for malformed options.
 */
export function classify(image, reference, { indeterminate = null, assume = null, splDecode = null, hash8 = null } = {}) {
  if (!(image instanceof Uint8Array)) throw new RangeError("the image must be a Uint8Array");
  const ranges = normalizeRanges(indeterminate);
  const refLayout = reference === null || reference === undefined ? { ok: false, error: "no reference image supplied", unpack: null } : deriveLayout(reference);
  const evaluable = refLayout.ok;
  // identical bytes: the unpacker is a pure function of them, so the reference's unpack IS the image's
  const identical = evaluable && same(image, reference);
  const damaged = identical ? refLayout.unpack : unpackFlash(image);
  const flags = new Set();
  const report = {
    version: BOOTAREA_VERSION,
    disclaimer: DISCLAIMER,
    hardwareBootability: HARDWARE_BOOTABILITY,
    primary: "not-evaluable",
    bootability: "not-evaluable",
    flags: [],
    reference: { provided: reference !== null && reference !== undefined, valid: evaluable, error: evaluable ? null : refLayout.error },
    emulator: null,
    regions: null,
    directory: null,
    spl: { status: SPL_STATUS, body: null, decode: "not-analysed", evidence: ["DECODED", "UNKNOWN"] },
    rules: [],
    recovery: { assessment: "recovery-unknown", evidence: "UNKNOWN", reason: "no recovery path is modelled; none is established for a physical unit", hypothetical: null },
    notes: [{ id: "app_dir_head2", evidence: "INFERRED", used: false, text: "the SPL's name table lists app_dir_head2; no package carries it. It is not used by any rule and supports no claim of redundancy, fallback or recovery." }],
  };
  // the image's own unpack result and key facts (no reference needed)
  const own = {
    unpack: damaged.ok ? "accepted" : "refused",
    refusal: damaged.ok ? null : damaged.error,
    keyDerived: damaged.key ?? null,
    keyChecked: damaged.ok ? damaged.keyChecked : null,
    keyFromFallback: damaged.ok ? damaged.keyFromFallback : null,
    appWindowBytes: damaged.ok ? damaged.size : null,
  };
  report.directory = directoryOfImage(damaged, refLayout.ok ? refLayout : null);
  if (!report.directory.terminated) flags.add("directory-unterminated");
  if (damaged.ok && damaged.keyFromFallback) flags.add("key-blob-crc-fails");
  if (!damaged.ok) flags.add("unpack-refused");

  if (!evaluable) {
    flags.add("no-reference");
    // without a reference the only evaluable things are the image's own: unpack result, key and directory, and where the unknown bytes lie in the fixed zones
    report.emulator = { ...own, referenceUnpack: null, keyDiffers: null, windowDiffers: null, windowDifferingBytes: null, verdict: "not-evaluable" };
    const zones = { belowAppArea: [0, 0x4000], keySector: [KEY_SECTOR.offset, KEY_SECTOR.offset + KEY_SECTOR.size] };
    report.regions = null;
    report.fixedZones = Object.fromEntries(Object.entries(zones).map(([k, [lo, hi]]) => [k, { indeterminate: ranges.reduce((n, [a, b]) => n + Math.max(0, Math.min(b + 1, hi) - Math.max(a, lo)), 0) }]));
    if (report.fixedZones.belowAppArea.indeterminate || report.fixedZones.keySector.indeterminate) flags.add("boot-area-at-risk");
    report.rules = ruleReport(null, flags, report);
    return finish(report, flags, assume);
  }

  const refUnpack = refLayout.unpack;
  if (hash8 && refLayout.regions.spl.length) {
    const { lo, hi } = refLayout.regions.spl[0];
    report.spl.body = `${hash8(reference.subarray(lo, hi))}:${hi - lo}`;
    if (splDecode && splDecode[report.spl.body]) report.spl.decode = splDecode[report.spl.body];
  }
  const dUnpack = damaged;
  const stats = regionStats(refLayout, image, reference, ranges, identical);
  report.regions = {};
  for (const k of REGION_ORDER) {
    const list = k === "other" ? [] : refLayout.regions[k];
    report.regions[k] = { ranges: list.map((r) => [r.lo, r.hi]), ...stats[k] };
  }
  report.regions.keySector.derivedFromHead = refLayout.keySectorFromHead;
  report.regions.gap.allIntactBytesFF = refLayout.regions.gap.every((r) => { for (let i = r.lo; i < r.hi; i++) if (reference[i] !== 0xff) return false; return true; });

  // the emulator comparison
  const emu = { ...own };
  emu.referenceUnpack = { unpack: "accepted", key: refUnpack.key, keyChecked: refUnpack.keyChecked, keyFromFallback: refUnpack.keyFromFallback, appWindowBytes: refUnpack.size };
  emu.keyDiffers = dUnpack.ok ? dUnpack.key !== refUnpack.key : (dUnpack.key !== undefined ? dUnpack.key !== refUnpack.key : null);
  if (dUnpack.ok) {
    emu.windowDiffers = !same(dUnpack.xip, refUnpack.xip);
    let n = 0; if (emu.windowDiffers) for (let i = 0; i < Math.max(dUnpack.size, refUnpack.size); i++) if (dUnpack.xip[i] !== refUnpack.xip[i]) n++;
    emu.windowDifferingBytes = n;
  } else { emu.windowDiffers = null; emu.windowDifferingBytes = null; }
  // The unpacker reads the directory, the blob and its CRC (34 bytes at the blob), and the app window. Unknown bytes there make its result a result on placeholder bytes.
  const readIdx = ["directory", "keyBlob", "appArea"].filter((k) => stats[k].indeterminate > 0);
  emu.placeholderBytesRead = readIdx;
  emu.verdict = readIdx.length ? "not-evaluable" : dUnpack.ok ? "emulator-bootable" : "emulator-unbootable";
  report.emulator = emu;
  if (emu.keyDiffers) flags.add("derived-key-differs");
  if (emu.windowDiffers) flags.add("app-window-differs");
  if (readIdx.length) flags.add("emulator-result-on-placeholder-bytes");

  for (const k of REGION_ORDER) {
    if (stats[k].changedKnown > 0) flags.add(`${k}-changed`);
    if (stats[k].indeterminate > 0) flags.add(`${k}-indeterminate`);
  }
  if (!identical && image.length !== reference.length) flags.add("image-length-differs");

  // labels
  // (a changed byte inside an unknown range implies indeterminate > 0, so "changed or unknown" needs no separate changedKnown term; changedKnown is for "was written")
  const touched = (k) => stats[k].changed > 0 || stats[k].indeterminate > 0;
  if (touched("keySector")) flags.add("unmodelled");
  if (BOOT_AREA_REGIONS.some((k) => stats[k].indeterminate > 0)) flags.add("boot-area-at-risk");
  if (emu.verdict === "emulator-unbootable") flags.add("emulator-unbootable");
  if (BOOT_CODE_REGIONS.some(touched)) flags.add("boot-code-unknown");
  if (stats.gap.changedKnown > 0) flags.add("boot-area-written");
  if (emu.verdict === "emulator-bootable") flags.add("emulator-bootable");
  report.bootability = emu.verdict;
  report.rules = ruleReport(stats, flags, report);
  return finish(report, flags, assume);
}

function finish(report, flags, assume) {
  report.flags = [...flags].sort();
  // without a valid reference there is no verdict at all: the flags still carry what the image shows on its own, but the primary label is not-evaluable
  report.primary = flags.has("no-reference") ? "not-evaluable" : PRIMARY_ORDER.find((l) => flags.has(l)) ?? "not-evaluable";
  const damagedFlags = PRIMARY_ORDER.slice(0, 5).some((l) => flags.has(l));
  report.recovery.hypothetical = hypothetical(assume, damagedFlags);
  return report;
}

/** Each rule with its status for this diagnosis: applies, clear, or not-evaluable (it depends on something the diagnosis lacks). */
function ruleReport(stats, flags, report) {
  const REGION_OF = { "header-touched": "header", "directory-touched": "directory", "spl-touched": "spl", "key-blob-touched": "keyBlob", "gap-written": "gap", "key-sector-touched": "keySector" };
  const status = (id) => {
    if (id === "hardware-bootability" || id === "recovery" || id === "app-dir-head2") return "not-evaluable";   // UNKNOWN or INFERRED only: never decided here
    if (id === "directory-unterminated" || id === "key-blob-crc-fails") return flags.has(id) ? "applies" : "clear";
    if (!stats) return "not-evaluable";                                                   // everything below needs the reference
    if (id === "derived-key-differs") return report.emulator.keyDiffers === null ? "not-evaluable" : report.emulator.keyDiffers ? "applies" : "clear";
    if (id === "app-window-differs") return report.emulator.windowDiffers === null ? "not-evaluable" : report.emulator.windowDiffers ? "applies" : "clear";
    if (id === "emulator-unpack-refuses") return report.emulator.verdict === "not-evaluable" ? "not-evaluable" : report.emulator.verdict === "emulator-unbootable" ? "applies" : "clear";
    if (id === "boot-area-indeterminate") return flags.has("boot-area-at-risk") ? "applies" : "clear";
    if (id === "spl-decode-status") return report.spl.decode === "not-analysed" ? "not-evaluable" : "applies";
    const k = REGION_OF[id];
    return stats[k].changedKnown > 0 || (k !== "gap" && stats[k].indeterminate > 0) ? "applies" : "clear";
  };
  // Rules about WHAT the image's own directory led the unpacker to (the blob it read, the key it derived, the window it decrypted) are not evaluable when that directory never terminates:
  // the walk ran over arbitrary bytes, so what it found is not a statement about the key blob or the app area. No region offset is ever taken from the damaged image.
  const DEPENDENT = new Set(["key-blob-crc-fails", "derived-key-differs", "app-window-differs"]);
  return RULES.map((r) => ({ id: r.id, evidence: r.evidence, region: r.region, consequence: r.consequence, status: flags.has("directory-unterminated") && DEPENDENT.has(r.id) ? "not-evaluable" : status(r.id) }));
}
