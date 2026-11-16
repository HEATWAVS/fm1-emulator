// Tests of the curated boot-area scenario catalogue and its report (Component 7, Stage 7C). Every result is an emulator-defined diagnostic under a named input, never a statement about a
// physical FM-1: the tests pin what the catalogue and the committed report say and that they never say more (hardwareBootability stays "unknown", recovery stays "recovery-unknown",
// hypothetical assumptions stay HYPOTHETICAL, 0xFF000 stays unmodelled, a decoded SPL finding is never promoted).
//
// Quick tier (`npm test`; no engine): the catalogue (90 rows, 43 quick + 47 full, stable ids, inherited 7B rows), the image/reference identity pins and the guard against the wrong reference,
// the 43 quick pure rows rebuilt and compared with the committed report (the matrix on the four other layouts is full tier: the quick tier's 1.0 s budget), the committed report's integrity and semantic invariants, the summary's reproducibility, and that the committed live rows
// agree with their expectations (they are NOT replayed in this tier: a live row is only replayed by the full tier with the chip-profile engine, and is SKIPPED, never passed, without it).
// Full tier: the running divergence on the shipped engine, the machine reference guard, and the CLI (including its SKIPPED output and its refusal to write an incomplete report).
// Full tier with the chip-profile engine (test.chip, SKIPPED without it): every one of the 13 interrupted-cycle rows and the chip divergence replayed and compared with the committed rows.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { Fm1Machine } from "./machine.mjs";
import { catalogPackage } from "./firmware-survey.mjs";
import { EMULATOR_DIR } from "./engine.mjs";
import { PRIMARY_ORDER, HYPOTHETICAL_ASSUMPTIONS, FLASH_BYTES } from "./bootarea.mjs";
import { PURE_SCENARIOS, LIVE_SCENARIOS, paddedFlash } from "./bootareacatalogue.mjs";
import { loadLayoutFixture } from "./bootareadiag.mjs";
import {
  scenarios, quickSpecs, fullPureSpecs, QUICK_MATRIX_FIRMWARE, pureRows, runPure, runPureChecked, checkExpect, buildRows, runLive, runShippedDivergence, checkLive, buildReport, serializeReport, renderSummary, reportSha256, loadReference, verifyReference, verifyMachineReference,
  ReferenceMismatchError, IDENTITIES, REPRESENTATIVES, GROUPS, FIXTURE_PATH, SUMMARY_PATH, resolveOps, describeOp,
} from "./bootareascenarios.mjs";

const sha256 = (u8) => createHash("sha256").update(u8).digest("hex");
const readReport = () => JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
const lf = (s) => s.replace(/\r\n/g, "\n");
const SCRIPT = resolve(import.meta.dirname, "bootareascenarios.mjs");
/** Phrases that would claim something about a physical unit; scenario texts must never contain them. (The fixed disclaimer, which says what is NOT claimed, is excluded from the check.) */
export const CLAIM_PATTERNS = [/\bwill boot\b/i, /\bwould boot\b/i, /\bwill (?:not )?start\b/i, /\bis bricked\b/i, /\bbricks?\b/i, /\brecoverable\b/i, /\bsafe to flash\b/i, /\bboots on (?:the )?hardware\b/i, /\bhardware (?:boots|is bootable|will)\b/i, /\bproves?\b/i, /\bconfirmed (?:on )?hardware\b/i];
const claims = (text) => CLAIM_PATTERNS.filter((p) => p.test(text)).map(String);
const SIX = ["unmodelled", "boot-area-at-risk", "emulator-unbootable", "boot-code-unknown", "boot-area-written", "emulator-bootable"];

export function registerBootArea7CQuickTests(testQuick) {
  const T = (name, fn) => testQuick(`boot area scenarios: ${name}`, fn);

  T("the catalogue: 90 rows (43 quick, 47 full), unique stable ids, groups in order, 7B rows inherited by id with their own expectations, no hardware claims in any text", () => {
    const rows = scenarios(), ids = rows.map((r) => r.id);
    assert.equal(rows.length, 90);
    assert.equal(new Set(ids).size, 90, "unique ids");
    assert.equal(rows.filter((r) => r.tier === "quick").length, 43);
    assert.equal(rows.filter((r) => r.tier === "full").length, 47);
    assert.deepEqual(rows.filter((r) => r.tier === "full" && r.kind === "pure").map((r) => r.group), Array(32).fill("matrix"), "the 32 full-tier pure rows are the matrix rows of four layouts");
    assert.equal(rows.filter((r) => r.kind === "pure").length, 75);
    assert.deepEqual(Object.fromEntries(GROUPS.map((g) => [g, rows.filter((r) => r.group === g).length])), { intact: 6, "inherited-pure": 16, matrix: 40, composite: 7, "interrupted-pure": 5, "recovery-assumption": 1, "inherited-live": 6, live: 7, divergence: 2 });
    assert.deepEqual(rows.map((r) => r.group), GROUPS.flatMap((g) => rows.filter((r) => r.group === g).map(() => g)), "rows are ordered by group");
    for (const r of rows) {
      assert.match(r.id, /^[a-z0-9][a-z0-9.\-]*$/, r.id);
      assert.ok(r.why.length >= 30, `${r.id}: a reason`);
      assert.ok(IDENTITIES[r.firmware], `${r.id}: a pinned firmware`);
      assert.deepEqual(claims(r.why), [], `${r.id}: no claim about a physical unit in its reason`);
    }
    const pure = new Map(PURE_SCENARIOS.map((s) => [s.id, s])), live = new Map(LIVE_SCENARIOS.map((s) => [s.id, s]));
    for (const r of rows.filter((x) => x.inherited)) {
      const src = (r.group === "inherited-pure" ? pure : live).get(r.inherits);
      assert.ok(src, `${r.id}: the 7B scenario ${r.inherits} exists`);
      assert.equal(r.id, `7b.${r.inherits}`);
      assert.equal(r.expect, src.expect, `${r.id}: the expectation is the 7B object itself, not a copy`);
    }
    assert.equal(rows.filter((x) => x.inherited).length, PURE_SCENARIOS.length + LIVE_SCENARIOS.length, "all 22 7B scenarios inherited");
    for (const r of rows.filter((x) => !x.inherited && x.kind === "pure")) assert.ok(r.expect.flags.length > 0, `${r.id}: exact flags are pinned`);
    for (const r of rows.filter((x) => x.group === "live")) for (const w of ["afterCut", "afterReboot"]) assert.ok(r.expect[w].flags.length > 0, `${r.id}: ${w} flags pinned`);
    for (const r of rows.filter((x) => x.group === "composite")) assert.ok(r.expect.flags.length > 0, `${r.id}: exact flags are pinned`);
    for (const r of rows.filter((x) => x.kind === "pure" && x.ops.length)) for (const o of resolveOps(r.ops, loadReference(r.firmware).regions)) assert.deepEqual(claims(describeOp(o)), []);
  });

  T("image/reference identity: every reference is the pinned intact image of its package (also the catalogue's own sha256), and the wrong reference is refused, never diagnosed against", () => {
    assert.deepEqual(Object.keys(IDENTITIES), REPRESENTATIVES);
    assert.ok(Object.isFrozen(IDENTITIES) && Object.isFrozen(IDENTITIES.felucca));
    const catalogue = JSON.parse(readFileSync(resolve(EMULATOR_DIR, "firmwares.json"), "utf8")).firmwares;
    for (const fw of REPRESENTATIVES) {
      const { reference } = loadReference(fw);
      assert.equal(catalogue.find((e) => e.id === fw).sha256, IDENTITIES[fw].package, `${fw}: the pinned package digest is the catalogue's own sha256`);
      assert.equal(sha256(reference), IDENTITIES[fw].reference, fw);
      assert.equal(reference.length, FLASH_BYTES);
      assert.equal(verifyReference(fw, reference), reference);
    }
    assert.equal(new Set(REPRESENTATIVES.map((fw) => IDENTITIES[fw].reference)).size, 6, "six different references");
    const felucca = loadReference("felucca").reference;
    assert.throws(() => verifyReference("audiorouter", felucca), ReferenceMismatchError, "another firmware's image");
    assert.throws(() => verifyReference("felucca", loadReference("picovave").reference), /pinned intact image/);
    const damaged = felucca.slice(); damaged[0x20000] ^= 1;
    assert.throws(() => verifyReference("felucca", damaged), ReferenceMismatchError, "an image with one byte changed is not the reference");
    assert.throws(() => verifyReference("felucca", felucca.slice(0, 4096)), /not 1048576/);
    assert.throws(() => verifyReference("quadro-fm1", felucca), /no pinned identity/);
    assert.throws(() => verifyReference("felucca", felucca, new Uint8Array(16)), /not the pinned package/);
    assert.throws(() => verifyMachineReference("audiorouter", { baseFlash: () => felucca }), /no pinned engine base/);
    assert.throws(() => verifyMachineReference("felucca", { baseFlash: () => felucca }), /not the pinned one/, "the padded package image is not the machine's base flash");
    const pad = (id) => paddedFlash(catalogPackage(id));
    assert.equal(sha256(pad("felucca")), IDENTITIES.felucca.reference);
    assert.throws(() => verifyReference("felucca", pad("quadro-fm1")), ReferenceMismatchError, "a different firmware that shares the boot head is still the wrong reference");
  });

  T("the 43 quick-tier pure rows rebuild exactly the committed rows and meet their expectations; the six representatives cover the six layouts", () => {
    const rows = pureRows(), have = readReport().rows.filter((r) => r.tier === "quick");
    assert.equal(rows.length, 43);
    assert.deepEqual(rows, have, "the committed quick-tier rows are what the catalogue yields now");
    assert.deepEqual(rows.filter((r) => r.group === "matrix").map((r) => r.firmware), Array(8).fill(QUICK_MATRIX_FIRMWARE), "the quick tier runs the matrix on one layout only");
    assert.deepEqual(new Set(rows.filter((r) => r.group === "intact").map((r) => r.layout)), new Set([1, 2, 3, 4, 5, 6]), "the six representatives cover the six layouts of the layout fixture");
    assert.equal(loadLayoutFixture().layouts.length, 6);
  });

  T("the committed report: version, counts, row order, identities, report hash and every row hash recompute; no firmware bytes; serialisation reproduces the file", () => {
    const raw = readFileSync(FIXTURE_PATH, "utf8"), rep = JSON.parse(raw), ids = scenarios().map((s) => s.id);
    assert.equal(rep.version, 1);
    assert.deepEqual(rep.rows.map((r) => r.id), ids);
    assert.deepEqual(rep.counts, { total: 90, quick: 43, full: 47, byGroup: { intact: 6, "inherited-pure": 16, matrix: 40, composite: 7, "interrupted-pure": 5, "recovery-assumption": 1, "inherited-live": 6, live: 7, divergence: 2 } });
    assert.deepEqual(rep.identities, Object.fromEntries(REPRESENTATIVES.map((fw) => [fw, IDENTITIES[fw]])));
    assert.equal(rep.reportSha256, reportSha256(rep.rows));
    for (const r of rep.rows) { const { rowSha, ...rest } = r; assert.equal(rowSha, createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 16), `${r.id}: row hash`); assert.equal(r.tier, scenarios().find((s) => s.id === r.id).tier); }
    assert.equal(lf(raw), serializeReport(buildReport(rep.rows)), "regenerate with: node ci/machine/bootareascenarios.mjs --write");
    const known = new Set([...Object.values(IDENTITIES).flatMap((i) => [i.package, i.reference, i.engineBase]), rep.reportSha256]);
    for (const h of raw.match(/[0-9a-f]{20,}/g) ?? []) assert.ok(known.has(h), `a long hex string that is not a pinned digest: ${h.slice(0, 20)}…`);
    assert.ok(raw.length < 300_000, "no firmware bytes: the report is small");
    assert.equal(rep.evidenceLevel, "EMULATOR");
  });

  T("the committed report's invariants, checked independently of the generator: fixed hardware and recovery fields, the precedence of the primary label, 0xFF000 package-only, SPL never promoted, hypothetical recovery labelled", () => {
    const rep = readReport(), keySectorFlag = /^keySector-/;
    const diagnoses = (r) => (r.result.afterReboot ? [r.result.afterCut, r.result.afterReboot] : [r.result]);
    for (const r of rep.rows) {
      for (const x of diagnoses(r)) {
        const where = `${r.id}`;
        assert.equal(x.hardwareBootability, "unknown", where);
        assert.equal(x.recovery, "recovery-unknown", where);
        assert.equal(x.splStatus, "boot-code-unknown", `${where}: the SPL is never judged`);
        const label = PRIMARY_ORDER.find((p) => x.flags.includes(p)) ?? "not-evaluable";
        assert.equal(x.primary, label, `${where}: the primary label is the first applicable in the precedence order`);
        assert.ok(SIX.includes(x.primary) || x.primary === "not-evaluable", where);
        assert.equal(x.flags.includes("unmodelled"), x.flags.some((f) => keySectorFlag.test(f)), `${where}: unmodelled exactly when the key sector is touched`);
        assert.equal(x.flags.includes("emulator-result-on-placeholder-bytes"), x.emulatorVerdict === "not-evaluable", `${where}: not-evaluable exactly with unknown bytes in what the unpacker reads`);
        assert.equal(x.flags.includes("unpack-refused"), x.emulator.unpack === "refused", where);
        for (const g of Object.values(x.regions)) assert.equal(g.changedKnown, g.changed - g.both, where);
        const by = Object.fromEntries(x.rulesApplied.map((a) => [a.id, a.evidence]));
        assert.ok(!("app-dir-head2" in by), `${where}: app_dir_head2 decides nothing`);
        if (by["key-sector-touched"]) assert.deepEqual(by["key-sector-touched"], ["PACKAGE", "UNKNOWN"], `${where}: 0xFF000 is package evidence only`);
        for (const id of ["spl-touched", "header-touched", "directory-touched", "key-blob-touched"]) if (by[id]) assert.ok(by[id].includes("UNKNOWN"), `${where}: ${id} keeps UNKNOWN`);
        if (by["spl-touched"]) assert.ok(by["spl-touched"].every((l) => ["PACKAGE", "DECODED", "UNKNOWN"].includes(l)), `${where}: the SPL's evidence is never promoted beyond DECODED`);
        assert.ok(Object.values(by).every((l) => l.every((e) => ["EMULATOR", "PACKAGE", "DECODED", "UNKNOWN"].includes(e))), `${where}: evidence labels`);
      }
      assert.ok(("assumptions" in r.result) === (r.group === "recovery-assumption"), `${r.id}: hypothetical recovery only where asked`);
    }
    const rec = rep.rows.find((r) => r.group === "recovery-assumption").result;
    assert.deepEqual(Object.keys(rec.assumptions), Object.keys(HYPOTHETICAL_ASSUMPTIONS));
    for (const [a, x] of Object.entries(rec.assumptions)) {
      assert.equal(x.recovery, "recovery-unknown"); assert.equal(x.primary, rec.primary, "an assumption changes no label");
      assert.deepEqual([x.hypothetical.HYPOTHETICAL, x.hypothetical.evidence, x.hypothetical.outcome, x.hypothetical.assumption], [true, "UNKNOWN", HYPOTHETICAL_ASSUMPTIONS[a], a]);
    }
    for (const r of rep.rows.filter((x) => x.group === "intact")) {
      assert.deepEqual(r.result.flags, ["emulator-bootable"], r.id);
      assert.deepEqual(r.result.splDecode === "decoded-code-like", ["felucca", "gammawave"].includes(r.firmware), `${r.id}: the decode status is carried, the SPL status is not changed by it`);
    }
    for (const id of ["composite.whole-flash-erased", "composite.whole-flash-zero"]) assert.ok(rep.rows.find((r) => r.id === id).result.regions.other.changed > 0, `${id}: the region outside the package image changed too`);
  });

  T("the summary is exactly what the committed report renders to, shows primary, emulator verdict and flags side by side for all 90 rows, and makes no claim about hardware", () => {
    const rep = readReport(), md = lf(readFileSync(SUMMARY_PATH, "utf8"));
    assert.equal(md, renderSummary(rep), "regenerate with: node ci/machine/bootareascenarios.mjs --write");
    for (const r of rep.rows) assert.ok(md.includes(`\`${r.id}\``), `${r.id} in the summary`);
    assert.ok(md.includes(rep.disclaimer) && md.includes(rep.reportSha256));
    for (const r of rep.rows) for (const x of r.result.afterReboot ? [r.result.afterCut, r.result.afterReboot] : [r.result]) assert.ok(md.includes(`\`${x.primary}\` / \`${x.emulatorVerdict}\``), `${r.id}: primary and verdict side by side`);
    const body = md.replace(rep.disclaimer, "").split("\n").filter((l) => !l.startsWith(">") && !l.includes("HYPOTHETICAL") && !l.startsWith("- **") && !l.startsWith("Every row") && !l.startsWith("Rules that applied")).join("\n");
    assert.deepEqual(claims(body), [], "no claim about a physical unit");
    assert.ok(/hardwareBootability` is `unknown`/.test(md) && /recovery-unknown/.test(md));
    assert.ok(!/\r/.test(md.replace(/\r\n/g, "\n")));
  });

  T("the committed live and divergence rows meet their expectations (NOT replayed in this tier: the full tier with the chip-profile engine replays them, and SKIPS them without it)", () => {
    const rep = readReport(), byId = new Map(rep.rows.map((r) => [r.id, r]));
    for (const s of scenarios().filter((x) => x.tier === "full" && x.kind !== "pure")) {
      const r = byId.get(s.id);
      assert.equal(r.tier, "full");
      if (s.inherited) {
        const e = s.expect;
        for (const x of [r.result.afterCut, r.result.afterReboot]) { assert.equal(x.primary, e.primary, s.id); assert.ok(x.flags.includes("boot-area-at-risk")); assert.equal(x.flags.includes("unmodelled"), e.keySectorTouched); for (const k of e.regionHit) assert.ok(x.flags.includes(`${k}-indeterminate`), `${s.id}: ${k}`); }
        const sum = (x) => Object.values(x.regions).reduce((n, g) => n + g.changed, 0);
        assert.equal(sum(r.result.afterCut), 0, `${s.id}: the cut machine shows the placeholder`);
        assert.equal(sum(r.result.afterReboot) > 0, e.changedAfterReboot, `${s.id}: changed bytes after the reboot`);
      } else if (s.kind === "divergence-shipped") {
        assert.equal(r.result.engineBoot.verdict, "booted"); assert.equal(r.result.primary, s.expect.primary);
      } else {
        const parts = s.kind === "divergence-chip" ? [[s.expect, r.result.afterReboot]] : [[s.expect.afterCut, r.result.afterCut], [s.expect.afterReboot, r.result.afterReboot]];
        for (const [e, x] of parts) { assert.equal(x.primary, e.primary, s.id); assert.equal(x.emulatorVerdict, e.bootability, s.id); assert.deepEqual(x.flags, e.flags, s.id); if ("refusal" in e) assert.equal(x.emulator.refusal, e.refusal, s.id); }
        if (s.expect.ranges) assert.deepEqual(r.result.indeterminate, s.expect.ranges, s.id);
        if (s.kind === "divergence-chip") assert.equal(r.result.engineBoot.verdict, s.expect.engineVerdict, "the rebooted machine boots from the package");
      }
    }
    assert.equal(quickSpecs().length, 43);
    assert.equal(scenarios().filter((x) => x.tier === "full" && x.kind !== "pure").length, 15, "the 13 chip-engine rows and the 2 divergence rows");
  });

  T("the expectation checker and the row runner reject every kind of disagreement, so a wrong expectation, a wrong result or a changed fixed field cannot pass", () => {
    const by = (id) => scenarios().find((s) => s.id === id);
    const cases = { unt: by("7b.directory-unterminated"), key: by("7b.key-blob-changes-key"), app: by("7b.app-area-only"), gap: by("composite.header-and-gap") };
    const raw = Object.fromEntries(Object.entries(cases).map(([k, s]) => [k, runPure(s).raw]));
    for (const k of Object.keys(cases)) assert.doesNotThrow(() => checkExpect(cases[k].id, cases[k].expect, raw[k]), `${k}: the unmodified expectation holds`);
    const bad = (k, patch, re) => assert.throws(() => checkExpect(cases[k].id, { ...cases[k].expect, ...patch }, raw[k]), re);
    bad("gap", { primary: "emulator-bootable" }, /primary/);
    bad("gap", { bootability: "emulator-unbootable" }, /emulator verdict/);
    assert.ok(raw.gap.flags.length > 2);
    bad("gap", { flags: raw.gap.flags.slice(1) }, /flags/);
    bad("gap", { flags: [...raw.gap.flags, "unmodelled"].sort() }, /flags/);
    bad("gap", { has: ["unmodelled"] }, /missing/);
    bad("key", { lacks: ["unpack-refused"] }, /must not be present/);
    bad("key", { refusal: "something else" }, /refusal/);
    bad("key", { keyDiffers: false }, /keyDiffers/);
    bad("app", { windowDiffers: false }, /windowDiffers/);
    bad("unt", { directoryTerminated: true }, /directory\.terminated/);
    bad("unt", { directoryEntries: 4 }, /entryCount/);
    bad("unt", { rules: { "directory-unterminated": "clear" } }, /rule directory-unterminated/);
    assert.throws(() => checkExpect("x", cases.gap.expect, { ...raw.gap, hardwareBootability: "bootable" }), /hardwareBootability/);
    assert.throws(() => checkExpect("x", cases.gap.expect, { ...raw.gap, recovery: { ...raw.gap.recovery, assessment: "recoverable-by-reinstall" } }), /recovery-unknown/);
    assert.doesNotThrow(() => runPureChecked(by("intact.beetle")));
    assert.throws(() => runPureChecked({ ...by("intact.beetle"), expect: { ...by("intact.beetle").expect, flags: ["emulator-bootable", "spl-changed"] } }), /flags/, "the row runner applies the check");
    assert.throws(() => runPureChecked({ ...by("matrix.gap-first-byte.beetle"), expect: { ...by("matrix.gap-first-byte.beetle").expect, primary: "emulator-bootable" } }), /primary/);
    assert.throws(() => runPure({ ...by("intact.beetle"), firmware: "quadro-fm1" }), ReferenceMismatchError, "a firmware without a pinned identity is never diagnosed");
    const regions = loadReference("felucca").regions;
    assert.deepEqual(resolveOps([{ kind: "xor", at: { region: "gap", edge: "first" }, mask: 1 }, { kind: "fill", at: 7, len: 1, value: 0 }], regions).map((o) => o.at), [regions.gap[0].lo, 7]);
    assert.throws(() => resolveOps([{ kind: "xor", at: { region: "gap", edge: "last" }, mask: 1 }], regions), /unsupported edge/);
    assert.throws(() => resolveOps([{ kind: "xor", at: { region: "nowhere", edge: "first" }, mask: 1 }], regions), /no nowhere region/);
    assert.throws(() => describeOp({ kind: "bogus" }), /unknown damage operation/);
  });
}

export function registerBootArea7CFullTests(test, { engine }) {
  const T = (name, fn) => test(`boot area scenarios: ${name}`, fn);

  T("DIVERGENCE (running, shipped engine): the key-blob damage that changes the derived key still boots and draws, while the diagnostic says emulator-unbootable; the committed row is reproduced", () => {
    const s = scenarios().find((x) => x.id === "divergence.key-blob-changes-key-running");
    const { row, raw } = runShippedDivergence(engine, s);
    assert.equal(raw.primary, "emulator-unbootable");
    assert.equal(raw.emulator.keyDiffers, true);
    assert.equal(row.result.engineBoot.verdict, "booted");
    assert.ok(row.result.engineBoot.colours >= 2, "a non-blank screen");
    assert.equal(raw.hardwareBootability, "unknown");
    assert.deepEqual(row, readReport().rows.find((r) => r.id === s.id));
  });

  T("the matrix on the four other layouts (32 pure rows, full tier) rebuilds the committed rows; each damage gives the same label, verdict and flags on all five layouts while the offsets come from each layout", () => {
    const have = readReport().rows, specs = fullPureSpecs();
    assert.equal(specs.length, 32);
    const rows = specs.map(runPureChecked);
    assert.deepEqual(rows, rows.map((r) => have.find((h) => h.id === r.id)), "the committed full-tier pure rows are what the catalogue yields now");
    const matrix = have.filter((r) => r.group === "matrix");
    assert.equal(matrix.length, 40);
    for (const key of [...new Set(matrix.map((r) => r.id.split(".")[1]))]) {
      const set = matrix.filter((r) => r.id.split(".")[1] === key);
      assert.equal(set.length, 5, key);
      assert.equal(new Set(set.map((r) => r.layout)).size, 5, `${key}: five different layouts`);
      for (const r of set) { assert.equal(r.result.primary, set[0].result.primary, r.id); assert.deepEqual(r.result.flags, set[0].result.flags, r.id); assert.equal(r.result.emulatorVerdict, set[0].result.emulatorVerdict, r.id); }
      if (key === "gap-first-byte") assert.ok(new Set(set.map((r) => r.input.damage[0])).size >= 3, "the gap offset comes from each layout's own regions");
    }
  });

  T("the machine reference guard: a machine of another firmware is refused; a machine of the pinned firmware is accepted", () => {
    const other = Fm1Machine.boot(engine, catalogPackage("quadro-fm1")), same = Fm1Machine.boot(engine, catalogPackage("felucca"));
    assert.throws(() => verifyMachineReference("felucca", other), ReferenceMismatchError);
    assert.doesNotThrow(() => verifyMachineReference("felucca", same));
    assert.equal(sha256(same.baseFlash()), IDENTITIES.felucca.engineBase);
  });

  T("the CLI: --check passes against the committed report; without the chip-profile engine it prints SKIPPED for the 14 chip rows (never a pass) and --require-live then fails; --write refuses to write an incomplete report", () => {
    const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 120_000 });
    const before = [readFileSync(FIXTURE_PATH, "utf8"), readFileSync(SUMMARY_PATH, "utf8")];
    const none = { FM1_CHIP_ENGINE: resolve(import.meta.dirname, "no-such-chip-engine.wasm") };
    const a = run(["--check"], none);
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /76 of 90 rows rebuilt and identical to the committed report/);
    assert.match(a.stdout, /SKIPPED 14 rows .*not a passed row/);
    assert.equal(run(["--check", "--require-live"], none).status, 1);
    const w = run(["--write"], none);
    assert.equal(w.status, 2);
    assert.match(w.stderr, /refusing to write/);
    assert.deepEqual([readFileSync(FIXTURE_PATH, "utf8"), readFileSync(SUMMARY_PATH, "utf8")], before, "nothing was written");
    assert.equal(run(["--bogus"]).status, 2);
    const s = run(["--summary"]);
    assert.equal(s.status, 0);
    assert.equal(lf(s.stdout), lf(before[1]));
    assert.equal(lf(run(["--json"]).stdout), lf(before[0]));
  });

  T("the CLI check detects a tampered report, a tampered summary and a missing row (alternative files via --fixture and --summary-file; the committed files are not touched)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bootarea7c-")), none = { FM1_CHIP_ENGINE: resolve(import.meta.dirname, "no-such-chip-engine.wasm") };
    try {
      const fx = readFileSync(FIXTURE_PATH, "utf8"), md = readFileSync(SUMMARY_PATH, "utf8");
      const check = (fixture, summary) => {
        const f = join(dir, "r.json"), s = join(dir, "s.md");
        writeFileSync(f, fixture); writeFileSync(s, summary);
        return spawnSync(process.execPath, [SCRIPT, "--check", "--fixture", f, "--summary-file", s], { encoding: "utf8", env: { ...process.env, ...none }, timeout: 120_000 });
      };
      const ok = check(fx, md);
      assert.equal(ok.status, 0, ok.stderr);
      const row = check(fx.replace('"primary":"emulator-bootable"', '"primary":"emulator-unbootable"'), md);
      assert.equal(row.status, 1); assert.match(row.stderr, /differs from the committed report/);
      const sha = check(fx.replace(/"reportSha256": "[0-9a-f]{64}"/, `"reportSha256": "${"0".repeat(64)}"`), md);
      assert.equal(sha.status, 1); assert.match(sha.stderr, /reportSha256 does not match/);
      const sum = check(fx, md.replace("Boot-area scenarios", "Boot area scenarios"));
      assert.equal(sum.status, 1); assert.match(sum.stderr, /summary differs/);
      const rep = JSON.parse(fx); rep.rows.splice(10, 1);
      const gone = check(JSON.stringify(rep), md);
      assert.equal(gone.status, 1); assert.match(gone.stderr, /not the catalogue's rows/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  T("buildRows refuses a row whose result disagrees with its expectation (pure, divergence on the shipped engine) and reports the chip rows as skipped, never as produced", () => {
    const by = (id) => scenarios().find((s) => s.id === id);
    const pure = by("composite.header-and-gap"), div = by("divergence.key-blob-changes-key-running"), live = by("live.chip-erase-ff");
    assert.throws(() => buildRows({ engine, chipEngine: null, specs: [{ ...pure, expect: { ...pure.expect, primary: "emulator-bootable" } }] }), /primary/);
    assert.throws(() => buildRows({ engine, chipEngine: null, specs: [{ ...div, expect: { ...div.expect, engineVerdict: "blank" } }] }), /engine boot verdict/);
    assert.throws(() => buildRows({ engine, chipEngine: null, specs: [{ ...div, expect: { ...div.expect, primary: "emulator-bootable" } }] }), /primary/);
    assert.throws(() => runShippedDivergence(engine, { ...div, firmware: "audiorouter" }), ReferenceMismatchError, "the machine's base flash must be the pinned one for its firmware");
    const out = buildRows({ engine, chipEngine: null, specs: [pure, live, by("divergence.sector-0-erase-cut-ff-rebooted")] });
    assert.deepEqual(out.skipped, ["live.chip-erase-ff", "divergence.sector-0-erase-cut-ff-rebooted"]);
    assert.deepEqual([out.rows[0] !== null, out.rows[1], out.rows[2]], [true, null, null], "a skipped row has no result");
  });
}

export function registerBootArea7CLiveTests(testChip, { chipEngine }) {
  const T = (name, fn) => testChip(`boot area scenarios (live): ${name}`, fn);
  for (const s of scenarios().filter((x) => x.kind === "live" || x.kind === "divergence-chip")) {
    T(`${s.id}: replayed on the chip-profile engine, it meets its expectation and reproduces the committed row exactly`, () => {
      const { row, raw } = runLive(chipEngine, s);
      checkLive(s, raw, row);
      assert.deepEqual(row, readReport().rows.find((r) => r.id === s.id), "the committed row");
      for (const x of [row.result.afterCut, row.result.afterReboot]) { assert.equal(x.hardwareBootability, "unknown"); assert.equal(x.recovery, "recovery-unknown"); }
      assert.equal(row.result.afterCut.flags.includes("boot-area-at-risk") || row.result.afterCut.primary === "not-evaluable", true);
    });
  }

  T("the live checker rejects every kind of disagreement (new-row form, inherited 7B form, chip divergence)", () => {
    const by = (id) => scenarios().find((s) => s.id === id);
    const s = by("live.erase4k-sector-3-ff"), a = runLive(chipEngine, s);
    assert.doesNotThrow(() => checkLive(s, a.raw, a.row));
    const bad = (spec, run, patch, re) => assert.throws(() => checkLive({ ...spec, expect: patch(spec.expect) }, run.raw, run.row), re);
    bad(s, a, (e) => ({ ...e, ranges: [[0, 1]] }), /indeterminate ranges/);
    bad(s, a, (e) => ({ ...e, afterCut: { ...e.afterCut, primary: "emulator-bootable" } }), /primary/);
    bad(s, a, (e) => ({ ...e, afterCut: { ...e.afterCut, bootability: "emulator-bootable" } }), /emulator verdict/);
    bad(s, a, (e) => ({ ...e, afterReboot: { ...e.afterReboot, flags: e.afterReboot.flags.slice(1) } }), /flags/);
    bad(s, a, (e) => ({ ...e, afterReboot: { ...e.afterReboot, refusal: "something else" } }), /refusal/);
    const i = by("7b.sector-0-erase-cut-ff"), b = runLive(chipEngine, i);
    assert.doesNotThrow(() => checkLive(i, b.raw, b.row));
    bad(i, b, (e) => ({ ...e, primary: "unmodelled" }), /primary/);
    bad(i, b, (e) => ({ ...e, keySectorTouched: true }), /unmodelled/);
    bad(i, b, (e) => ({ ...e, regionHit: ["keySector"] }), /must be indeterminate/);
    bad(i, b, (e) => ({ ...e, changedAfterReboot: false }), /changed bytes/);
    assert.throws(() => runLive(chipEngine, { ...s, firmware: "audiorouter" }), ReferenceMismatchError, "the machine's base flash must be the pinned one for its firmware");
    const d = by("divergence.sector-0-erase-cut-ff-rebooted"), c = runLive(chipEngine, d);
    assert.doesNotThrow(() => checkLive(d, c.raw, c.row));
    bad(d, c, (e) => ({ ...e, engineVerdict: "blank" }), /engine boot verdict/);
    bad(d, c, (e) => ({ ...e, primary: "emulator-bootable" }), /primary/);
    // the cut machine must still show the labelled placeholder: a doctored report with changed bytes after the cut is refused
    const header = b.raw.afterCut.regions.header;
    const doctored = { ...b.raw, afterCut: { ...b.raw.afterCut, regions: { ...b.raw.afterCut.regions, header: { ...header, changed: 1 } } } };
    assert.throws(() => checkLive(i, doctored, b.row), /no changed bytes/);
    // buildRows with the chip engine runs the live check too
    assert.throws(() => buildRows({ engine: null, chipEngine, specs: [{ ...s, expect: { ...s.expect, ranges: [[0, 1]] } }] }), /indeterminate ranges/);
    const built = buildRows({ engine: null, chipEngine, specs: [s] });
    assert.deepEqual(built.rows, [a.row]);
    assert.deepEqual(built.skipped, []);
  });
}
