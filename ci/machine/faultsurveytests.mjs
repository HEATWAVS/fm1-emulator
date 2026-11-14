// Tests of the fault survey tool and its committed results (Component 5, Stage 5E).
//
// Quick tier (no engine): the plan (units, replay selection, tallies, tables) over synthetic rows, the harness-issued scenario configuration, and invariants of the committed results
// file docs/dev/fault-survey.json (if it is there): every row internally consistent, the replay identical, no row claiming anything about a physical chip.
// Full tier (needs the chip-profile engine; SKIPPED without it): harness-issued scenarios of every cycle kind are exact, deterministic and replayable; the ordinary-fault control is a
// halt and never a power cut; and the KNOWN pre-existing engine defect that an all-zero flash makes the emulator trap is pinned (and reported as its own verdict, not a firmware result).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Fm1Machine, corruptedSectors } from "./machine.mjs";
import { CONFIG, unitList, summarize, summaryMarkdown, replaySelection, annotateAgainstOld, rowOf, SURVEY_VERSION } from "./faultsurvey.mjs";
import { DEFAULT_SET } from "./firmware-survey.mjs";
import { runFaultScenario, normalizeScenario, INJECT_KINDS } from "./faultscenario.mjs";
import { FaultHarnessError } from "./fault.mjs";
import { DISCLAIMER } from "./faultpolicy.mjs";

const RESULTS = resolve(import.meta.dirname, "../../docs/dev/fault-survey.json");
const CODE = (code) => (e) => e instanceof FaultHarnessError && e.code === code;
const row = (id, o) => ({ id, firmware: "f", chip: "puya", origin: "firmware", kind: "program", point: "accept", policy: "old", stop: { outcome: "power-cut", requestedCutCycle: 1, actualCutCycle: 1 },
  reboot: { verdict: "booted", screenMatchesFreshBoot: true, unknownReads: 0, rangeErasedAgain: false, firmwareFlashChanges: 0 }, ...o });

export function registerFaultSurveyQuickTests(testQuick) {
  const T = (name, fn) => testQuick(`fault survey: ${name}`, fn);

  T("the plan: 17 firmware x 2 chip profiles in a fixed order, the fixed coverage matrix is explicit, and the harness-issued kinds are the five in-scope cycle kinds", () => {
    const units = unitList();
    assert.equal(units.length, DEFAULT_SET.length * CONFIG.chips.length);
    assert.deepEqual(units[0], { fw: "felucca", chip: "puya" });
    assert.deepEqual(units[1], { fw: "felucca", chip: "uc25hq80" });
    assert.deepEqual(CONFIG.harnessKinds, Object.keys(INJECT_KINDS), "every kind the engine can interrupt is swept by the harness");
    assert.deepEqual(CONFIG.chips, ["puya", "uc25hq80"]);
    assert.equal(SURVEY_VERSION, 1);
    assert.ok(CONFIG.firmwarePolicies.every((p) => ["old", "new", "ff"].includes(p)), "the point sweep uses the bounding policies");
    assert.deepEqual(new Set([...CONFIG.harnessPolicies, ...CONFIG.harnessExtraPolicies]), new Set(["old", "new", "ff", "random#1", "zero", "prefix@0.5", "bit-mix#1", "random#2"]), "the harness-issued sweep meets every policy kind too");
    assert.deepEqual(new Set([...CONFIG.firmwarePolicies, ...CONFIG.policySweepExtra]), new Set(["old", "new", "ff", "zero", "prefix@0.5", "random#1", "random#2", "bit-mix#1", "bit-mix#2"]), "every policy kind is exercised, the seeded ones with two seeds");
  });

  T("the replay selection is deterministic, covers every (origin, kind, policy) and a fixed share of the rest", () => {
    const rows = [];
    for (const origin of ["firmware", "harness"]) for (const kind of ["program", "erase4k"]) for (const policy of ["old", "ff", "random#1"]) for (let i = 0; i < 30; i++) rows.push(row(`${origin}/${kind}/${policy}/${String(i).padStart(2, "0")}`, { origin, kind, policy }));
    const a = replaySelection(rows), b = replaySelection([...rows].reverse());
    assert.deepEqual(a, b, "independent of input order");
    const keys = new Set(a.map((id) => id.split("/").slice(0, 3).join("/")));
    assert.equal(keys.size, 12, "one per (origin, kind, policy) at least");
    assert.ok(a.length >= 12 && a.length < rows.length);
    assert.equal(new Set(a).size, a.length);
    const coverageOnly = replaySelection(rows, 100_000);
    assert.equal(new Set(coverageOnly.map((id) => id.split("/").slice(0, 3).join("/"))).size, 12, "the per-(origin, kind, policy) rule alone covers every combination");
    assert.equal(coverageOnly.length, 12);
  });

  T("tallies count what the emulator showed, separate cuts that fired from triggers that did not, and never invent a verdict", () => {
    const rows = [
      row("a", {}), row("b", { reboot: { verdict: "crashed", screenMatchesFreshBoot: false, unknownReads: 3, rangeErasedAgain: true, firmwareFlashChanges: 2 } }),
      row("c", { stop: { outcome: "not-triggered", requestedCutCycle: null, actualCutCycle: null }, reboot: null }),
      row("d", { stop: { outcome: "halted", requestedCutCycle: null, actualCutCycle: null }, reboot: null }),
      row("e", { reboot: { verdict: "engine-trap", screenMatchesFreshBoot: null, unknownReads: null, rangeErasedAgain: null, firmwareFlashChanges: null } }),
    ];
    const s = summarize({ rows });
    assert.deepEqual(s.total, { scenarios: 5, cutFired: 3, notTriggered: 1, haltedBeforeCut: 1, verdicts: { booted: 1, crashed: 1, "engine-trap": 1 }, screenMatchesFreshBoot: 1, readUnknownBytes: 1, rangeErasedAgain: 1, firmwareWroteAfterReboot: 1, engineTraps: 1, comparedWithOld: 0, sameScreenAsOld: 0, sameFlashAsOld: 0 });
    const md = summaryMarkdown({ rows });
    assert.match(md, /### By chip profile/);
    assert.match(md, /\| puya \| 5 \| 3 \| 1 \| 1 \| 1 \| 1 \| 0 \| 0 \| 1 \|/);
    assert.match(md, /comparedWithOld/);
  });

  T("every reboot is compared with the same scenario under the `old` bound (the cut left the flash as it was): screen and flash, null where there is no partner", () => {
    const mk = (policy, lcd, flash, unit = "u") => row(`${unit}/${policy}`, { unit, origin: "harness", kind: "program", cycle: null, point: "f0.5", policy, reboot: { verdict: "booted", lcdHash: lcd, flashHash: flash, screenMatchesFreshBoot: true, unknownReads: 0, rangeErasedAgain: false, firmwareFlashChanges: 0 } });
    const rows = [mk("old", "L1", "F1"), mk("ff", "L1", "F2"), mk("zero", "L2", "F2"), mk("ff", "L9", "F9", "other")];
    const out = annotateAgainstOld(rows);
    assert.deepEqual(out.map((r) => [r.reboot.screenSameAsOldBound, r.reboot.flashSameAsOldBound]), [[null, null], [true, false], [false, false], [null, null]]);
    const s = summarize({ rows: out });
    assert.deepEqual([s.total.comparedWithOld, s.total.sameScreenAsOld, s.total.sameFlashAsOld], [2, 1, 0]);
  });

  T("a result row records whether the screen after the reboot matches a fresh boot (and the hashes it compared)", () => {
    const rep = { config: { chip: "puya" }, stop: { outcome: "power-cut", status: "power_cut" }, record: { requestedCutCycle: 5, actualCutCycle: 5, op: "program", bytesAtRisk: 4, ranges: [[0, 3]] },
      reboot: { verdict: "booted", haltedAtMs: null, lcdHash: "aa", lcdColours: 9, indeterminateReads: 1, indeterminateCarriedIn: [[0, 3]], indeterminateAtEnd: [], flashChangesByFirmware: 2, outcome: { hash: "oo" }, flashHash: "ff" }, reportSha256: "s" };
    const same = rowOf("i", { firmware: "f" }, rep, { lcdHash: "aa" }), other = rowOf("i", { firmware: "f" }, rep, { lcdHash: "bb" });
    assert.equal(same.reboot.screenMatchesFreshBoot, true);
    assert.equal(other.reboot.screenMatchesFreshBoot, false);
    assert.deepEqual([same.reboot.unknownBytesCarriedIn, same.reboot.unknownBytesAtEnd, same.reboot.rangeErasedAgain, same.reboot.lcdHash, same.reboot.flashHash], [4, 0, true, "aa", "ff"]);
    const trap = rowOf("i", { firmware: "f" }, { ...rep, reboot: { ...rep.reboot, verdict: "engine-trap", trap: "unreachable", lcdHash: null, flashHash: null, indeterminateAtEnd: null, indeterminateReads: null, flashChangesByFirmware: null } }, { lcdHash: "aa" });
    assert.deepEqual([trap.reboot.verdict, trap.reboot.screenMatchesFreshBoot, trap.reboot.unknownBytesAtEnd, trap.reboot.rangeErasedAgain], ["engine-trap", null, null, null], "a trapped run has no screen to compare");
  });

  T("a harness-issued scenario is validated before anything boots: the kind, the matching trigger, the address", () => {
    const ok = { fault: { op: "erase4k", at: { atAccept: true } }, inject: { kind: "erase4k", address: 0x74000 } };
    assert.deepEqual(normalizeScenario(ok).inject, { kind: "erase4k", address: 0x74000, warmupMs: 1500 });
    assert.throws(() => normalizeScenario({ ...ok, inject: { kind: "wrsr" } }), CODE("bad-inject"));
    assert.throws(() => normalizeScenario({ ...ok, inject: { kind: "erase32k" } }), CODE("bad-inject"), "the trigger must interrupt the kind that is issued");
    assert.throws(() => normalizeScenario({ inject: { kind: "erase4k" } }), CODE("bad-inject"), "an injected command needs a trigger");
    assert.throws(() => normalizeScenario({ ...ok, inject: { kind: "erase4k", address: 1 << 20 } }), CODE("bad-inject"));
    assert.throws(() => normalizeScenario({ ...ok, inject: { kind: "erase4k", warmupMs: -1 } }), CODE("bad-inject"));
    assert.throws(() => normalizeScenario({ ...ok, fault: { op: "erase4k", at: { afterCycles: 150_050 } } }), CODE("bad-inject"), "a cycle-exact trigger the chip clock cannot land on is refused, not rounded");
    assert.deepEqual(normalizeScenario({ ...ok, fault: { op: "erase4k", at: { afterCycles: 150_000 } } }).fault.at, { afterCycles: 150_000 });
    assert.throws(() => normalizeScenario({ ...ok, mhz: 24, fault: { op: "erase4k", at: { afterCycles: 100 } } }), CODE("bad-inject"), "the unit is the clock's cycles per microsecond");
    assert.equal(normalizeScenario({}).inject, null);
    assert.equal(normalizeScenario({ inputs: true }).inputs, true);
  });

  T("the committed results are internally consistent and say nothing about a physical chip", () => {
    if (!existsSync(RESULTS)) { assert.ok(true, "no results file committed yet"); return; }
    const r = JSON.parse(readFileSync(RESULTS, "utf8"));
    assert.equal(r.version, SURVEY_VERSION);
    assert.equal(r.disclaimer, DISCLAIMER);
    assert.deepEqual(r.config, JSON.parse(JSON.stringify(CONFIG)), "the results were produced by the coverage the tool states");
    assert.equal(new Set(r.rows.map((x) => x.id)).size, r.rows.length, "ids are unique");
    assert.equal(Object.values(r.units).reduce((n, u) => n + u.rows, 0), r.rows.length);
    assert.equal(Object.keys(r.units).length, unitList().length, "every unit ran");
    const verdicts = new Set(["booted", "crashed", "blank", "display-lost", "engine-trap"]);
    for (const x of r.rows) {
      if (x.stop.outcome === "power-cut") {
        assert.ok(x.reboot, `${x.id}: a cut that fired was rebooted`);
        assert.equal(x.stop.actualCutCycle, x.stop.requestedCutCycle, `${x.id}: the cut fires exactly at its cycle`);
        assert.ok(x.stop.bytesAtRisk > 0 && x.stop.ranges > 0, x.id);
        assert.ok(verdicts.has(x.reboot.verdict), `${x.id}: ${x.reboot.verdict}`);
        assert.ok(x.reboot.unknownBytesCarriedIn > 0, `${x.id}: the unknown bytes were carried into the reboot`);
      } else assert.equal(x.reboot, null, `${x.id}: no cut, no reboot`);
      assert.equal(x.cfg.rebootMs, CONFIG.rebootMs);
      assert.ok(x.cfg.policy && x.cfg.policy.kind, `${x.id}: an explicit policy, never a default`);
      assert.ok(/^[0-9a-f]{64}$/.test(x.reportSha256));
    }
    for (const [name, u] of Object.entries(r.units)) {
      assert.equal(u.controls.noFault.powerCut, false, `${name}: the control run has no power cut`);
      assert.equal(u.controls.noFault.status === "power_cut", false);
      for (const [spec, c] of Object.entries(u.controls.ordinary)) assert.notEqual(c.powerCut, true, `${name} ${spec}: an ordinary flash fault is never a power cut`);
    }
    assert.equal(r.replay.mismatches.length, 0, "repeated runs gave identical reports");
    assert.equal(r.replay.identical, r.replay.rows);
    assert.ok(r.replay.rows >= 90);
    assert.deepEqual(r.summary, summarize(r), "the stored summary is the summary of the stored rows");
    assert.doesNotMatch(JSON.stringify(r), /would (hold|recover|survive)|real hardware (recovers|survives)/i, "no claim about physical behaviour");
  });
}

export function registerFaultSurveyLiveTests(testChip, { chipEngine, shipped, pkg, quadro }) {
  const T = (name, fn) => testChip(`fault survey: ${name}`, fn);
  const harness = (kind, point, policy, extra = {}) => ({ fault: { op: kind, nth: 1, at: point }, inject: { kind, address: 0x74000 }, policy, rebootMs: 1000, ...extra });
  const KIND_BYTES = { program: 16, erase4k: 4096, erase32k: 32768, erase64k: 65536, "chip-erase": 1 << 20 };

  T("a harness-issued command of every cycle kind is cut exactly at its requested cycle, puts exactly its unit at risk, and replays byte for byte", () => {
    for (const kind of Object.keys(KIND_BYTES)) {
      for (const point of [{ atAccept: true }, { fraction: 0.5 }, { fraction: 0.999 }, { fraction: 1 / 3 }, { afterUs: 1234 }, { afterCycles: 150_000 }]) {
        const cfg = harness(kind, point, { kind: "old" }, { rebootMs: 0 });
        const a = runFaultScenario(chipEngine, quadro, cfg);
        const tag = `${kind} ${JSON.stringify(point)}`;
        assert.equal(a.stop.outcome, "power-cut", tag);
        assert.equal(a.stop.origin, "harness");
        assert.equal(a.record.requestedCutCycle, a.record.actualCutCycle, `${tag}: exact`);
        assert.equal(a.record.op, kind);
        assert.equal(a.record.bytesAtRisk, KIND_BYTES[kind], tag);
        assert.equal(a.state.interrupted, 1);
        assert.equal(a.state.completed, a.state.accepted - 1, "only the injected cycle was interrupted");
        if ("fraction" in point) {
          const dur = { program: 2000, erase4k: 8000, erase32k: 8000, erase64k: 8000, "chip-erase": 8000 }[kind];
          assert.equal(a.record.requestedCutCycle - a.record.acceptedAtCycle, Math.floor(point.fraction * dur) * 100, `${tag}: the offset is floor(fraction * duration) microseconds`);
        }
        if ("afterUs" in point) assert.equal(a.record.requestedCutCycle - a.record.acceptedAtCycle, 123_400, `${tag}: microseconds are 100 cycles each`);
        if ("afterCycles" in point) assert.equal(a.record.requestedCutCycle - a.record.acceptedAtCycle, point.afterCycles, `${tag}: the exact integer form`);
        if (kind === "program") assert.match(a.record.images.ifCompletedHex, /^(00)+$/, `${tag}: the injected data is the labelled test input 0x00`);
      }
    }
    const once = runFaultScenario(chipEngine, quadro, harness("erase64k", { fraction: 0.5 }, { kind: "random", seed: 3 }));
    const twice = runFaultScenario(chipEngine, quadro, harness("erase64k", { fraction: 0.5 }, { kind: "random", seed: 3 }));
    assert.equal(once.reportSha256, twice.reportSha256, "a harness-issued scenario with a seeded outcome replays byte for byte");
    assert.deepEqual(once.reboot.indeterminateCarriedIn, once.indeterminate);
  });

  T("a firmware-issued scenario with the survey's input script is deterministic and a harness-issued one needs the chip idle", () => {
    const cfg = { fault: { op: "any", nth: 2, at: { fraction: 0.5 } }, policy: { kind: "bit-mix", seed: 2 }, rebootMs: 1500, maxMs: 8000, inputs: true };
    const a = runFaultScenario(chipEngine, quadro, cfg), b = runFaultScenario(chipEngine, quadro, cfg);
    assert.equal(a.reportSha256, b.reportSha256);
    assert.equal(a.stop.origin, "firmware");
    assert.equal(a.record.op, "program", "quadro-fm1's second in-scope cycle is a program");
    assert.equal(a.record.requestedCutCycle, a.record.actualCutCycle);
    assert.equal(a.config.inputs, true);
  });

  T("the ordinary-fault controls are halts (or plain boots), never power cuts; Felucca with sector 0x20000 erased halts", () => {
    const sectors = corruptedSectors(chipEngine, pkg, ["erase:0x20000"], { usb: false });
    const m = Fm1Machine.boot(chipEngine, pkg, { usb: false, flashChip: "puya", sectors });
    m.run(3000);
    assert.deepEqual([m.halted, m.powerCut, m.status], [true, false, "halted"]);
  });

  T("KNOWN PRE-EXISTING ENGINE DEFECT: an all-zero flash makes the emulator trap (a Rust panic in Soc::read32_slow), in the shipped engine too; a scenario reports it as the verdict `engine-trap`, never as a firmware result", () => {
    const zero = []; for (let a = 0; a < 1 << 20; a += 4096) zero.push({ at: a, data: new Uint8Array(4096) });
    for (const [name, eng] of [["shipped", shipped], ["chip engine", chipEngine]]) {
      const m = Fm1Machine.boot(eng, quadro, { usb: false, sectors: zero });
      assert.throws(() => m.run(3000), (e) => e instanceof WebAssembly.RuntimeError, `${name} traps on an all-zero flash (not a CPU halt)`);
    }
    // reached through the fault workflow: a chip erase interrupted late, rebooted with the explicit `zero` outcome
    const r = runFaultScenario(chipEngine, quadro, harness("chip-erase", { fraction: 0.999 }, { kind: "zero" }, { rebootMs: 2000 }));
    assert.equal(r.stop.outcome, "power-cut");
    assert.equal(r.reboot.verdict, "engine-trap");
    assert.match(r.reboot.trap, /unreachable/);
    assert.equal(r.reboot.synthetic, true);
    assert.equal(r.reboot.haltedAtMs, null, "an engine trap is not a CPU halt");
  });
}
