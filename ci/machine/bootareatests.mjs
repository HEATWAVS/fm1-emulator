// Tests of the boot-area diagnostic (Component 7, Stage 7B). Every result is an emulator-defined diagnostic, never a statement about a physical FM-1: the tests pin what the classifier
// says under named inputs, and that it never says more (hardwareBootability stays "unknown", recovery stays "recovery-unknown", the nine undecoded SPL packages stay boot-code-unknown).
//
// Quick tier (`npm test`; shipped engine, no chip engine): the rule table and vocabulary, the committed layout fixture against the 7A facts, the pure scenarios on Felucca's flash, the
// intact images of the 17 surveyed firmware and the nine undecoded-SPL packages, reference handling, count independence, recovery defaults, the survey evidence of no observed boot-area
// writes, the machine adapter (read-only: a call spy and a before/after snapshot) and the pinned divergence from the engine's boot (the engine still boots a zeroed sector 0).
// Full tier: all 277 intact packages, the fixture regenerated from the catalogue, the nine packages with damaged SPL bodies, the running divergence, and (chip-profile engine only,
// SKIPPED without it) interrupted sector-0 and 0xFF000 erases with the approved synthetic outcome policies.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Fm1Machine, corruptedSectors } from "./machine.mjs";
import { watch } from "./monitor.mjs";
import { LiveChip } from "./chiplive.mjs";
import { PROFILES } from "./chipspec.mjs";
import { DEFAULT_SET, catalogPackage } from "./firmware-survey.mjs";
import { chipKey, unpackFlash, CHIP_KEY_VECTORS } from "./fwscport.mjs";
import { classify, deriveLayout, RULES, EVIDENCE_LEVELS, PRIMARY_ORDER, REGION_ORDER, BOOT_AREA_REGIONS, HYPOTHETICAL_ASSUMPTIONS, HARDWARE_BOOTABILITY, DISCLAIMER, SPL_STATUS, FLASH_BYTES } from "./bootarea.mjs";
import { diagnoseImage, diagnoseMachine, loadLayoutFixture, READ_ONLY_INTERFACES } from "./bootareadiag.mjs";
import { PURE_SCENARIOS, LIVE_SCENARIOS, PURE_FIRMWARE, paddedFlash, applyOps, catalogueEntries, buildLayoutFixture, serializeLayout, findings, syntheticUnterminatedImage, LAYOUT_PATH } from "./bootareacatalogue.mjs";
import { SURVEY_PATH } from "./recoveryfixture.mjs";

const sha = (u8) => createHash("sha256").update(u8).digest("hex").slice(0, 16);
const pad = (id) => paddedFlash(catalogPackage(id));
const diag = (image, reference, options) => diagnoseImage(image, reference, options);
const bitwise = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** What a pure scenario's report must be, from its catalogue entry (the one place the expectation is turned into assertions). */
function assertScenario(s, r) {
  const e = s.expect, id = s.id;
  assert.equal(r.hardwareBootability, "unknown", `${id}: hardware bootability is never inferred`);
  assert.equal(r.primary, e.primary, `${id}: primary label (flags ${r.flags.join(",")})`);
  assert.equal(r.bootability, e.bootability, `${id}: emulator verdict`);
  for (const f of e.has ?? []) assert.ok(r.flags.includes(f), `${id}: flag ${f} missing (${r.flags.join(",")})`);
  for (const f of e.lacks ?? []) assert.ok(!r.flags.includes(f), `${id}: flag ${f} must not be present (${r.flags.join(",")})`);
  if ("refusal" in e) assert.equal(r.emulator.refusal, e.refusal, `${id}: the emulator's refusal reason`);
  if ("keyDiffers" in e) assert.equal(r.emulator.keyDiffers, e.keyDiffers, `${id}: derived key differs`);
  if ("windowDiffers" in e) assert.equal(r.emulator.windowDiffers, e.windowDiffers, `${id}: decrypted window differs`);
  if ("directoryTerminated" in e) assert.equal(r.directory.terminated, e.directoryTerminated, `${id}: directory termination`);
  if ("directoryEntries" in e) assert.equal(r.directory.entryCount, e.directoryEntries, `${id}: heads the walk read`);
  for (const [rule, status] of Object.entries(e.rules ?? {})) assert.equal(r.rules.find((x) => x.id === rule).status, status, `${id}: rule ${rule}`);
  assert.equal(r.recovery.assessment, "recovery-unknown", id);
  for (const rule of r.rules) { assert.ok(rule.evidence.length > 0 && rule.evidence.every((l) => EVIDENCE_LEVELS.includes(l)), `${id}: rule ${rule.id} names valid evidence labels`); assert.ok(["applies", "clear", "not-evaluable"].includes(rule.status), `${id}: ${rule.id} status`); }
}

/** A machine's observable state, read without side effects (observe() is NOT used: it clears the audio accumulators). */
function snapshot(m) {
  const x = m.x, chip = !!(m.flashChipInfo && m.engine.capabilities.faultInjection);
  return {
    flash: sha(m.flash()), base: sha(m.baseFlash()), frames: m.frames, audio: { ...m.audio }, status: m.status, halted: m.halted, ms: x.fm1_ms(), idle: x.fm1_idle_ms?.() ?? null,
    lcdRevision: x.fm1_lcd_revision(), flashRevision: x.fm1_flash_revision(), faultInfo: m.faultInfo === null ? null : { ...m.faultInfo }, faultOutcome: m.faultOutcome === null ? null : "set",
    chip: chip ? { cycles: m.cycles(), wip: m.flashWip(), nv: x.fm1_flash_nv_status() >>> 0, indeterminate: m.indeterminateRanges(), state: JSON.stringify(m.faultState()) } : null,
  };
}

/** Run `fn(spy)` with the machine behind a call spy; returns what was called and read. */
function spied(machine, fn) {
  const calls = [], props = [];
  const spy = new Proxy(machine, {
    get(t, p) {
      const v = t[p];
      if (typeof v === "function") return (...a) => { calls.push(String(p)); return v.apply(t, a); };
      props.push(String(p));
      return v;
    },
  });
  return { result: fn(spy), calls, props };
}

export function registerBootAreaQuickTests(testQuick, { engine }) {
  const T = (name, fn) => testQuick(`boot area: ${name}`, fn);

  T("the rule table and vocabulary: every rule names its evidence labels and consequence; hardware and recovery are UNKNOWN; app_dir_head2 is INFERRED and decides nothing", () => {
    assert.deepEqual(EVIDENCE_LEVELS, ["EMULATOR", "PACKAGE", "DECODED", "INFERRED", "DOCUMENTED", "UNKNOWN"]);
    assert.deepEqual(PRIMARY_ORDER, ["unmodelled", "boot-area-at-risk", "emulator-unbootable", "boot-code-unknown", "boot-area-written", "emulator-bootable"], "the approved precedence");
    assert.equal(HARDWARE_BOOTABILITY, "unknown");
    assert.equal(SPL_STATUS, "boot-code-unknown");
    assert.equal(new Set(RULES.map((r) => r.id)).size, RULES.length, "rule ids are unique");
    for (const r of RULES) {
      assert.ok(r.evidence.length > 0 && r.evidence.every((l) => EVIDENCE_LEVELS.includes(l)), `${r.id}: evidence labels`);
      assert.ok(r.consequence.length > 0 && r.says.length > 30, `${r.id}: consequence and wording`);
    }
    const rule = (id) => RULES.find((r) => r.id === id);
    assert.deepEqual(rule("app-dir-head2").evidence, ["INFERRED"]);
    assert.equal(rule("app-dir-head2").consequence, "none", "app_dir_head2 supports no label");
    assert.match(rule("app-dir-head2").says, /no claim of redundancy, fallback or recovery/);
    assert.deepEqual(rule("hardware-bootability").evidence, ["UNKNOWN"]);
    assert.deepEqual(rule("recovery").evidence, ["UNKNOWN"]);
    assert.ok(rule("emulator-unpack-refuses").evidence.length === 1 && rule("emulator-unpack-refuses").evidence[0] === "EMULATOR", "a refusal rests on the emulator alone");
    assert.deepEqual(rule("key-sector-touched").evidence, ["PACKAGE", "UNKNOWN"], "0xFF000 is named by the package only");
    assert.equal(rule("key-sector-touched").consequence, "unmodelled");
    assert.equal(rule("header-touched").consequence, "boot-code-unknown");
    assert.equal(rule("gap-written").consequence, "boot-area-written");
    assert.equal(rule("spl-touched").consequence, "boot-code-unknown", "a changed SPL is never emulator-unbootable merely for differing");
    for (const label of ["spl-touched", "header-touched"]) assert.ok(!rule(label).evidence.includes("EMULATOR") || rule(label).consequence !== "emulator-unbootable");
    assert.match(DISCLAIMER, /not a statement about a physical FM-1/);
    assert.match(DISCLAIMER, /hardwareBootability is always unknown/);
  });

  T("key derivation boundaries: the known-answer blobs give the keys the ENGINE derives (fwscportcheck.mjs proves that against the shipped engine)", () => {
    assert.equal(CHIP_KEY_VECTORS.length, 7);
    for (const v of CHIP_KEY_VECTORS) {
      const blob = Uint8Array.from(Buffer.from(v.blob, "hex"));
      assert.equal(blob.length, 32, v.pins);
      assert.equal(chipKey(blob), v.key, v.pins);
    }
  });

  T("the layout fixture agrees with the 7A facts: six layouts, 277 packages, nine undecoded SPL packages, structure only", () => {
    const f = loadLayoutFixture(), facts = JSON.parse(readFileSync(new URL("./fixtures/bootarea-facts.json", import.meta.url), "utf8")), fin = findings();
    assert.equal(f.version, 1);
    assert.equal(f.evidenceLevel, "PACKAGE");
    assert.equal(f.packages, 277);
    assert.deepEqual(f.layouts.map((l) => l.packages).sort((a, b) => b - a), [267, 5, 2, 1, 1, 1]);
    assert.equal(f.layouts.reduce((n, l) => n + l.packages, 0), 277);
    assert.deepEqual(f.layouts.map((l) => l.packages).sort(), facts.directoryLayouts.map((l) => l.packages).sort());
    assert.deepEqual(f.layouts.map((l) => l.splBody.split(":")[1] | 0).sort((a, b) => a - b), facts.ubootBodies.map((b) => b.size).sort((a, b) => a - b), "one layout per uboot.boot body size");
    for (const l of f.layouts) {
      assert.deepEqual(l.regions.header, [[0, 32]]);
      assert.equal(l.regions.directory[0][0], 32);
      assert.equal(l.appOffset, 0x4000);
      assert.deepEqual(l.regions.keySector, [[0xff000, 0x100000]]);
      assert.equal(l.keySectorFromHead, true, "every package's key_mac head names the key sector");
    }
    assert.equal(f.undecodedSplPackages.count, 9);
    assert.equal(f.undecodedSplPackages.splStatus, "boot-code-unknown");
    assert.deepEqual(f.undecodedSplPackages.packages.map((p) => p.id), fin.undecodedSplPackages.packages.map((p) => p.id).sort(), "the nine of the 7A findings");
    assert.deepEqual(f.undecodedSplPackages.packages.map((p) => p.id), ["audiorouter", "b1", "beetle", "beetleblue", "clatter", "dx747", "etch", "picovave", "rupture"]);
    assert.equal(f.splStatus, "boot-code-unknown");
    assert.equal(Object.values(f.splDecode).filter((v) => v !== "decoded-code-like").length, 4, "four bodies not decodable under the tried transforms");
    assert.ok(!/[0-9a-f]{12,}/.test(readFileSync(LAYOUT_PATH, "utf8")), "no hash longer than 8 hex digits and no byte string is stored");
  });

  T("the scenario catalogue is well formed: unique ids, a reason for each, valid labels and flags, every primary label exercised", () => {
    assert.equal(PURE_SCENARIOS.length, 16);
    assert.equal(new Set(PURE_SCENARIOS.map((s) => s.id)).size, PURE_SCENARIOS.length);
    const flagWords = new Set([...PRIMARY_ORDER, "unpack-refused", "key-blob-crc-fails", "derived-key-differs", "app-window-differs", "directory-unterminated", "no-reference", "image-length-differs", "emulator-result-on-placeholder-bytes", ...REGION_ORDER.flatMap((k) => [`${k}-changed`, `${k}-indeterminate`])]);
    for (const s of PURE_SCENARIOS) {
      assert.ok(s.why.length > 30, s.id);
      assert.ok(PRIMARY_ORDER.includes(s.expect.primary) || s.expect.primary === "not-evaluable", s.id);
      for (const f of [...(s.expect.has ?? []), ...(s.expect.lacks ?? [])]) assert.ok(flagWords.has(f), `${s.id}: unknown flag ${f}`);
      assert.ok(!(s.expect.has ?? []).some((f) => (s.expect.lacks ?? []).includes(f)), `${s.id}: a flag is both required and forbidden`);
    }
    assert.deepEqual([...new Set(PURE_SCENARIOS.map((s) => s.expect.primary))].sort(), [...PRIMARY_ORDER].sort(), "every primary label is exercised by a scenario");
    assert.equal(LIVE_SCENARIOS.length, 6);
    assert.deepEqual([...new Set(LIVE_SCENARIOS.map((s) => s.policy.kind))].sort(), ["ff", "old", "zero"]);
  });

  T("pure scenarios on Felucca's flash: every damage, its primary label, the emulator verdict, the flags and the exact refusal", () => {
    const ref = pad(PURE_FIRMWARE);
    for (const s of PURE_SCENARIOS) {
      const image = applyOps(ref, s.ops);
      assertScenario(s, diag(image, ref, { indeterminate: s.indeterminate ?? null }));
    }
  });

  T("the app area's boundaries come from the reference's decrypted window: its last byte is the app area, the byte after is not", () => {
    const ref = pad("felucca"), r0 = diag(ref, ref), win = r0.emulator.referenceUnpack.appWindowBytes;
    assert.deepEqual(r0.regions.appArea.ranges, [[0x4000, 0x4000 + win]]);
    assert.equal(r0.regions.appArea.bytes, win);
    const last = ref.slice(); last[0x4000 + win - 1] ^= 1;
    const a = diag(last, ref);
    assert.ok(a.flags.includes("appArea-changed") && a.flags.includes("app-window-differs") && !a.flags.includes("other-changed"), a.flags.join(","));
    assert.equal(a.emulator.windowDifferingBytes, 1);
    const after = ref.slice(); after[0x4000 + win] ^= 1;
    const b = diag(after, ref);
    assert.ok(b.flags.includes("other-changed") && !b.flags.includes("appArea-changed") && !b.flags.includes("app-window-differs"), b.flags.join(","));
    const first = ref.slice(); first[0x4000] ^= 1;
    assert.ok(diag(first, ref).flags.includes("appArea-changed") && !diag(first, ref).flags.includes("gap-changed"), "the first byte of the app area is not the gap");
    assert.ok(diag(ref.slice().fill(0, 0x3fff, 0x4000), ref).flags.includes("gap-changed"), "the byte before it is the gap");
  });

  T("an unterminated directory: a reference whose walk never terminates is refused, and a damaged image with one makes the rules that depend on what its directory found not-evaluable", () => {
    const syn = syntheticUnterminatedImage(), u = unpackFlash(syn);
    assert.equal(u.ok, true, "the synthetic image is one the emulator's unpacker accepts");
    assert.equal(u.entries.length, 31, "the walk ran to the end of the image");
    assert.equal(u.entries[u.entries.length - 1].last, false);
    assert.equal(u.keyFromFallback, true);
    const asRef = deriveLayout(syn);
    assert.equal(asRef.ok, false, "no region boundary is derived from a reference whose directory never terminates");
    assert.match(asRef.error, /terminating head/);
    assert.equal(diag(syn, syn).primary, "not-evaluable");
    const ref = pad("felucca"), r = diag(syn, ref);
    assert.equal(r.directory.terminated, false);
    assert.equal(r.emulator.unpack, "accepted", "the emulator's own unpacker accepted it");
    assert.ok(r.flags.includes("directory-unterminated") && r.flags.includes("key-blob-crc-fails"));
    const st = (id) => r.rules.find((x) => x.id === id).status;
    assert.equal(st("directory-unterminated"), "applies");
    for (const id of ["key-blob-crc-fails", "derived-key-differs", "app-window-differs"]) assert.equal(st(id), "not-evaluable", id);
    assert.equal(r.regions.header.ranges[0][1], 32, "every region boundary still comes from the reference");
  });

  T("the classifier is pure and deterministic: inputs are never modified, the same inputs give the same report", () => {
    const ref = pad("felucca"), image = applyOps(ref, [{ kind: "fill", at: 0, len: 4096, value: 0 }]), r0 = ref.slice(), i0 = image.slice(), ranges = [[10, 20], [30, 40]];
    const a = diag(image, ref, { indeterminate: ranges }), b = diag(image, ref, { indeterminate: ranges });
    assert.deepEqual(a, b);
    assert.ok(bitwise(ref, r0) && bitwise(image, i0), "image and reference untouched");
    assert.deepEqual(ranges, [[10, 20], [30, 40]], "ranges untouched");
    assert.doesNotThrow(() => JSON.stringify(a));
  });

  T("intact images: the 17 surveyed firmware and the nine undecoded-SPL packages are emulator-bootable, derive their layout from their own directory and match the fixture", () => {
    const fx = loadLayoutFixture(), ids = new Set([...DEFAULT_SET, ...fx.undecodedSplPackages.packages.map((p) => p.id)]);
    let n = 0;
    for (const id of ids) {
      const ref = pad(id), r = diag(ref, ref);
      n++;
      assert.equal(r.primary, "emulator-bootable", id);
      assert.deepEqual(r.flags, ["emulator-bootable"], `${id}: no detail flag on an intact image`);
      assert.equal(r.hardwareBootability, "unknown");
      assert.equal(r.emulator.keyDiffers, false);
      assert.equal(r.emulator.windowDiffers, false);
      assert.equal(r.emulator.referenceUnpack.key, 0x980f, `${id}: the key every package derives`);
      for (const k of REGION_ORDER) assert.deepEqual([r.regions[k].changed, r.regions[k].indeterminate, r.regions[k].both], [0, 0, 0], `${id}: ${k}`);
      assert.deepEqual(r.regions.gap.allIntactBytesFF, true, `${id}: the gap holds only 0xFF`);
      const key = r.spl.body, layout = fx.layouts.find((l) => l.splBody === key);
      assert.ok(layout, `${id}: its SPL body ${key} is in the fixture`);
      for (const k of BOOT_AREA_REGIONS) assert.deepEqual(r.regions[k].ranges, layout.regions[k], `${id}: ${k} ranges`);
      assert.equal(r.spl.status, "boot-code-unknown", `${id}: SPL status is boot-code-unknown for every package`);
      assert.equal(r.spl.decode, fx.splDecode[key]);
    }
    assert.ok(n >= 17 + 9 - 2, "the surveyed set and the nine (beetle is in both)");
  });

  T("the nine undecoded-SPL packages keep boot-code-unknown: their SPL status, and a changed or uncertain body, are never judged", () => {
    const fx = loadLayoutFixture();
    for (const { id, body } of fx.undecodedSplPackages.packages) {
      const ref = pad(id), l = deriveLayout(ref), spl = l.regions.spl[0];
      assert.equal(fx.splDecode[body], "not-decodable-under-tried-transforms", id);
      const changed = ref.slice(); changed[spl.lo + 5] ^= 0x10;
      const c = diag(changed, ref);
      assert.equal(c.primary, "boot-code-unknown", `${id}: a changed SPL body is boot-code-unknown`);
      assert.ok(c.flags.includes("spl-changed") && !c.flags.includes("emulator-unbootable"), id);
      const u = diag(ref, ref, { indeterminate: [[spl.lo, spl.lo + 63]] });
      assert.equal(u.primary, "boot-area-at-risk", id);
      assert.ok(u.flags.includes("boot-code-unknown"), id);
    }
  });

  T("a missing or invalid reference gives per-rule diagnostics only and not-evaluable bootability; the image's own unpack facts are still reported", () => {
    const ref = pad("felucca"), refused = applyOps(ref, [{ kind: "fill", at: 0, len: 4096, value: 0 }]);
    for (const [what, bad] of [["null", null], ["undefined", undefined], ["empty", new Uint8Array(0)], ["not an image", new Uint8Array(100).fill(7)], ["zeros", new Uint8Array(FLASH_BYTES)], ["a refused image", refused]]) {
      const r = diag(ref, bad);
      assert.equal(r.primary, "not-evaluable", what);
      assert.equal(r.bootability, "not-evaluable", what);
      assert.equal(r.reference.valid, false, what);
      assert.ok(r.reference.error.length > 10, what);
      assert.ok(r.flags.includes("no-reference"), what);
      assert.ok(!r.flags.includes("emulator-bootable") && !r.flags.includes("emulator-unbootable"), `${what}: no verdict without a reference`);
      assert.equal(r.regions, null, `${what}: regions need the reference`);
      assert.equal(r.hardwareBootability, "unknown");
      assert.equal(r.emulator.unpack, "accepted", `${what}: the image's own unpack result is reported`);
      assert.equal(r.emulator.keyDerived, 0x980f);
      assert.ok(r.rules.filter((x) => x.status === "not-evaluable").length >= RULES.length - 3, `${what}: dependent rules are not-evaluable`);
    }
    const r = diag(refused, null);
    assert.equal(r.emulator.unpack, "refused");
    assert.equal(r.emulator.refusal, "no chip key or app area in the flash image");
    assert.equal(r.primary, "not-evaluable", "a refusal alone is not a verdict without a reference");
    const risk = diag(ref, null, { indeterminate: [[0xff000, 0xff0ff]] });
    assert.ok(risk.flags.includes("boot-area-at-risk"), "unknown bytes in a fixed zone are still flagged");
    assert.equal(risk.primary, "not-evaluable");
    assert.equal(risk.fixedZones.keySector.indeterminate, 256);
    assert.throws(() => classify("nope", ref), RangeError);
  });

  T("changed and indeterminate counts stay independent per region, and indeterminate ranges take precedence without erasing the changed evidence", () => {
    const ref = pad("felucca"), image = ref.slice();
    image.fill(0x00, 0, 0x1000);                                 // sector 0: header, directory and the first of the SPL
    const ranges = [[0x40, 0x7ff], [0xff000, 0xff0ff]];          // the second head on to 0x7FF (directory and the first of the SPL), not the header and not the rest of sector 0; and 0xFF000
    const r = diag(image, ref, { indeterminate: ranges });
    // an independent oracle: per byte, the first region (in REGION_ORDER) whose ranges contain it
    const own = (i) => { for (const k of REGION_ORDER) if (k !== "other" && r.regions[k].ranges.some(([lo, hi]) => i >= lo && i < hi)) return k; return "other"; };
    const want = Object.fromEntries(REGION_ORDER.map((k) => [k, { changed: 0, indeterminate: 0, both: 0 }]));
    for (const i of [...Array(0x2000).keys(), ...Array(0x100).keys().map((n) => 0xff000 + n)]) {          // every byte that is changed or unknown lies here; the rest of the flash is equal and known
      const c = image[i] !== ref[i], u = ranges.some(([lo, hi]) => i >= lo && i <= hi), k = own(i);
      if (c) want[k].changed++; if (u) want[k].indeterminate++; if (c && u) want[k].both++;
    }
    for (const k of REGION_ORDER) {
      assert.deepEqual({ changed: r.regions[k].changed, indeterminate: r.regions[k].indeterminate, both: r.regions[k].both }, want[k], `counts of ${k}`);
      assert.equal(r.regions[k].changedKnown, want[k].changed - want[k].both, `${k}: changedKnown`);
    }
    assert.ok(r.regions.spl.indeterminate > 0 && r.regions.spl.changed > 0, "SPL has both");
    assert.ok(r.regions.spl.both > 0 && r.regions.spl.both < r.regions.spl.changed, "and the two overlap only partly: neither count absorbs the other");
    assert.ok(r.regions.directory.both > 0 && r.regions.directory.both < r.regions.directory.changed, "the directory too (its first head lies below the unknown range)");
    assert.ok(r.regions.spl.changedKnown > 0 && r.regions.spl.changedKnown === r.regions.spl.changed - r.regions.spl.both);
    assert.ok(r.regions.header.changed > 0 && r.regions.header.both === 0 && r.regions.header.changedKnown === r.regions.header.changed, "header: changed, never unknown, so every changed byte counts as written");
    assert.equal(r.regions.keySector.changed, 0);
    assert.equal(r.regions.keySector.indeterminate, 256);
    assert.equal(r.primary, "unmodelled", "unknown bytes at 0xFF000 outrank the sector-0 risk");
    for (const f of ["unmodelled", "boot-area-at-risk", "boot-code-unknown", "keySector-indeterminate", "spl-changed", "spl-indeterminate", "directory-indeterminate"]) assert.ok(r.flags.includes(f), f);
    // a byte that is changed AND unknown is not evidence of a write: with every changed byte covered by an unknown range, nothing is "changed"
    const cover = diag(image, ref, { indeterminate: [[0, 0x1fff]] });
    assert.ok(cover.regions.spl.changedKnown === 0 && cover.regions.spl.changed > 0, "changed but all unknown: changed is kept, changedKnown is 0");
    assert.ok(!cover.flags.includes("spl-changed") && cover.flags.includes("spl-indeterminate"), "unknown beats changed for the rule, the changed count is still reported");
    // overlapping or touching ranges are merged: no byte is counted twice
    const merged = diag(ref, ref, { indeterminate: [[0, 99], [50, 149], [150, 199]] });
    assert.equal(merged.regions.header.indeterminate + merged.regions.directory.indeterminate + merged.regions.spl.indeterminate, 200);
    assert.throws(() => diag(ref, ref, { indeterminate: [[5, 1]] }), RangeError);
    assert.throws(() => diag(ref, ref, { indeterminate: [[-1, 1]] }), RangeError);
    assert.throws(() => diag(ref, ref, { indeterminate: [[1.5, 2]] }), RangeError);
    assert.throws(() => diag(ref, ref, { indeterminate: "x" }), RangeError);
  });

  T("recovery: the default assessment is recovery-unknown (UNKNOWN); an assumption is labelled HYPOTHETICAL, names its outcome and never changes the default", () => {
    const ref = pad("felucca"), zeroed = applyOps(ref, [{ kind: "fill", at: 0, len: 4096, value: 0 }]);
    const base = diag(zeroed, ref);
    assert.deepEqual(base.recovery, { assessment: "recovery-unknown", evidence: "UNKNOWN", reason: base.recovery.reason, hypothetical: null });
    for (const [name, outcome] of Object.entries(HYPOTHETICAL_ASSUMPTIONS)) {
      const h = diag(zeroed, ref, { assume: name });
      assert.equal(h.recovery.assessment, "recovery-unknown", name);
      assert.equal(h.recovery.evidence, "UNKNOWN");
      assert.equal(h.recovery.hypothetical.HYPOTHETICAL, true);
      assert.equal(h.recovery.hypothetical.assumption, name);
      assert.equal(h.recovery.hypothetical.outcome, outcome);
      assert.equal(h.recovery.hypothetical.evidence, "UNKNOWN", "an assumption is not evidence");
      assert.match(h.recovery.hypothetical.note, /HYPOTHETICAL/);
      const { recovery: _a, ...rest } = h, { recovery: _b, ...baseRest } = base;
      assert.deepEqual(rest, baseRest, `${name}: nothing but recovery.hypothetical changes`);
    }
    assert.deepEqual(Object.keys(HYPOTHETICAL_ASSUMPTIONS), ["download-mode-available", "external-programmer-available", "pessimistic-no-recovery-path"]);
    assert.equal(HYPOTHETICAL_ASSUMPTIONS["pessimistic-no-recovery-path"], "unrecoverable");
    assert.equal(diag(ref, ref, { assume: "pessimistic-no-recovery-path" }).recovery.hypothetical.outcome, "nothing-to-recover", "an intact image has nothing to recover, whatever the assumption");
    assert.equal(diag(ref, ref, { assume: "pessimistic-no-recovery-path" }).recovery.assessment, "recovery-unknown");
    assert.throws(() => diag(zeroed, ref, { assume: "magic" }), RangeError);
    assert.equal(diag(zeroed, ref).recovery.hypothetical, null, "no assumption, no hypothetical");
  });

  T("survey evidence (EMULATOR observation): in the 8 s survey no firmware-issued flash cycle touches the boot region (below 0x4000 or at/above 0xFF000)", () => {
    if (!existsSync(SURVEY_PATH)) throw new Error(`${SURVEY_PATH} is missing: the survey evidence cannot be checked`);
    const s = JSON.parse(readFileSync(SURVEY_PATH, "utf8"));
    let cycles = 0, inBoot = 0, min = Infinity, max = -1;
    const firmware = new Set();
    for (const [unit, v] of Object.entries(s.units)) for (const c of v.cycles) {
      cycles++; firmware.add(unit.split("/")[0]);
      const [lo, hi] = c.firstRange;
      min = Math.min(min, lo); max = Math.max(max, hi);
      if (lo < 0x4000 || hi >= 0xff000) inBoot++;
    }
    assert.equal(cycles, 61, "the 61 firmware-issued cycles of the survey (both chips)");
    assert.equal(firmware.size, 7, "from the seven firmware that issue any");
    assert.equal(inBoot, 0, "none touches the boot region");
    assert.ok(min >= 0x4000 && max < 0xff000, `the cycles lie within 0x${min.toString(16)}..0x${max.toString(16)}`);
    assert.equal(s.config.driveMs, 8000, "the 8 s input script: this says nothing about other input or longer runs");
  });

  T("the machine adapter reads only flash(), baseFlash() and indeterminateRanges(), and a diagnosis changes nothing in the machine", () => {
    assert.deepEqual([...READ_ONLY_INTERFACES], ["flash", "baseFlash", "indeterminateRanges"]);
    const m = Fm1Machine.boot(engine, catalogPackage("felucca"), { usb: false });
    const before = snapshot(m), flashBefore = m.flash(), baseBefore = m.baseFlash();
    const { result, calls, props } = spied(m, (spy) => diagnoseMachine(spy));
    assert.deepEqual(calls.filter((c, i) => calls.indexOf(c) === i).sort(), ["baseFlash", "flash"], "the shipped engine has no fault list: only the two flash reads");
    assert.ok(props.every((p) => ["engine", "flashChipInfo"].includes(p)), `only the engine's capability table and the chip info are read (${props.join(",")})`);
    assert.deepEqual(snapshot(m), before, "no state of the machine changed");
    assert.ok(bitwise(m.flash(), flashBefore) && bitwise(m.baseFlash(), baseBefore));
    assert.equal(result.primary, "emulator-bootable");
    assert.equal(result.source.indeterminate, "none (no fault-injection chip profile on this machine)");
    assert.equal(result.source.reference, "the machine's base flash (the package as installed)");
    assert.equal(diagnoseMachine(m).primary, "emulator-bootable", "diagnosing twice is harmless");
    assert.deepEqual(snapshot(m), before);
    // an explicit reference and an explicit none
    assert.equal(diagnoseMachine(m, { reference: null }).primary, "not-evaluable");
    assert.equal(diagnoseMachine(m, { reference: null }).source.reference, "none");
    assert.deepEqual(snapshot(m), before);
  });

  T("DIVERGENCE: the engine still boots a machine whose sector 0 is zeroed, while the diagnostic labels that flash emulator-unbootable (the unpacker's rules); no hardware claim either way", () => {
    const pkg = catalogPackage("felucca");
    const sectors = corruptedSectors(engine, pkg, ["zero:0x0"]);
    const m = Fm1Machine.boot(engine, pkg, { sectors, usb: false });            // boot() succeeds: it unpacks the PACKAGE, never the live flash
    assert.ok(m.flash().subarray(0, 4096).every((b) => b === 0), "sector 0 of the live flash is zeroed");
    const before = snapshot(m);
    const r = diagnoseMachine(m);
    assert.equal(r.primary, "emulator-unbootable");
    assert.equal(r.emulator.refusal, "no chip key or app area in the flash image");
    assert.equal(r.hardwareBootability, "unknown", "an unpacker refusal is not proof that hardware is bricked");
    assert.ok(r.flags.includes("header-changed") && r.flags.includes("directory-changed") && r.flags.includes("spl-changed"));
    assert.equal(r.regions.header.changed, 32 - m.baseFlash().subarray(0, 32).filter((b) => b === 0).length);
    assert.deepEqual(snapshot(m), before, "diagnosing the damaged machine changed nothing");
    assert.equal(m.halted, false, "the emulated machine itself is fine: the diagnostic is not a boot gate");
  });
}

export function registerBootAreaFullTests(test, { engine }) {
  const T = (name, fn) => test(`boot area: ${name}`, fn);

  T("all 277 intact packages classify emulator-bootable, derive the committed layout and carry the SPL decode status of their body", () => {
    const fx = loadLayoutFixture(), entries = catalogueEntries();
    assert.equal(entries.length, 277);
    const seen = new Map(), undecoded = [];
    for (const { id, bytes } of entries) {
      const ref = paddedFlash(bytes), r = diag(ref, ref);
      assert.equal(r.primary, "emulator-bootable", id);
      assert.deepEqual(r.flags, ["emulator-bootable"], id);
      assert.equal(r.hardwareBootability, "unknown");
      assert.equal(r.emulator.referenceUnpack.key, 0x980f, id);
      assert.equal(r.spl.status, "boot-code-unknown", id);
      const key = r.spl.body, layout = fx.layouts.find((l) => l.splBody === key);
      assert.ok(layout, `${id}: SPL body ${key} in the fixture`);
      for (const k of BOOT_AREA_REGIONS) assert.deepEqual(r.regions[k].ranges, layout.regions[k], `${id}: ${k}`);
      assert.equal(r.regions.appArea.ranges[0][0], layout.appOffset);
      assert.equal(r.regions.gap.allIntactBytesFF, true, id);
      seen.set(key, (seen.get(key) ?? 0) + 1);
      if (r.spl.decode !== "decoded-code-like") undecoded.push(id);
    }
    assert.deepEqual(fx.layouts.map((l) => [l.splBody, l.packages]).sort(), [...seen.entries()].sort(), "package counts per layout");
    assert.deepEqual(undecoded.sort(), fx.undecodedSplPackages.packages.map((p) => p.id), "exactly the nine");
  });

  T("the committed layout fixture is exactly what the catalogue yields", () => {
    assert.equal(readFileSync(LAYOUT_PATH, "utf8").replace(/\r\n/g, "\n"), serializeLayout(buildLayoutFixture(catalogueEntries(), findings())), "regenerate with: node ci/machine/bootareacatalogue.mjs --write");
  });

  T("DIVERGENCE (running): Felucca with sector 0 zeroed still boots and draws on the shipped engine, while the diagnostic labels the same flash emulator-unbootable; the sector-0 limitation test stays", () => {
    const pkg = catalogPackage("felucca");
    const base = watch(Fm1Machine.boot(engine, pkg), { seconds: 2 });
    const sectors = corruptedSectors(engine, pkg, ["zero:0x0"]);
    const m = Fm1Machine.boot(engine, pkg, { sectors });
    const twin = Fm1Machine.boot(engine, pkg, { sectors });
    const r = diagnoseMachine(m);
    const hit = watch(m, { seconds: 2 });
    assert.equal(hit.verdict, "booted");
    assert.equal(hit.final.lcdHash, base.final.lcdHash, "the engine's boot never reads the live sector 0");
    assert.equal(r.primary, "emulator-unbootable");
    assert.equal(r.hardwareBootability, "unknown");
    // no side effects: the machine that was diagnosed behaves exactly like its undiagnosed twin
    const other = watch(twin, { seconds: 2 });
    assert.equal(hit.final.lcdHash, other.final.lcdHash);
    assert.equal(m.flashHash(), twin.flashHash());
    assert.equal(m.frames, twin.frames);
  });
}

/** One interrupted harness erase on the chip-profile engine: returns the machine after the cut and the machine rebooted with the scenario's synthetic outcome. */
function interrupted(chipEngine, s) {
  const m = Fm1Machine.boot(chipEngine, catalogPackage("felucca"), { usb: false, flashChip: "puya", flashTiming: "typical" });
  m.run(300);
  for (let i = 0; i < 400 && (m.x.fm1_flash_busy() !== 0 || m.x.fm1_flash_wip() !== 0); i++) m.run(3);
  const fault = { op: "erase4k", nth: 1, at: { fraction: 0.5 } };
  const live = new LiveChip(m);
  m.armFault(fault);
  live.wren();
  live.tx([0x20, (s.address >> 16) & 255, (s.address >> 8) & 255, s.address & 255]);
  live.advance(Math.floor(0.5 * PROFILES.puya.timingUs.typical.se));
  assert.equal(m.powerCut, true, `${s.id}: the cut fired`);
  return { cut: m, rebooted: m.powerCycle({ outcome: s.policy }) };
}

export function registerBootAreaLiveTests(testChip, { chipEngine }) {
  const T = (name, fn) => testChip(`boot area (live): ${name}`, fn);

  for (const s of LIVE_SCENARIOS) {
    T(`${s.id}: the interrupted 4 KiB erase at 0x${s.address.toString(16)} is ${s.expect.primary}, powered off and after the reboot, whatever bytes the synthetic outcome leaves`, () => {
      const { cut, rebooted } = interrupted(chipEngine, s);
      const range = cut.indeterminateRanges();
      assert.deepEqual(range, [[s.address, s.address + 4095]], "the engine reports the whole sector as unknown");
      for (const [when, m] of [["after the cut", cut], ["after the reboot", rebooted]]) {
        const before = snapshot(m);
        const r = diagnoseMachine(m);
        assert.deepEqual(snapshot(m), before, `${when}: the diagnosis changed nothing`);
        assert.equal(r.primary, s.expect.primary, `${when}: primary (flags ${r.flags.join(",")})`);
        assert.equal(r.hardwareBootability, "unknown");
        assert.equal(r.source.indeterminate, "the chip-profile engine's list");
        assert.equal(r.flags.includes("boot-area-at-risk"), true, `${when}: the interrupted region is at risk`);
        for (const k of s.expect.regionHit) assert.ok(r.regions[k].indeterminate > 0 && r.flags.includes(`${k}-indeterminate`), `${when}: ${k} is indeterminate`);
        assert.equal(r.flags.includes("unmodelled"), s.expect.keySectorTouched, `${when}: unmodelled exactly for the key sector`);
        assert.equal(r.recovery.assessment, "recovery-unknown");
        const sum = (k) => REGION_ORDER.reduce((n, kk) => n + r.regions[kk][k], 0);
        assert.equal(sum("indeterminate"), 4096, `${when}: every unknown byte is in some region`);
        assert.equal(r.regions[s.expect.regionHit[0]].changedKnown, 0, `${when}: changed bytes inside the unknown range are not evidence of a write`);
        if (when === "after the cut") assert.equal(sum("changed"), 0, "the cut machine still shows the labelled placeholder (the old bytes)");
        else assert.equal(sum("changed") > 0, s.expect.changedAfterReboot, `${when}: the synthetic ${s.policy.kind} outcome ${s.expect.changedAfterReboot ? "changes" : "leaves"} bytes; at-risk and unmodelled hold either way`);
      }
      assert.equal(rebooted.faultOutcome.provenance.synthetic, true);
    });
  }

  T("a machine with an unknown boot sector is still diagnosed without running or changing it, on the fault-injection engine too (cycles, chip status and fault record unchanged)", () => {
    const { cut } = interrupted(chipEngine, LIVE_SCENARIOS[0]);
    const before = snapshot(cut);
    assert.equal(before.chip.indeterminate.length, 1);
    const { calls } = spied(cut, (spy) => diagnoseMachine(spy));
    assert.deepEqual([...new Set(calls)].sort(), ["baseFlash", "flash", "indeterminateRanges"], "exactly the three read-only interfaces");
    assert.deepEqual(snapshot(cut), before);
  });
}
