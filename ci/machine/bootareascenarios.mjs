#!/usr/bin/env node
// The curated boot-area scenario catalogue and its deterministic report (Component 7, Stage 7C). Every row is an emulator-defined diagnostic result (bootarea.mjs) under a named input.
// Nothing here says anything about a physical FM-1: hardwareBootability is "unknown" and the recovery assessment is "recovery-unknown" in every row, the SPL and the mask ROM are never
// executed or modelled, and the synthetic outcome of an interrupted cycle is an explicit input, not something the datasheets establish.
//
//   node ci/machine/bootareascenarios.mjs              check: rebuild the pure rows (and replay the shipped-engine divergence, and the live rows when the chip-profile engine is built)
//                                                      against the committed report, and check the summary is exactly what the report renders to. Live rows are reported SKIPPED, never
//                                                      passed, without the chip-profile engine (exit 0; with --require-live exit 1)
//   node ci/machine/bootareascenarios.mjs --write      regenerate fixtures/bootarea-scenarios.json and docs/dev/BOOT-AREA-SCENARIOS.md (needs the chip-profile engine: a report without its live rows would be incomplete)
//   node ci/machine/bootareascenarios.mjs --summary    print the human-readable summary rendered from the committed report
//   node ci/machine/bootareascenarios.mjs --json       print the committed report
//
// 90 rows: 75 pure rows (no engine) and 15 interrupted-cycle / divergence rows (13 on the chip-profile engine, 1 running divergence on the shipped engine, 1 on the chip engine). Tiers: 43 quick
// (every pure row except the matrix rows of the four layouts other than picovave) and 47 full (those 32 pure rows, 13 chip-engine rows, 2 divergence rows), to keep the quick tier's added time under 1.0 s.
// Rows of the 7B catalogue are INHERITED by their stable ID: their damage and expectations come from bootareacatalogue.mjs, not from a copy here.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EMULATOR_DIR } from "./engine.mjs";
import { Fm1Machine } from "./machine.mjs";
import { diffSectors } from "./flash.mjs";
import { watch } from "./monitor.mjs";
import { LiveChip } from "./chiplive.mjs";
import { PROFILES } from "./chipspec.mjs";
import { catalogPackage } from "./firmware-survey.mjs";
import { deriveLayout, FLASH_BYTES, REGION_ORDER, PRIMARY_ORDER, HYPOTHETICAL_ASSUMPTIONS, DISCLAIMER } from "./bootarea.mjs";
import { diagnoseImage, diagnoseMachine, loadLayoutFixture } from "./bootareadiag.mjs";
import { PURE_SCENARIOS, LIVE_SCENARIOS, applyOps, paddedFlash } from "./bootareacatalogue.mjs";

export const SCENARIOS_VERSION = 1;
export const FIXTURE_PATH = resolve(import.meta.dirname, "fixtures/bootarea-scenarios.json");
export const SUMMARY_PATH = resolve(import.meta.dirname, "../../docs/dev/BOOT-AREA-SCENARIOS.md");
const sha256 = (u8) => createHash("sha256").update(u8).digest("hex");
const text256 = (s) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------- image / reference identity
/**
 * The identity of every reference the catalogue uses: the SHA-256 of the firmware package as bundled (it must also equal the catalogue's own firmwares.json entry) and of the intact flash
 * image derived from it (the package padded with 0xFF to 1 MiB). A diagnosis is only made against a reference that matches these, never against whatever reference is at hand.
 * `engineBase` (Felucca only, the one firmware the machine rows boot): the engine's base flash after boot, which is what diagnoseMachine uses as the reference; it holds data outside
 * the package image, so it differs from `reference`, and it is identical on the shipped and the chip-profile engine.
 */
export const IDENTITIES = Object.freeze({
  felucca: Object.freeze({ package: "b57724fff5a9b55b67d6f8a7d852e68d5d5814ed6fb769ec80a274fb44958e12", reference: "822829bb2276dfc3c00b34bd58c665c06b564458c8cdd1fceaa62c4e338e6a30", engineBase: "83e1f3db14d04f6c03f905ec9e1f4404ae3a402e8756dbc6c7b13537eda4b78f" }),
  audiorouter: Object.freeze({ package: "db1bac9e3f07cf173c3359ba0022fad56714eb296278db16111d45ddd09cc011", reference: "90dc474178d2405fe9c0783d3dc50220add3c9a007e796420e7841f45b9c91f1" }),
  beetle: Object.freeze({ package: "1c88c620b6d8763835597e085c3287b54dba9921d535efc764f4b4c5f3468538", reference: "62838fd53b6819d942ac94b83d02faeb96e4e6f497dcf7d1ca2811402ea5f508" }),
  dx747: Object.freeze({ package: "91f9acd06e37cea10d2af519d74a50343507709f5edd69b635d7711b69520934", reference: "6e816a1609e238fbe8a1ce2e17d97fb3fdc97df7d914c0b434069504eabd1827" }),
  gammawave: Object.freeze({ package: "f8fae2b0191662713225608cd0191e60a18f0347748f60fad0f6327d6f81dc4b", reference: "e748499bafa510b9b94bd7f1017180ba44b80af311b7ee7d191b6646203df4a3" }),
  picovave: Object.freeze({ package: "936e6924cf802366f54dc2fa3062d079094d39698f4ef9ccb2287fee6c41dff3", reference: "bb57725e20d890453d59a9c9f058cb99116e5b197e999c90620689bb54a7ed29" }),
});
export const REPRESENTATIVES = Object.freeze(["felucca", "audiorouter", "beetle", "dx747", "gammawave", "picovave"]);   // one package per layout of the layout fixture

export class ReferenceMismatchError extends Error {
  constructor(message) { super(message); this.name = "ReferenceMismatchError"; }
}

const verified = new WeakMap();                   // reference image -> the firmware it was verified for (a verification never carries over to another firmware)
/** Throws ReferenceMismatchError unless `reference` is the pinned intact image of `firmware` (and, when given, `packageBytes` is its pinned package). Returns `reference`. */
export function verifyReference(firmware, reference, packageBytes = null) {
  const id = IDENTITIES[firmware];
  if (!id) throw new ReferenceMismatchError(`no pinned identity for firmware "${firmware}": a reference is only accepted for the firmware named in the catalogue`);
  if (packageBytes !== null && sha256(packageBytes) !== id.package) throw new ReferenceMismatchError(`${firmware}: the package is not the pinned package (sha256 ${sha256(packageBytes)})`);
  if (reference.length !== FLASH_BYTES) throw new ReferenceMismatchError(`${firmware}: the reference is ${reference.length} bytes, not ${FLASH_BYTES}`);
  if (verified.get(reference) !== firmware) {
    const got = sha256(reference);
    if (got !== id.reference) throw new ReferenceMismatchError(`${firmware}: the reference image is not the pinned intact image (sha256 ${got}, expected ${id.reference}): refusing to diagnose against the wrong reference`);
    verified.set(reference, firmware);
  }
  return reference;
}
/** The same guard for a machine: its base flash (the reference diagnoseMachine uses) must be the pinned engine base of `firmware`. */
export function verifyMachineReference(firmware, machine) {
  const id = IDENTITIES[firmware];
  if (!id?.engineBase) throw new ReferenceMismatchError(`no pinned engine base flash for firmware "${firmware}"`);
  const got = sha256(machine.baseFlash());
  if (got !== id.engineBase) throw new ReferenceMismatchError(`${firmware}: the machine's base flash is not the pinned one (sha256 ${got}, expected ${id.engineBase}): refusing to diagnose against the wrong reference`);
}

const loaded = new Map();
/** The pinned package and intact reference of `firmware`: read from the bundled catalogue, checked against the pins (the pinned package digest equals the catalogue's own sha256: a test checks that), cached. */
export function loadReference(firmware) {
  if (loaded.has(firmware)) return loaded.get(firmware);
  const entry = JSON.parse(readFileSync(resolve(EMULATOR_DIR, "firmwares.json"), "utf8")).firmwares.find((e) => e.id === firmware);
  if (!entry?.package) throw new ReferenceMismatchError(`firmware "${firmware}" is not a bundled package`);
  const bytes = new Uint8Array(readFileSync(resolve(EMULATOR_DIR, entry.package)));
  const reference = verifyReference(firmware, paddedFlash(bytes), bytes);
  const out = { firmware, reference, regions: deriveLayout(reference).regions };
  loaded.set(firmware, out);
  return out;
}

// ---------------------------------------------------------------- damage with symbolic offsets
/** Resolve `at: { region, edge: "first" }` (the first byte of the region's first interval) against the reference's own regions; numbers stay numbers. */
export function resolveOps(ops, regions) {
  const at = (v) => {
    if (typeof v === "number") return v;
    const r = regions[v.region]?.[0];
    if (!r) throw new Error(`the reference has no ${v.region} region`);
    if (v.edge !== "first") throw new Error(`unsupported edge "${v.edge}": only "first" is used`);
    return r.lo;
  };
  return ops.map((o) => ("at" in o ? { ...o, at: at(o.at) } : o));
}
const hx = (n) => `0x${n.toString(16).toUpperCase()}`;
export function describeOp(o) {
  switch (o.kind) {
    case "fill": return `${o.len} byte${o.len === 1 ? "" : "s"} at ${hx(o.at)} set to ${hx(o.value)}`;
    case "xor": return `byte at ${hx(o.at)} XOR ${hx(o.mask)}`;
    case "blob-bit": return o.effect === "key" ? "one bit of the key blob flipped, the first that changes the derived key" : "one bit of the key blob flipped, the first that leaves the derived key unchanged";
    case "blob-crc": return "the key blob's stored CRC-16 inverted";
    case "rename-head": return `one character of the directory entry ${o.name} changed`;
    case "truncate": return `the image cut to ${o.length} bytes`;
    default: throw new Error(`unknown damage operation ${o.kind}`);
  }
}
const describeRanges = (rs) => (rs ?? []).map(([lo, hi]) => `${hx(lo)}-${hx(hi)}`);

// ---------------------------------------------------------------- the catalogue
const E = (primary, bootability, flags, more = {}) => ({ primary, bootability, flags: [...flags].sort(), ...more });
const REFUSE_NO_KEY = "no chip key or app area in the flash image", REFUSE_RUNS_PAST = "app area runs past the flash image";

/** Damages applied to every non-Felucca representative; the expected result is the same on every layout (offsets differ, the label does not). */
const MATRIX = [
  { key: "header-bit", why: "one bit of the 32-byte header: the emulator never checks the header; the mask ROM and the SPL are unknown", ops: [{ kind: "xor", at: 3, mask: 1 }],
    expect: E("boot-code-unknown", "emulator-bootable", ["boot-code-unknown", "emulator-bootable", "header-changed"]) },
  { key: "directory-head-renamed", why: "the app_dir_head directory entry renamed, so the emulator's unpacker finds no app area", ops: [{ kind: "rename-head", name: "app_dir_head" }],
    expect: E("emulator-unbootable", "emulator-unbootable", ["boot-code-unknown", "directory-changed", "emulator-unbootable", "unpack-refused"], { refusal: REFUSE_NO_KEY }) },
  { key: "spl-first-byte", why: "one bit of the first byte of the uboot.boot body: nothing about SPL validation is established, so it is never judged", ops: [{ kind: "xor", at: { region: "spl", edge: "first" }, mask: 1 }],
    expect: E("boot-code-unknown", "emulator-bootable", ["boot-code-unknown", "emulator-bootable", "spl-changed"]) },
  { key: "key-blob-changes-key", why: "one key-blob bit that changes the derived key: the app head decrypts to garbage and the emulator's unpacker refuses", ops: [{ kind: "blob-bit", effect: "key" }],
    expect: E("emulator-unbootable", "emulator-unbootable", ["boot-code-unknown", "derived-key-differs", "emulator-unbootable", "keyBlob-changed", "unpack-refused"], { refusal: REFUSE_RUNS_PAST, keyDiffers: true }) },
  { key: "key-blob-same-key", why: "one key-blob bit that leaves the derived key unchanged: the CRC fails, the fallback key is the same key and the unpacker accepts, so a bad CRC alone is not unbootable", ops: [{ kind: "blob-bit", effect: "same" }],
    expect: E("boot-code-unknown", "emulator-bootable", ["boot-code-unknown", "emulator-bootable", "key-blob-crc-fails", "keyBlob-changed"], { keyDiffers: false, windowDiffers: false }) },
  { key: "gap-first-byte", why: "the first byte of the 0xFF gap before the app area written: bytes the package leaves erased now hold data", ops: [{ kind: "fill", at: { region: "gap", edge: "first" }, len: 1, value: 0 }],
    expect: E("boot-area-written", "emulator-bootable", ["boot-area-written", "emulator-bootable", "gap-changed"]) },
  { key: "app-first-byte", why: "one bit of the first app-area byte: a different decrypted window would run; this is not a boot-area finding", ops: [{ kind: "xor", at: { region: "appArea", edge: "first" }, mask: 1 }],
    expect: E("emulator-bootable", "emulator-bootable", ["app-window-differs", "appArea-changed", "emulator-bootable"], { windowDiffers: true }) },
  { key: "key-sector-byte", why: "a byte written at 0xFF000, the sector the key_mac head names (package evidence only; contents and role unknown)", ops: [{ kind: "fill", at: { region: "keySector", edge: "first" }, len: 1, value: 0 }],
    expect: E("unmodelled", "emulator-bootable", ["emulator-bootable", "keySector-changed", "unmodelled"]) },
];

const COMPOSITE = [
  { key: "header-and-gap", why: "a header bit and a gap byte together: the boot-code-unknown label outranks boot-area-written, which stays visible as a flag", ops: [{ kind: "xor", at: 3, mask: 1 }, { kind: "fill", at: { region: "gap", edge: "first" }, len: 1, value: 0 }],
    expect: E("boot-code-unknown", "emulator-bootable", ["boot-area-written", "boot-code-unknown", "emulator-bootable", "gap-changed", "header-changed"]) },
  { key: "gap-and-key-sector", why: "a gap byte and a byte at 0xFF000: unmodelled outranks every other label; boot-area-written stays visible as a flag", ops: [{ kind: "fill", at: { region: "gap", edge: "first" }, len: 1, value: 0 }, { kind: "fill", at: 0xff000, len: 1, value: 0 }],
    expect: E("unmodelled", "emulator-bootable", ["boot-area-written", "emulator-bootable", "gap-changed", "keySector-changed", "unmodelled"]) },
  { key: "same-key-blob-bit-and-app-byte", why: "a key-blob bit that keeps the derived key plus an app-area byte: the app window differs, the key does not", ops: [{ kind: "blob-bit", effect: "same" }, { kind: "xor", at: 0x5000, mask: 1 }],
    expect: E("boot-code-unknown", "emulator-bootable", ["app-window-differs", "appArea-changed", "boot-code-unknown", "emulator-bootable", "key-blob-crc-fails", "keyBlob-changed"], { keyDiffers: false, windowDiffers: true }) },
  { key: "head-renamed-and-key-sector", why: "the app_dir_head entry renamed plus a byte at 0xFF000: unmodelled outranks emulator-unbootable, and the emulator verdict beside it still says the unpacker refuses", ops: [{ kind: "rename-head", name: "app_dir_head" }, { kind: "fill", at: 0xff000, len: 1, value: 0 }],
    expect: E("unmodelled", "emulator-unbootable", ["boot-code-unknown", "directory-changed", "emulator-unbootable", "keySector-changed", "unmodelled", "unpack-refused"], { refusal: REFUSE_NO_KEY }) },
  { key: "sector-3-erased", why: "the whole 4 KiB sector at 0x3000 erased (the tail of the SPL body, the key blob and the gap): the key is gone, the derived key differs and the unpacker refuses", ops: [{ kind: "fill", at: 0x3000, len: 4096, value: 0xff }],
    expect: E("emulator-unbootable", "emulator-unbootable", ["boot-code-unknown", "derived-key-differs", "emulator-unbootable", "keyBlob-changed", "spl-changed", "unpack-refused"], { refusal: REFUSE_RUNS_PAST, keyDiffers: true }) },
  { key: "whole-flash-erased", why: "every byte of the 1 MiB flash set to 0xFF: the unpacker refuses; every region and the key sector changed", ops: [{ kind: "fill", at: 0, len: FLASH_BYTES, value: 0xff }],
    expect: E("emulator-unbootable", "emulator-unbootable", ["appArea-changed", "boot-code-unknown", "directory-changed", "emulator-unbootable", "header-changed", "keyBlob-changed", "other-changed", "spl-changed", "unpack-refused"], { refusal: REFUSE_NO_KEY }) },
  { key: "whole-flash-zero", why: "every byte of the 1 MiB flash set to 0: unmodelled outranks emulator-unbootable, which stays visible in the verdict and the flags", ops: [{ kind: "fill", at: 0, len: FLASH_BYTES, value: 0 }],
    expect: E("unmodelled", "emulator-unbootable", ["appArea-changed", "boot-area-written", "boot-code-unknown", "directory-changed", "emulator-unbootable", "gap-changed", "header-changed", "keyBlob-changed", "keySector-changed", "other-changed", "spl-changed", "unmodelled", "unpack-refused"], { refusal: REFUSE_NO_KEY }) },
];

const INTERRUPTED = [
  { key: "sector-3-felucca", firmware: "felucca", why: "an interrupted 4 KiB cycle at 0x3000 (input: indeterminate range, image bytes unchanged): the SPL tail, key blob and gap are unknown, so the emulator verdict is not evaluable",
    indeterminate: [[0x3000, 0x3fff]], expect: E("boot-area-at-risk", "not-evaluable", ["boot-area-at-risk", "boot-code-unknown", "emulator-result-on-placeholder-bytes", "gap-indeterminate", "keyBlob-indeterminate", "spl-indeterminate"]) },
  { key: "sector-3-picovave", firmware: "picovave", why: "the same range on the layout whose boot area ends at 0x10CD: only the gap is unknown, so the emulator can still evaluate the package it unpacks",
    indeterminate: [[0x3000, 0x3fff]], expect: E("boot-area-at-risk", "emulator-bootable", ["boot-area-at-risk", "emulator-bootable", "gap-indeterminate"]) },
  { key: "app-sector-4-felucca", firmware: "felucca", why: "an interrupted cycle at 0x4000 (the app area only): no boot-area rule applies, so the primary label is not-evaluable because the app-area bytes the unpacker reads are unknown",
    indeterminate: [[0x4000, 0x4fff]], expect: E("not-evaluable", "not-evaluable", ["appArea-indeterminate", "emulator-result-on-placeholder-bytes"]) },
  { key: "program-range-in-gap", firmware: "felucca", why: "a page-program-sized range in the gap unknown: the boot area is at risk, but the unpacker reads nothing in it",
    indeterminate: [[0x3f00, 0x3fff]], expect: E("boot-area-at-risk", "emulator-bootable", ["boot-area-at-risk", "emulator-bootable", "gap-indeterminate"]) },
  { key: "boot-sector-and-key-sector", firmware: "felucca", why: "sector 0 and 0xFF000 both unknown: unmodelled outranks at-risk, and boot-area-at-risk stays visible as a flag",
    indeterminate: [[0, 0xfff], [0xff000, 0xfffff]], expect: E("unmodelled", "not-evaluable", ["boot-area-at-risk", "boot-code-unknown", "directory-indeterminate", "emulator-result-on-placeholder-bytes", "header-indeterminate", "keySector-indeterminate", "spl-indeterminate", "unmodelled"]) },
];

/** Interrupted harness cycles on the chip-profile engine. `address` and `kind` pick the command, `policy` is the SYNTHETIC outcome applied at the reboot. */
const LIVE = [
  { key: "erase4k-sector-3-old", cycle: { kind: "erase4k", address: 0x3000 }, policy: { kind: "old" }, why: "a harness 4 KiB erase at 0x3000 cut at 50 %, synthetic outcome old: the bytes stay identical, the SPL tail, key blob and gap are still at risk" },
  { key: "erase4k-sector-3-ff", cycle: { kind: "erase4k", address: 0x3000 }, policy: { kind: "ff" }, why: "the same cut with synthetic outcome ff: after the reboot the key blob reads erased, so the derived key differs and the unpacker refuses, but the verdict stays not-evaluable (unknown bytes)" },
  { key: "erase32k-at-0-ff", cycle: { kind: "erase32k", address: 0 }, policy: { kind: "ff" }, why: "a harness 32 KiB erase at 0x0 cut at 50 %, outcome ff: header, directory, SPL, key blob, gap and the first app-area bytes are unknown" },
  { key: "erase64k-at-0xf0000-ff", cycle: { kind: "erase64k", address: 0xf0000 }, policy: { kind: "ff" }, why: "a harness 64 KiB erase at 0xF0000 cut at 50 %, outcome ff: it covers 0xFF000 (unmodelled) and nothing the unpacker reads" },
  { key: "program-gap-new", cycle: { kind: "program", address: 0x3f00 }, policy: { kind: "new" }, why: "a harness 256-byte program of zeros at 0x3F00 cut at 50 %, outcome new: the gap bytes read changed after the reboot but stay unknown, so no boot-area-written flag" },
  { key: "chip-erase-ff", cycle: { kind: "chip-erase" }, policy: { kind: "ff" }, why: "a harness chip erase cut at 50 %, outcome ff: every byte of the flash is unknown" },
  { key: "erase4k-app-sector-4-ff", cycle: { kind: "erase4k", address: 0x4000 }, policy: { kind: "ff" }, why: "a harness 4 KiB erase at 0x4000 (the app area only) cut at 50 %, outcome ff: no boot-area region is touched, the primary label is not-evaluable" },
];

/** Tier by group. The matrix is split by firmware (`tierOf`): the quick tier has a 1.0 s budget for this stage, so only the matrix rows of picovave (the layout whose boot area ends earliest) run there. */
const TIER = { intact: "quick", "inherited-pure": "quick", matrix: "quick", composite: "quick", "interrupted-pure": "quick", "recovery-assumption": "quick", "inherited-live": "full", live: "full", divergence: "full" };
export const GROUPS = Object.freeze(Object.keys(TIER));
export const QUICK_MATRIX_FIRMWARE = "picovave";
const tierOf = (r) => (r.group === "matrix" && r.firmware !== QUICK_MATRIX_FIRMWARE ? "full" : TIER[r.group]);
export const GROUP_TITLES = Object.freeze({
  intact: "Intact references (one package per layout)",
  "inherited-pure": "Inherited from 7B: pure scenarios on Felucca's flash",
  matrix: "Damage matrix: eight damages on the five other layouts",
  composite: "Combined damage on Felucca (precedence)",
  "interrupted-pure": "Interrupted-cycle inputs (indeterminate ranges)",
  "recovery-assumption": "Recovery assumptions (HYPOTHETICAL)",
  "inherited-live": "Inherited from 7B: interrupted erases on the chip-profile engine",
  live: "Interrupted cycles on the chip-profile engine",
  divergence: "Divergence from the engine's own boot",
});

function build() {
  const rows = [];
  const add = (r) => rows.push({ tier: tierOf(r), ...r });
  for (const fw of REPRESENTATIVES) add({ id: `intact.${fw}`, group: "intact", kind: "pure", firmware: fw, why: `the intact ${fw} image diagnosed against its own reference: nothing differs`, ops: [], expect: E("emulator-bootable", "emulator-bootable", ["emulator-bootable"]) });
  for (const s of PURE_SCENARIOS) add({ id: `7b.${s.id}`, group: "inherited-pure", kind: "pure", firmware: "felucca", inherits: s.id, why: s.why, ops: s.ops, indeterminate: s.indeterminate ?? null, expect: s.expect, inherited: true });
  for (const d of MATRIX) for (const fw of REPRESENTATIVES.slice(1)) add({ id: `matrix.${d.key}.${fw}`, group: "matrix", kind: "pure", firmware: fw, why: d.why, ops: d.ops, expect: d.expect });
  for (const c of COMPOSITE) add({ id: `composite.${c.key}`, group: "composite", kind: "pure", firmware: "felucca", why: c.why, ops: c.ops, expect: c.expect });
  for (const i of INTERRUPTED) add({ id: `interrupted.${i.key}`, group: "interrupted-pure", kind: "pure", firmware: i.firmware, why: i.why, ops: [], indeterminate: i.indeterminate, expect: i.expect });
  add({ id: "recovery.sector-0-erased-assumptions", group: "recovery-assumption", kind: "pure", firmware: "felucca", why: "sector 0 erased, diagnosed with each optional recovery assumption: the default assessment never changes and every assumption stays HYPOTHETICAL", ops: [{ kind: "fill", at: 0, len: 4096, value: 0xff }], assumptions: true,
    expect: E("emulator-unbootable", "emulator-unbootable", ["boot-code-unknown", "directory-changed", "emulator-unbootable", "header-changed", "spl-changed", "unpack-refused"], { refusal: REFUSE_NO_KEY }) });
  for (const s of LIVE_SCENARIOS) add({ id: `7b.${s.id}`, group: "inherited-live", kind: "live", firmware: "felucca", inherits: s.id, why: `inherited from 7B: a harness 4 KiB erase at 0x${s.address.toString(16)} cut at 50 %, synthetic outcome ${s.policy.kind}`, cycle: { kind: "erase4k", address: s.address }, policy: s.policy, expect: s.expect, inherited: true });
  for (const l of LIVE) add({ id: `live.${l.key}`, group: "live", kind: "live", firmware: "felucca", why: l.why, cycle: l.cycle, policy: l.policy, expect: LIVE_EXPECT[l.key] });
  add({ id: "divergence.key-blob-changes-key-running", group: "divergence", kind: "divergence-shipped", firmware: "felucca", why: "Felucca with one key-blob bit that changes the derived key: the shipped engine's boot uses the package and runs it, while the diagnostic labels the flash emulator-unbootable (emulator-defined, no hardware claim)",
    ops: [{ kind: "blob-bit", effect: "key" }], expect: E("emulator-unbootable", "emulator-unbootable", ["boot-code-unknown", "derived-key-differs", "emulator-unbootable", "keyBlob-changed", "unpack-refused"], { refusal: REFUSE_RUNS_PAST, keyDiffers: true, engineVerdict: "booted" }) });
  add({ id: "divergence.sector-0-erase-cut-ff-rebooted", group: "divergence", kind: "divergence-chip", firmware: "felucca", why: "after an interrupted sector-0 erase with synthetic outcome ff the rebooted machine still boots from the package, while the diagnostic reports the boot area at risk with an emulator verdict that is not evaluable",
    cycle: { kind: "erase4k", address: 0 }, policy: { kind: "ff" }, expect: E("boot-area-at-risk", "not-evaluable", ["boot-area-at-risk", "boot-code-unknown", "directory-indeterminate", "emulator-result-on-placeholder-bytes", "header-indeterminate", "spl-indeterminate", "unpack-refused"], { engineVerdict: "booted" }) });
  return rows;
}

// Expected results of the new live rows: pinned from a run of the chip-profile engine, reviewed against the classifier's rules (see docs/dev/BOOT-AREA-SCENARIOS.md), not guessed.
const LIVE_EXPECT = {
  "erase4k-sector-3-old": { ranges: [[12288, 16383]], afterCut: E("boot-area-at-risk", "not-evaluable", ["boot-area-at-risk", "boot-code-unknown", "emulator-result-on-placeholder-bytes", "gap-indeterminate", "keyBlob-indeterminate", "spl-indeterminate"]),
    afterReboot: E("boot-area-at-risk", "not-evaluable", ["boot-area-at-risk", "boot-code-unknown", "emulator-result-on-placeholder-bytes", "gap-indeterminate", "keyBlob-indeterminate", "spl-indeterminate"]) },
  "erase4k-sector-3-ff": { ranges: [[12288, 16383]], afterCut: E("boot-area-at-risk", "not-evaluable", ["boot-area-at-risk", "boot-code-unknown", "emulator-result-on-placeholder-bytes", "gap-indeterminate", "keyBlob-indeterminate", "spl-indeterminate"]),
    afterReboot: E("boot-area-at-risk", "not-evaluable", ["boot-area-at-risk", "boot-code-unknown", "derived-key-differs", "emulator-result-on-placeholder-bytes", "gap-indeterminate", "keyBlob-indeterminate", "spl-indeterminate", "unpack-refused"], { refusal: REFUSE_RUNS_PAST, keyDiffers: true }) },
  "erase32k-at-0-ff": { ranges: [[0, 32767]], afterCut: E("boot-area-at-risk", "not-evaluable", ["appArea-indeterminate", "boot-area-at-risk", "boot-code-unknown", "directory-indeterminate", "emulator-result-on-placeholder-bytes", "gap-indeterminate", "header-indeterminate", "keyBlob-indeterminate", "spl-indeterminate"]),
    afterReboot: E("boot-area-at-risk", "not-evaluable", ["appArea-indeterminate", "boot-area-at-risk", "boot-code-unknown", "directory-indeterminate", "emulator-result-on-placeholder-bytes", "gap-indeterminate", "header-indeterminate", "keyBlob-indeterminate", "spl-indeterminate", "unpack-refused"], { refusal: REFUSE_NO_KEY }) },
  "erase64k-at-0xf0000-ff": { ranges: [[983040, 1048575]], afterCut: E("unmodelled", "emulator-bootable", ["boot-area-at-risk", "emulator-bootable", "keySector-indeterminate", "other-indeterminate", "unmodelled"]),
    afterReboot: E("unmodelled", "emulator-bootable", ["boot-area-at-risk", "emulator-bootable", "keySector-indeterminate", "other-indeterminate", "unmodelled"]) },
  "program-gap-new": { ranges: [[16128, 16383]], afterCut: E("boot-area-at-risk", "emulator-bootable", ["boot-area-at-risk", "emulator-bootable", "gap-indeterminate"]),
    afterReboot: E("boot-area-at-risk", "emulator-bootable", ["boot-area-at-risk", "emulator-bootable", "gap-indeterminate"]) },
  "chip-erase-ff": { ranges: [[0, 1048575]], afterCut: E("unmodelled", "not-evaluable", ["appArea-indeterminate", "boot-area-at-risk", "boot-code-unknown", "directory-indeterminate", "emulator-result-on-placeholder-bytes", "gap-indeterminate", "header-indeterminate", "keyBlob-indeterminate", "keySector-indeterminate", "other-indeterminate", "spl-indeterminate", "unmodelled"]),
    afterReboot: E("unmodelled", "not-evaluable", [...["appArea-indeterminate", "boot-area-at-risk", "boot-code-unknown", "directory-indeterminate", "emulator-result-on-placeholder-bytes", "gap-indeterminate", "header-indeterminate", "keyBlob-indeterminate", "keySector-indeterminate", "other-indeterminate", "spl-indeterminate", "unmodelled"], "unpack-refused"], { refusal: REFUSE_NO_KEY }) },
  "erase4k-app-sector-4-ff": { ranges: [[16384, 20479]], afterCut: E("not-evaluable", "not-evaluable", ["appArea-indeterminate", "emulator-result-on-placeholder-bytes"]),
    afterReboot: E("not-evaluable", "not-evaluable", ["appArea-indeterminate", "emulator-result-on-placeholder-bytes", "unpack-refused"], { refusal: REFUSE_RUNS_PAST, keyDiffers: false }) },
};

let catalogue = null;
/** The 90 scenario specs in report order (built once; do not modify). */
export function scenarios() { return (catalogue ??= build()); }

// ---------------------------------------------------------------- expectations
/** Check one classifier report against a pure/divergence row's expectation: the 7B form (has/lacks/...) and the exact form (flags) are both understood. Throws on the first difference. */
export function checkExpect(id, e, r) {
  const fail = (m) => { throw new Error(`${id}: ${m}`); };
  if (r.hardwareBootability !== "unknown") fail("hardwareBootability must stay unknown");
  if (r.recovery.assessment !== "recovery-unknown") fail("the recovery assessment must stay recovery-unknown");
  if (r.primary !== e.primary) fail(`primary ${r.primary}, expected ${e.primary} (flags ${r.flags.join(",")})`);
  if (r.bootability !== e.bootability) fail(`emulator verdict ${r.bootability}, expected ${e.bootability}`);
  if ("flags" in e && e.flags.length && JSON.stringify([...r.flags].sort()) !== JSON.stringify(e.flags)) fail(`flags ${r.flags.join(",")}, expected ${e.flags.join(",")}`);
  for (const f of e.has ?? []) if (!r.flags.includes(f)) fail(`flag ${f} missing (${r.flags.join(",")})`);
  for (const f of e.lacks ?? []) if (r.flags.includes(f)) fail(`flag ${f} must not be present (${r.flags.join(",")})`);
  if ("refusal" in e && r.emulator.refusal !== e.refusal) fail(`refusal ${r.emulator.refusal}, expected ${e.refusal}`);
  if ("keyDiffers" in e && r.emulator.keyDiffers !== e.keyDiffers) fail(`keyDiffers ${r.emulator.keyDiffers}`);
  if ("windowDiffers" in e && r.emulator.windowDiffers !== e.windowDiffers) fail(`windowDiffers ${r.emulator.windowDiffers}`);
  if ("directoryTerminated" in e && r.directory.terminated !== e.directoryTerminated) fail(`directory.terminated ${r.directory.terminated}`);
  if ("directoryEntries" in e && r.directory.entryCount !== e.directoryEntries) fail(`directory.entryCount ${r.directory.entryCount}`);
  for (const [rule, status] of Object.entries(e.rules ?? {})) if (r.rules.find((x) => x.id === rule).status !== status) fail(`rule ${rule}`);
}

// ---------------------------------------------------------------- rows
const sha8 = (u8) => sha256(u8).slice(0, 8);

/** The report fields kept per diagnosis. Raw directory names are not kept (they are bytes of a damaged image). */
export function summarize(r) {
  const regions = {};
  for (const k of REGION_ORDER) { const g = r.regions[k]; if (g.changed || g.indeterminate) regions[k] = { changed: g.changed, indeterminate: g.indeterminate, both: g.both, changedKnown: g.changedKnown }; }
  return {
    primary: r.primary, emulatorVerdict: r.bootability, flags: r.flags, hardwareBootability: r.hardwareBootability, recovery: r.recovery.assessment,
    emulator: { unpack: r.emulator.unpack, refusal: r.emulator.refusal, keyDiffers: r.emulator.keyDiffers, windowDiffers: r.emulator.windowDiffers },
    directory: { terminated: r.directory.terminated, entryCount: r.directory.entryCount },
    splStatus: r.spl.status, splDecode: r.spl.decode, regions,
    rulesApplied: r.rules.filter((x) => x.status === "applies").map((x) => ({ id: x.id, evidence: x.evidence })),
  };
}

function layoutNumber(report) {
  const i = loadLayoutFixture().layouts.findIndex((l) => l.splBody === report.spl.body);
  if (i < 0) throw new Error(`the SPL body ${report.spl.body} is not in the layout fixture`);
  return i + 1;
}

const head = (s) => ({ id: s.id, group: s.group, tier: s.tier, kind: s.kind, firmware: s.firmware, ...(s.inherits ? { inherits: s.inherits } : {}), why: s.why });
const withHash = (row) => ({ ...row, rowSha: text256(JSON.stringify(row)).slice(0, 16) });

/** A pure row (no engine): the firmware's pinned intact image, the damage, the optional indeterminate ranges, one diagnosis. Also returns the raw classifier report for the expectation check. */
export function runPure(s) {
  const { reference, regions } = loadReference(s.firmware);                  // verified against the pinned identity: the wrong reference never gets this far
  const ops = resolveOps(s.ops, regions), image = applyOps(reference, ops), opts = { indeterminate: s.indeterminate ?? null };
  const r = diagnoseImage(image, reference, opts);
  const row = {
    ...head(s), layout: layoutNumber(r),
    input: { damage: ops.map(describeOp), indeterminate: describeRanges(s.indeterminate) },
    identity: { reference: sha8(reference), image: sha8(image) },
    result: summarize(r),
  };
  if (s.assumptions) {
    row.result.assumptions = Object.fromEntries(Object.keys(HYPOTHETICAL_ASSUMPTIONS).map((a) => { const x = diagnoseImage(image, reference, { ...opts, assume: a }); return [a, { primary: x.primary, recovery: x.recovery.assessment, hypothetical: x.recovery.hypothetical }]; }));
  }
  return { row: withHash(row), raw: r };
}

const OPCODES = {
  erase4k: { op: "erase4k", us: (t) => t.se, cmd: (a) => [0x20, (a >> 16) & 255, (a >> 8) & 255, a & 255] },
  erase32k: { op: "erase32k", us: (t) => t.be32, cmd: (a) => [0x52, (a >> 16) & 255, (a >> 8) & 255, a & 255] },
  erase64k: { op: "erase64k", us: (t) => t.be64, cmd: (a) => [0xd8, (a >> 16) & 255, (a >> 8) & 255, a & 255] },
  "chip-erase": { op: "chip-erase", us: (t) => t.ce, cmd: () => [0xc7] },
  program: { op: "program", us: (t) => t.pp, cmd: (a) => [0x02, (a >> 16) & 255, (a >> 8) & 255, a & 255, ...new Array(256).fill(0)] },
};

/** One harness-issued flash cycle on the chip-profile engine, cut at 50 % of the datasheet's typical time; returns the machine after the cut and the machine rebooted with the synthetic outcome. */
export function interruptedCycle(chipEngine, firmware, cycle, policy) {
  const o = OPCODES[cycle.kind];
  if (!o) throw new Error(`unknown cycle ${cycle.kind}`);
  const m = Fm1Machine.boot(chipEngine, catalogPackage(firmware), { usb: false, flashChip: "puya", flashTiming: "typical" });
  m.run(300);
  for (let i = 0; i < 400 && (m.x.fm1_flash_busy() !== 0 || m.x.fm1_flash_wip() !== 0); i++) m.run(3);
  const live = new LiveChip(m);
  m.armFault({ op: o.op, nth: 1, at: { fraction: 0.5 } });
  live.wren();
  live.tx(o.cmd(cycle.address ?? 0));
  live.advance(Math.floor(0.5 * o.us(PROFILES.puya.timingUs.typical)));
  if (!m.powerCut) throw new Error(`${cycle.kind}: the power cut did not fire`);
  return { cut: m, rebooted: m.powerCycle({ outcome: policy }) };
}

const CHIP_WATCH_SECONDS = 0.3, SHIPPED_WATCH_SECONDS = 1;      // the emulated seconds the engine's own boot is watched for in the divergence rows (recorded in the rows)

function diagnoseGuarded(firmware, machine) {
  verifyMachineReference(firmware, machine);
  return diagnoseMachine(machine);
}

/** A live row (chip-profile engine). For the chip divergence row the rebooted machine is then run (after both diagnoses) and its verdict recorded. */
export function runLive(chipEngine, s) {
  const { cut, rebooted } = interruptedCycle(chipEngine, s.firmware, s.cycle, s.policy);
  const afterCut = diagnoseGuarded(s.firmware, cut), afterReboot = diagnoseGuarded(s.firmware, rebooted);
  const row = {
    ...head(s),
    input: { cycle: `${s.cycle.kind}${"address" in s.cycle ? ` at ${hx(s.cycle.address)}` : ""} issued by the harness, power cut at 50 % of the datasheet's typical time`, syntheticOutcome: s.policy.kind },
    identity: { reference: sha8(cut.baseFlash()), afterCut: sha8(cut.flash()), afterReboot: sha8(rebooted.flash()) },
    result: { indeterminate: cut.indeterminateRanges(), afterCut: summarize(afterCut), afterReboot: summarize(afterReboot) },
  };
  if (s.kind === "divergence-chip") { const w = watch(rebooted, { seconds: CHIP_WATCH_SECONDS }); row.result.engineBoot = { verdict: w.verdict, colours: w.final.lcdColours, seconds: CHIP_WATCH_SECONDS }; }
  return { row: withHash(row), raw: { afterCut, afterReboot } };
}

/** The divergence row on the shipped engine: the damaged flash is installed, diagnosed, and then the engine boots it. */
export function runShippedDivergence(engine, s) {
  const pkg = catalogPackage(s.firmware), probe = Fm1Machine.boot(engine, pkg), base = probe.flash();
  const { regions } = loadReference(s.firmware);
  const ops = resolveOps(s.ops, regions), damaged = applyOps(base, ops);
  const m = Fm1Machine.boot(engine, pkg, { sectors: diffSectors(damaged, base) });
  const r = diagnoseGuarded(s.firmware, m);
  const w = watch(m, { seconds: SHIPPED_WATCH_SECONDS });
  const row = {
    ...head(s), layout: layoutNumber(r),
    input: { damage: ops.map(describeOp), indeterminate: [] },
    identity: { reference: sha8(m.baseFlash()), image: sha8(damaged) },
    result: { ...summarize(r), engineBoot: { verdict: w.verdict, colours: w.final.lcdColours, seconds: SHIPPED_WATCH_SECONDS } },
  };
  return { row: withHash(row), raw: r };
}

/** Check a live or divergence-chip row's raw diagnoses against its expectation. */
export function checkLive(s, raw, row) {
  const fail = (m) => { throw new Error(`${s.id}: ${m}`); };
  const e = s.expect;
  if (s.inherited) {                                                                       // the 7B form: primary, regions hit, key sector, changed bytes after the reboot
    const sum = (r, k) => REGION_ORDER.reduce((n, kk) => n + r.regions[kk][k], 0);
    for (const [when, r] of [["after the cut", raw.afterCut], ["after the reboot", raw.afterReboot]]) {
      if (r.primary !== e.primary) fail(`${when}: primary ${r.primary}`);
      if (!r.flags.includes("boot-area-at-risk")) fail(`${when}: the interrupted region must be at risk`);
      if (r.flags.includes("unmodelled") !== e.keySectorTouched) fail(`${when}: unmodelled must be exactly the key sector`);
      for (const k of e.regionHit) if (!(r.regions[k].indeterminate > 0 && r.flags.includes(`${k}-indeterminate`))) fail(`${when}: ${k} must be indeterminate`);
      if (r.hardwareBootability !== "unknown" || r.recovery.assessment !== "recovery-unknown") fail(`${when}: fixed fields`);
      if (sum(r, "indeterminate") !== 4096) fail(`${when}: every unknown byte must be in some region`);
    }
    if (sum(raw.afterCut, "changed") !== 0) fail("the cut machine shows the labelled placeholder: no changed bytes");
    if ((sum(raw.afterReboot, "changed") > 0) !== e.changedAfterReboot) fail(`after the reboot: changed bytes ${sum(raw.afterReboot, "changed")}`);
    return;
  }
  if ("ranges" in e && JSON.stringify(row.result.indeterminate) !== JSON.stringify(e.ranges)) fail(`indeterminate ranges ${JSON.stringify(row.result.indeterminate)}`);
  if (s.kind === "divergence-chip") { checkExpect(s.id, e, raw.afterReboot); if (row.result.engineBoot.verdict !== e.engineVerdict) fail(`engine boot verdict ${row.result.engineBoot.verdict}`); return; }
  checkExpect(`${s.id} (after the cut)`, e.afterCut, raw.afterCut);
  checkExpect(`${s.id} (after the reboot)`, e.afterReboot, raw.afterReboot);
}

// ---------------------------------------------------------------- the report
export const quickSpecs = () => scenarios().filter((s) => s.tier === "quick");
export const fullPureSpecs = () => scenarios().filter((s) => s.tier === "full" && s.kind === "pure");

/** A pure row, checked against its expectation (throws on any disagreement). */
export function runPureChecked(s) { const { row, raw } = runPure(s); checkExpect(s.id, s.expect, raw); return row; }
export function pureRows() { return quickSpecs().map(runPureChecked); }

/** Every row. `engine` = the shipped engine, `chipEngine` = the chip-profile engine or null; without it the 13 live rows and the chip divergence cannot be produced (returned as `skipped`). */
export function buildRows({ engine, chipEngine, specs = scenarios() }) {
  const rows = [], skipped = [];
  for (const s of specs) {
    if (s.kind === "pure") rows.push(runPureChecked(s));
    else if (s.kind === "divergence-shipped") { const { row, raw } = runShippedDivergence(engine, s); checkExpect(s.id, s.expect, raw); if (row.result.engineBoot.verdict !== s.expect.engineVerdict) throw new Error(`${s.id}: engine boot verdict ${row.result.engineBoot.verdict}`); rows.push(row); }
    else if (!chipEngine) { skipped.push(s.id); rows.push(null); }
    else { const { row, raw } = runLive(chipEngine, s); checkLive(s, raw, row); rows.push(row); }
  }
  return { rows, skipped };
}

export const reportSha256 = (rows) => text256(JSON.stringify(rows));

export function buildReport(rows) {
  const counts = { total: rows.length, quick: rows.filter((r) => r.tier === "quick").length, full: rows.filter((r) => r.tier === "full").length, byGroup: Object.fromEntries(GROUPS.map((g) => [g, rows.filter((r) => r.group === g).length])) };
  return {
    version: SCENARIOS_VERSION,
    evidenceLevel: "EMULATOR",
    disclaimer: DISCLAIMER,
    note: "Curated boot-area scenarios (Component 7, Stage 7C): emulator-defined diagnostics under named inputs. hardwareBootability is unknown and the recovery assessment is recovery-unknown in every row. Interrupted-cycle outcomes are synthetic inputs. No firmware bytes are stored; the identities are SHA-256 digests.",
    primaryOrder: PRIMARY_ORDER,
    identities: Object.fromEntries(REPRESENTATIVES.map((fw) => [fw, IDENTITIES[fw]])),
    counts,
    reportSha256: reportSha256(rows),
    rows,
  };
}

/** One row per line inside the rows array: a stable, diff-friendly layout that is still plain JSON. */
export function serializeReport(report) {
  const rows = report.rows;
  const shell = JSON.stringify({ ...report, rows: "@@ROWS@@" }, null, 1);
  return shell.replace('"@@ROWS@@"', "[\n" + rows.map((r) => "  " + JSON.stringify(r)).join(",\n") + "\n ]") + "\n";
}

// ---------------------------------------------------------------- the human-readable summary
const code = (s) => `\`${s}\``;
const cell = (s) => String(s).replace(/\|/g, "\\|");
function resultLines(r) {
  if (r.result.afterReboot) {
    const a = r.result.afterCut, b = r.result.afterReboot;
    const line = (when, x) => `${when}: ${code(x.primary)} / ${code(x.emulatorVerdict)}${x.emulator.refusal ? ` (refusal: ${x.emulator.refusal})` : ""} — ${x.flags.map(code).join(" ") || "no flags"}`;
    return [line("powered off", a), line("after reboot", b)];
  }
  const x = r.result;
  return [`${code(x.primary)} / ${code(x.emulatorVerdict)}${x.emulator.refusal ? ` (refusal: ${x.emulator.refusal})` : ""} — ${x.flags.map(code).join(" ") || "no flags"}`];
}

export function renderSummary(report) {
  const out = [];
  out.push("# Boot-area scenarios (Component 7, Stage 7C)", "");
  out.push("<!-- GENERATED by `node ci/machine/bootareascenarios.mjs --write` from `ci/machine/fixtures/bootarea-scenarios.json`. Do not edit by hand: a test fails if this file differs from what the report renders to. -->", "");
  out.push(`> ${report.disclaimer}`, "");
  out.push("Every row is an **emulator-defined diagnostic result under a named input**. Nothing here says a physical FM-1 would or would not start, and nothing says a damaged unit could or could not be recovered: `hardwareBootability` is `unknown` and the recovery assessment is `recovery-unknown` in every row. The SPL and the mask ROM are never run or modelled; a decoded SPL finding is not a confirmed behaviour. The outcome of an interrupted flash cycle is a **synthetic input** (the datasheets do not say what an interrupted cycle leaves).", "");
  out.push("## How to read a row", "");
  out.push("- **Primary label**, **emulator verdict** and **flags** are shown side by side because the primary label can hide the verdict: the precedence is `" + report.primaryOrder.join("` > `") + "`, so for example a flash that is erased everywhere is labelled `unmodelled` while the emulator verdict still says the unpacker refuses it.", "- **Emulator verdict** is what the emulator's own package-unpacker rules say about the flash image. The engine itself boots from the package and never reads the live flash back, so it can run a flash the verdict calls `emulator-unbootable` (see the divergence rows).", "- `not-evaluable` means unknown bytes lie in what the unpacker reads, or there is no valid reference; it is not a pass.", "- `0xFF000` is package evidence only and every change or unknown byte there is `unmodelled`. `app_dir_head2` is an inferred note that decides nothing.", "");
  out.push("## Reproduction", "", "```bash", "node ci/machine/bootareascenarios.mjs --check        # rebuild and compare with the committed report; live rows are SKIPPED without the chip-profile engine", "node ci/machine/bootareascenarios.mjs --write        # regenerate the report and this summary (needs the chip-profile engine)", "node ci/machine/selftest.mjs --filter \"boot area scenarios\"", "```", "");
  out.push(`Report: ${report.counts.total} rows (${report.counts.quick} quick tier, ${report.counts.full} full tier), \`reportSha256\` ${code(report.reportSha256)}.`, "");
  out.push("| Firmware | Package SHA-256 | Intact image SHA-256 |", "|---|---|---|");
  for (const [fw, id] of Object.entries(report.identities)) out.push(`| ${fw} | ${code(id.package.slice(0, 16))}… | ${code(id.reference.slice(0, 16))}… |`);
  out.push("");
  for (const g of GROUPS) {
    const rows = report.rows.filter((r) => r.group === g);
    const q = rows.filter((r) => r.tier === "quick").length;
    out.push(`## ${GROUP_TITLES[g]} (${rows.length}; ${q ? `${q} quick tier` : ""}${q && q < rows.length ? ", " : ""}${q < rows.length ? `${rows.length - q} full tier` : ""})`, "");
    out.push("| Row | Firmware | Input | Result: primary / emulator verdict — flags |", "|---|---|---|---|");
    for (const r of rows) {
      const input = r.input.damage ? [...r.input.damage, ...r.input.indeterminate.map((x) => `unknown ${x}`)].join("; ") || "none" : `${r.input.cycle}; synthetic outcome ${r.input.syntheticOutcome}`;
      let res = resultLines(r).join("<br>");
      if (r.result.engineBoot) res += `<br>engine boot (${r.result.engineBoot.seconds} s): ${code(r.result.engineBoot.verdict)}, ${r.result.engineBoot.colours} colours — the engine's own boot, not a hardware statement`;
      if (r.result.assumptions) res += "<br>" + Object.entries(r.result.assumptions).map(([a, x]) => `HYPOTHETICAL ${code(a)} → ${code(x.hypothetical.outcome)} (assessment stays ${code(x.recovery)})`).join("<br>");
      out.push(`| ${code(r.id)} | ${r.firmware} | ${cell(input)} | ${cell(res)} |`);
    }
    out.push("");
  }
  out.push("## Evidence", "", "Rules that applied are recorded per row in the report with their evidence labels (`EMULATOR`, `PACKAGE`, `DECODED`, `INFERRED`, `UNKNOWN`). The unpacker's results are `EMULATOR`; the region layout and the `0xFF000` entry are `PACKAGE`; the SPL decode status is `DECODED` and never promoted; the header, SPL, directory and key-blob consequences, the hardware verdict and recovery are `UNKNOWN`.", "");
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------- CLI
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
async function engines() {
  const { loadEngine } = await import("./engine.mjs");
  const { defaultEnginePath } = await import("../engine/verify.mjs");
  const chipPath = defaultEnginePath();
  return { engine: await loadEngine(), chipEngine: existsSync(chipPath) ? await loadEngine({ wasmPath: chipPath, name: "fm1_web_chips.wasm" }) : null, chipPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2), arg = new Set(), opt = {};
  for (let i = 0; i < argv.length; i++) { if (argv[i] === "--fixture" || argv[i] === "--summary-file") opt[argv[i]] = argv[++i]; else arg.add(argv[i]); }
  const bad = [...arg].filter((a) => !["--check", "--write", "--summary", "--json", "--require-live"].includes(a)).concat(Object.entries(opt).filter(([, v]) => !v).map(([k]) => k));
  if (bad.length) { console.error(`usage: node ci/machine/bootareascenarios.mjs [--check] [--write] [--summary] [--json] [--require-live] [--fixture FILE] [--summary-file FILE] (bad: ${bad.join(" ")})`); process.exit(2); }
  const fixturePath = opt["--fixture"] ? resolve(opt["--fixture"]) : FIXTURE_PATH, summaryPath = opt["--summary-file"] ? resolve(opt["--summary-file"]) : SUMMARY_PATH;
  if (arg.has("--summary")) process.stdout.write(renderSummary(readJson(fixturePath)));
  else if (arg.has("--json")) process.stdout.write(readFileSync(fixturePath, "utf8"));
  else if (arg.has("--write")) {
    const { engine, chipEngine, chipPath } = await engines();
    if (!chipEngine) { console.error(`refusing to write: the chip-profile engine is not built (${chipPath}), so the 13 live rows and the chip divergence could not be produced and the report would be incomplete`); process.exit(2); }
    const { rows } = buildRows({ engine, chipEngine }), report = buildReport(rows);
    mkdirSync(resolve(FIXTURE_PATH, ".."), { recursive: true });
    writeFileSync(FIXTURE_PATH, serializeReport(report));
    writeFileSync(SUMMARY_PATH, renderSummary(report));
    console.log(`wrote ${FIXTURE_PATH} (${rows.length} rows, reportSha256 ${report.reportSha256})\nwrote ${SUMMARY_PATH}`);
  } else {
    const { engine, chipEngine } = await engines();
    const have = readJson(fixturePath), { rows, skipped } = buildRows({ engine, chipEngine });
    let bad2 = 0;
    const ids = scenarios().map((s) => s.id);
    if (JSON.stringify(have.rows.map((r) => r.id)) !== JSON.stringify(ids)) { console.error("the committed rows are not the catalogue's rows"); bad2++; }
    rows.forEach((r, i) => { if (r && JSON.stringify(r) !== JSON.stringify(have.rows[i])) { console.error(`row ${ids[i]} differs from the committed report`); bad2++; } });
    if (reportSha256(have.rows) !== have.reportSha256) { console.error("the committed reportSha256 does not match its rows"); bad2++; }
    if (readFileSync(summaryPath, "utf8").replace(/\r\n/g, "\n") !== renderSummary(have)) { console.error("the committed summary differs from what the report renders to: run with --write"); bad2++; }
    console.log(`${rows.length - skipped.length} of ${rows.length} rows rebuilt${bad2 ? `, ${bad2} DIFFERENCE(S)` : " and identical to the committed report"}; summary ${bad2 ? "checked" : "reproduces"}`);
    if (skipped.length) console.log(`SKIPPED ${skipped.length} rows (the chip-profile engine is not built; a skipped row is not a passed row): ${skipped.join(", ")}`);
    process.exit(bad2 ? 1 : skipped.length && arg.has("--require-live") ? 1 : 0);
  }
}
