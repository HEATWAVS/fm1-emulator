// Tests of the recovery scenarios (Component 6). Every result is an emulator observation under a named input, never a statement about a physical FM-1.
//
// Quick tier (`npm test`; no chip engine):
//   * the catalogue is well formed and agrees with the committed survey fixture, and the fixture is exactly what docs/dev/fault-survey.json yields;
//   * the verdict definitions (self-recovery, reinstall recovery) as a truth table;
//   * the quick corrupted-flash scenarios on the SHIPPED engine: the damaged flash booted as it is (self-recovery or not) and a fresh machine from the intact package (reinstall
//     recovery), with exact verdicts, and the evidence that nothing was repaired;
//   * a reboot of a damaged flash does not repair it (the reset control).
// Full tier: the remaining corrupted-flash scenarios on the shipped engine (no chip engine needed), and, on the chip-profile engine only (SKIPPED, loudly, without it), the interrupted-cycle
// scenarios replayed exactly against the committed survey rows, plus the pinned limitation of powerCycle() (it cannot interrupt a write).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { Fm1Machine } from "./machine.mjs";
import { watch } from "./monitor.mjs";
import { LiveChip } from "./chiplive.mjs";
import { catalogPackage } from "./firmware-survey.mjs";
import { runFaultScenario } from "./faultscenario.mjs";
import { RECOVERY_DEFINITIONS, RECOVERY_DISCLAIMER, RECOVERY_VERSION, isSelfRecovery, classifyRebootReport, damageState, damagedBoot, runCorruptionRecovery } from "./recovery.mjs";
import { CORRUPTION_SCENARIOS, POWER_CUT_SCENARIOS } from "./recoverycatalogue.mjs";
import { buildFixture, serialize, FIXTURE_PATH, SURVEY_PATH } from "./recoveryfixture.mjs";

const fixture = () => JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
const w = (verdict, { colours = 5, halted = false } = {}) => ({ verdict, final: { lcdColours: colours, halted }, haltedAtMs: halted ? 1 : null, emulatedMs: 100 });

/** What a corruption scenario's report must be, from its catalogue entry (the one place the expectation is turned into assertions). */
function assertCorruptionReport(s, r) {
  const e = s.expect;
  assert.equal(r.version, RECOVERY_VERSION);
  assert.deepEqual(r.corrupt, s.corrupt);
  assert.equal(r.damage.applied, true, "the damage really changed the flash");
  assert.equal(r.selfRecovery.label, e.self, `${s.id}: self-recovery label`);
  assert.equal(r.selfRecovery.recovered, e.self === "self-recovery");
  assert.equal(r.selfRecovery.verdict, e.verdict, `${s.id}: verdict of the damaged flash`);
  assert.equal(r.selfRecovery.haltedAtMs, e.haltedAtMs, `${s.id}: halt time`);
  assert.equal(r.selfRecovery.lcdColours, e.lcdColours, `${s.id}: screen colours of the damaged flash`);
  assert.equal(r.selfRecovery.damageRepaired, false, `${s.id}: the firmware repaired nothing`);
  assert.equal(r.selfRecovery.flashStillDamaged, true, `${s.id}: the damaged sector is still damaged afterwards`);
  assert.equal(r.reinstallRecovery.startsIntact, true, `${s.id}: the reinstall starts from the intact package flash`);
  assert.equal(r.reinstallRecovery.label, "reinstall-recovery", `${s.id}: a fresh machine from the intact package boots`);
  assert.equal(r.reinstallRecovery.verdict, e.reinstall.verdict);
  assert.equal(r.reinstallRecovery.lcdColours, e.reinstall.lcdColours, `${s.id}: screen colours of the reinstall`);
  assert.equal(r.disclaimer, RECOVERY_DISCLAIMER);
}

const run = (engine, s) => runCorruptionRecovery(engine, catalogPackage(s.firmware), { corrupt: s.corrupt, damagedSeconds: s.damagedSeconds, reinstallSeconds: s.reinstallSeconds });

export function registerRecoveryQuickTests(testQuick, { engine }) {
  const T = (name, fn) => testQuick(`recovery: ${name}`, fn);

  T("the catalogue is well formed: unique ids, explicit windows, a reason for each, expectations consistent with the verdict definitions, every verdict class present", () => {
    const ids = [...CORRUPTION_SCENARIOS, ...POWER_CUT_SCENARIOS].map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, "ids are unique");
    assert.equal(CORRUPTION_SCENARIOS.length, 10);
    assert.equal(POWER_CUT_SCENARIOS.length, 9);
    for (const s of CORRUPTION_SCENARIOS) {
      assert.ok(s.tier === "quick" || s.tier === "full", s.id);
      assert.ok(s.damagedSeconds > 0 && s.reinstallSeconds > 0, `${s.id}: explicit windows`);
      assert.ok(s.corrupt.length > 0 && s.why.length > 40, s.id);
      assert.ok(s.surveyControl.unit && s.surveyControl.key, s.id);
      const e = s.expect;
      assert.equal(e.self === "self-recovery", e.verdict === "booted" && e.lcdColours >= 2, `${s.id}: the label follows the definition`);
      assert.equal(e.haltedAtMs !== null, e.verdict === "crashed", `${s.id}: a halt time exactly for a crash`);
      assert.equal(e.reinstall.verdict, "booted", `${s.id}: the intact package boots`);
      assert.ok(e.reinstall.lcdColours >= 2, s.id);
    }
    for (const s of POWER_CUT_SCENARIOS) {
      assert.ok(s.row.startsWith(`${s.firmware}/puya/`), `${s.id}: row of its own firmware on Puya`);
      assert.ok(s.why.length > 40, s.id);
      const e = s.expect;
      assert.equal(e.label === "self-recovery", e.verdict === "booted" && e.lcdColours >= 2, `${s.id}: the label follows the definition`);
    }
    const q = CORRUPTION_SCENARIOS.filter((s) => s.tier === "quick");
    assert.deepEqual(q.map((s) => s.id), ["felucca-code-sector-erased", "quadro-fm1-code-sector-erased", "coqui-boot-sector-zeroed"], "the quick tier carries three scenarios (its 20 s budget), the rest run in the full tier");
    assert.ok(q.some((s) => s.expect.self === "self-recovery") && q.some((s) => s.expect.self === "no-self-recovery"), "the quick tier shows both outcomes");
    const verdicts = new Set([...CORRUPTION_SCENARIOS.map((s) => s.expect.verdict), ...POWER_CUT_SCENARIOS.map((s) => s.expect.verdict)]);
    assert.deepEqual([...verdicts].sort(), ["blank", "booted", "crashed", "display-lost"], "every verdict class is exercised");
  });

  T("the verdict definitions: self-recovery needs a booted machine with a non-blank screen; a halt, a blank or lost display, or one colour is never self-recovery", () => {
    assert.equal(isSelfRecovery(w("booted", { colours: 2 })), true);
    assert.equal(isSelfRecovery(w("booted", { colours: 17 })), true);
    assert.equal(isSelfRecovery(w("booted", { colours: 1 })), false, "one colour is a blank screen");
    for (const v of ["crashed", "blank", "display-lost", "power-cut"]) assert.equal(isSelfRecovery(w(v, { colours: 30 })), false, v);
    assert.equal(isSelfRecovery(w("booted", { colours: 30, halted: true })), false, "a halted machine is not running");
    assert.equal(classifyRebootReport({ verdict: "booted", lcdColours: 7, haltedAtMs: null }).label, "self-recovery");
    assert.equal(classifyRebootReport({ verdict: "booted", lcdColours: 1, haltedAtMs: null }).label, "no-self-recovery");
    assert.equal(classifyRebootReport({ verdict: "crashed", lcdColours: 1, haltedAtMs: 0 }).label, "no-self-recovery");
    assert.equal(classifyRebootReport({ verdict: "crashed", lcdColours: 36, haltedAtMs: 316 }).recovered, false, "a halt after drawing a screen (elixir) is not self-recovery");
    assert.equal(classifyRebootReport({ verdict: "display-lost", lcdColours: 5 }).recovered, false);
    assert.equal(classifyRebootReport({ verdict: "blank", lcdColours: 1 }).recovered, false);
    assert.equal(classifyRebootReport({ verdict: "display-lost", lcdColours: 1 }).recovered, false);
    assert.equal(classifyRebootReport({ verdict: "engine-trap", lcdColours: null }).recovered, false, "an emulator trap is never a recovery");
    assert.throws(() => classifyRebootReport(null), RangeError);
    assert.deepEqual(Object.keys(RECOVERY_DEFINITIONS), ["self-recovery", "no-self-recovery", "reinstall-recovery", "no-reinstall-recovery"]);
    assert.match(RECOVERY_DEFINITIONS["self-recovery"], /Not a repair/);
    assert.match(RECOVERY_DEFINITIONS["reinstall-recovery"], /Not the update loader/);
    assert.match(RECOVERY_DISCLAIMER, /not a firmware update/);
    assert.match(RECOVERY_DISCLAIMER, /boot area are not emulated/);
  });

  T("what became of the damage: repaired only when every damaged sector holds the package's bytes again; a no-op damage is reported as not applied", () => {
    const base = new Uint8Array(3 * 4096).fill(0xaa), after = base.slice();
    after.fill(0x00, 0, 4096);                                      // sector 0 still damaged
    assert.deepEqual(damageState([0], base, after), { repaired: false, stillDamaged: true });
    assert.deepEqual(damageState([4096], base, after), { repaired: true, stillDamaged: false }, "sector 1 holds the package's bytes");
    assert.deepEqual(damageState([0, 4096], base, after), { repaired: false, stillDamaged: true }, "one repaired sector out of two is not a repair");
    assert.deepEqual(damageState([4096, 0], base, after), { repaired: false, stillDamaged: true }, "the damaged sector is found wherever it is in the list");
    after.fill(0xaa, 0, 4096);
    assert.deepEqual(damageState([0, 4096], base, after), { repaired: true, stillDamaged: false });
    assert.deepEqual(damageState([], base, after), { repaired: false, stillDamaged: false }, "no damage: nothing repaired, nothing damaged");
    const none = damagedBoot(engine, catalogPackage("felucca"), { corrupt: ["erase:0xff000"], seconds: 0.01 });
    assert.equal(none.damage.applied, false, "the key sector is blank already, so the erase changed nothing");
    assert.deepEqual(none.damage.sectors, []);
    assert.equal(none.damageRepaired, false);
    assert.equal(none.flashStillDamaged, false);
  });

  T("a corruption scenario needs a spec and explicit windows (validated before anything boots)", () => {
    const pkg = new Uint8Array(0);
    assert.throws(() => runCorruptionRecovery(engine, pkg, { corrupt: [], damagedSeconds: 1, reinstallSeconds: 1 }), RangeError);
    assert.throws(() => runCorruptionRecovery(engine, pkg, { corrupt: ["zero:0x4000"], damagedSeconds: 0, reinstallSeconds: 1 }), RangeError);
    assert.throws(() => runCorruptionRecovery(engine, pkg, { corrupt: ["zero:0x4000"], damagedSeconds: 1 }), RangeError);
  });

  T("the committed fixture is exactly what the committed survey yields, and the catalogue agrees with every row and control it names", () => {
    const f = fixture();
    if (existsSync(SURVEY_PATH)) assert.equal(readFileSync(FIXTURE_PATH, "utf8").replace(/\r\n/g, "\n"), serialize(buildFixture(JSON.parse(readFileSync(SURVEY_PATH, "utf8")))), "regenerate with: node ci/machine/recoveryfixture.mjs --write");
    assert.equal(f.version, 1);
    assert.match(f.disclaimer, /not a prediction of the physical chip/);
    assert.deepEqual(f.surveyConfig, { chips: ["puya", "uc25hq80"], timing: "typical", rebootMs: 3000, inputs: true });
    assert.equal(f.engine.sha256, "28dacdb40cee4f7620f306f761a35b820116b62981874dfeb657afe269ba764e", "the survey was produced by the engine with the D-1 fix");
    const byId = new Map(f.rows.map((r) => [r.id, r]));
    assert.equal(byId.size, f.rows.length, "row ids unique");
    for (const r of f.rows) {
      assert.equal(r.stop.outcome, "power-cut", r.id);
      assert.match(r.reportSha256, /^[0-9a-f]{64}$/, r.id);
      assert.notEqual(r.reboot.verdict, "engine-trap", r.id);
      assert.equal(r.cfg.chip, "puya", r.id);
      assert.equal(r.cfg.rebootMs, 3000, r.id);
      assert.equal(r.cfg.policy !== null, true, `${r.id}: an explicit policy`);
    }
    for (const s of POWER_CUT_SCENARIOS) {
      const r = byId.get(s.row);
      assert.ok(r, `${s.id}: its survey row is in the fixture`);
      const e = s.expect;
      assert.deepEqual(r.cfg.policy, s.policy, `${s.id}: the row's explicit outcome policy is the one the catalogue names`);
      assert.equal(r.stop.op, e.op, s.id);
      assert.equal(r.stop.bytesAtRisk, e.bytesAtRisk, s.id);
      assert.equal(r.reboot.verdict, e.verdict, s.id);
      assert.equal(r.reboot.haltedAtMs, e.haltedAtMs, s.id);
      assert.equal(r.reboot.lcdColours, e.lcdColours, s.id);
      assert.equal(classifyRebootReport(r.reboot).label, e.label, s.id);
      for (const bound of ["old", "new", "ff"]) assert.ok([...byId.keys()].some((id) => id === `${s.row.slice(0, s.row.lastIndexOf("/"))}/${bound}`), `${s.id}: the ${bound} bound of the same cut is committed beside it`);
    }
    for (const s of CORRUPTION_SCENARIOS) {
      const c = f.units[s.surveyControl.unit]?.controls.ordinary[s.surveyControl.key];
      assert.ok(c, `${s.id}: the survey's control for the same damage`);
      assert.equal(c.verdict, s.expect.verdict, `${s.id}: the shipped-engine expectation equals the chip-engine survey's own control verdict`);
      assert.equal(c.halted, s.expect.verdict === "crashed", s.id);
      assert.equal(c.powerCut, false, s.id);
    }
  });

  for (const s of CORRUPTION_SCENARIOS.filter((x) => x.tier === "quick")) {
    T(`${s.id} (${s.firmware}, ${s.corrupt.join("+")}): ${s.expect.self}, reinstall recovery boots [shipped engine]`, () => {
      assertCorruptionReport(s, run(engine, s));
    });
  }

  T("a normal idle reset: a healthy machine power-cycled while running boots again with the same flash, the same screen and no damage (quadro-fm1; no write in flight)", () => {
    const pkg = catalogPackage("quadro-fm1");
    const m = Fm1Machine.boot(engine, pkg, { usb: false });
    const first = watch(m, { seconds: 0.2 });
    assert.equal(first.verdict, "booted");
    assert.equal(m.halted || m.powerCut, false, "running and idle: not halted, no power cut (the shipped engine has instant writes, so no cycle is ever in flight)");
    const hash = m.flashHash();
    const again = m.powerCycle();
    assert.equal(again.flashHash(), hash, "the reset carries the flash over unchanged");
    assert.equal(again.changedSectors().length, 0, "no damage, nothing differs from the package");
    const second = watch(again, { seconds: 0.2 });
    assert.equal(isSelfRecovery(second), true, "booted with a non-blank screen again");
    assert.equal(second.final.lcdColours, first.final.lcdColours, "the same screen colours");
    assert.equal(second.final.lcdHash, first.final.lcdHash, "the same picture: a reset of a healthy machine is deterministic");
    assert.equal(again.faultOutcome, null);
  });

  T("a reboot of a damaged flash does not repair it: the machine halts again, with the same flash (coqui, 0x4000 zeroed), and only the intact package boots", () => {
    const s = CORRUPTION_SCENARIOS.find((x) => x.id === "coqui-boot-sector-zeroed");
    const pkg = catalogPackage(s.firmware);
    const d = damagedBoot(engine, pkg, { corrupt: s.corrupt, seconds: 0.3 });
    assert.equal(d.watch.verdict, "crashed");
    const before = d.machine.flash();
    const again = d.machine.powerCycle();
    assert.deepEqual(Buffer.from(again.flash()), Buffer.from(before), "the power cycle carries the same damaged flash");
    assert.equal(Buffer.compare(Buffer.from(again.flash()), Buffer.from(again.baseFlash())) === 0, false, "and it still differs from the package");
    const r = watch(again, { seconds: 0.3 });
    assert.equal(r.verdict, "crashed", "a reset alone is not a recovery");
    assert.equal(r.haltedAtMs, s.expect.haltedAtMs, "it halts at the same instant");
    assert.equal(isSelfRecovery(r), false);
  });
}

export function registerRecoveryFullTests(test, { engine }) {
  for (const s of CORRUPTION_SCENARIOS.filter((x) => x.tier === "full")) {
    test(`recovery: ${s.id} (${s.firmware}, ${s.corrupt.join("+")}): ${s.expect.self}, reinstall recovery boots [shipped engine]`, () => {
      assertCorruptionReport(s, run(engine, s));
    });
  }
  test("recovery: a corruption scenario is deterministic: the same report twice (coqui, 0x4000 zeroed)", () => {
    const s = CORRUPTION_SCENARIOS.find((x) => x.id === "coqui-boot-sector-zeroed");
    assert.deepEqual(run(engine, s), run(engine, s));
  });
  test("recovery: the verdict windows are part of the scenario: a shorter window of the same damage can read differently (felucca halts at 786 ms)", () => {
    const s = CORRUPTION_SCENARIOS.find((x) => x.id === "felucca-code-sector-erased");
    const early = damagedBoot(engine, catalogPackage(s.firmware), { corrupt: s.corrupt, seconds: 0.3 });
    assert.equal(early.watch.verdict, "booted", "inside 0.3 s the damage has not been executed yet: the same flash reads as booted");
    const full = damagedBoot(engine, catalogPackage(s.firmware), { corrupt: s.corrupt, seconds: s.damagedSeconds });
    assert.equal(full.watch.verdict, "crashed");
  });
}

/** The chip-engine tests: registered through `testChip` (reported SKIPPED, never passed, without the chip-profile engine). */
export function registerRecoveryLiveTests(testChip, { chipEngine }) {
  for (const s of POWER_CUT_SCENARIOS) {
    testChip(`recovery (live): ${s.id} (${s.row}): ${s.expect.label}, replayed exactly against the committed survey row`, () => {
      const row = fixture().rows.find((r) => r.id === s.row);
      assert.ok(row, "the committed row");
      const pkg = catalogPackage(s.firmware);
      const report = runFaultScenario(chipEngine, pkg, row.cfg);
      assert.equal(report.reportSha256, row.reportSha256, "the replay is byte-identical to the survey row (engine, package, chip, timing, trigger, policy and seed all the same)");
      assert.equal(report.stop.outcome, "power-cut");
      assert.equal(report.stop.powerCut, true);
      assert.equal(report.stop.halted, false, "a power cut is not a CPU halt");
      assert.equal(report.record.op, s.expect.op);
      assert.equal(report.record.bytesAtRisk, s.expect.bytesAtRisk);
      assert.equal(report.reboot.synthetic, true, "the outcome is labelled synthetic");
      assert.deepEqual(report.reboot.policy, row.cfg.policy);
      assert.equal(report.reboot.verdict, s.expect.verdict);
      assert.equal(report.reboot.haltedAtMs, s.expect.haltedAtMs);
      assert.equal(report.reboot.lcdColours, s.expect.lcdColours);
      assert.equal(classifyRebootReport(report.reboot).label, s.expect.label);
      assert.ok(report.reboot.indeterminateAtEnd.length > 0 || s.expect.op === "program" || s.expect.verdict === "booted", "the unknown bytes outlive the outcome unless the firmware erased them again");
      assert.match(report.disclaimer, /not a prediction of the physical chip/);
      // reinstall recovery: a FRESH machine from the intact package on the same chip profile (no cut, no carried flash, no outcome)
      const fresh = Fm1Machine.boot(chipEngine, pkg, { usb: false, flashChip: "puya", flashTiming: "typical" });
      assert.equal(Buffer.compare(Buffer.from(fresh.flash()), Buffer.from(fresh.baseFlash())), 0, "intact");
      assert.deepEqual(fresh.indeterminateRanges(), [], "no unknown bytes: it is a different, fresh flash");
      assert.equal(isSelfRecovery(watch(fresh, { seconds: 1.0 })), true, "reinstall recovery: the intact package boots on the same chip profile");
    });
  }

  testChip("recovery (live): powerCycle() cannot interrupt a write: a cycle still running at the reset is kept as completed, with no unknown bytes (so 'reset during write' is a power CUT scenario, not a powerCycle one)", () => {
    const pkg = catalogPackage("quadro-fm1");
    const m = Fm1Machine.boot(chipEngine, pkg, { usb: false, flashChip: "puya", flashTiming: "typical" });
    const base = m.baseFlash();
    let at = -1;
    for (let a = 0; a < base.length; a += 4096) if (base.subarray(a, a + 4096).some((b) => b !== 0xff)) { at = a; break; }
    assert.ok(at >= 0, "the package has a sector with data");
    const chip = new LiveChip(m);
    chip.wren();
    chip.tx([0x20, (at >> 16) & 255, (at >> 8) & 255, at & 255]);                  // sector erase, accepted: the cycle is running
    assert.equal(m.flashWip(), true, "the erase is in flight (WIP)");
    assert.equal(m.powerCut, false, "no cut was armed or fired");
    const next = m.powerCycle();
    assert.deepEqual([...next.flash().subarray(at, at + 4096)].every((b) => b === 0xff), true, "the reset kept the erase as COMPLETED (array-at-accept; a running cycle is treated as completing)");
    assert.deepEqual(next.indeterminateRanges(), [], "nothing was recorded as interrupted");
    assert.equal(next.faultOutcome, null, "no outcome policy was involved");
    // the valid way to interrupt it is a power cut, which does leave a record
    const cut = Fm1Machine.boot(chipEngine, pkg, { usb: false, flashChip: "puya", flashTiming: "typical", faultJournal: true });
    const live = new LiveChip(cut);
    live.wren();
    live.tx([0x20, (at >> 16) & 255, (at >> 8) & 255, at & 255]);
    const record = cut.cutPower();
    assert.equal(cut.powerCut, true);
    assert.equal(record.op, "erase4k");
    assert.deepEqual(cut.indeterminateRanges(), [[at, at + 4095]], "a cut records the interrupted range as indeterminate");
  });
}
