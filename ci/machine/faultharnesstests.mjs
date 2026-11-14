// Harness-level fault-injection tests (Component 5, Stage 5D): the Fm1Machine API over the 5C-3 exports, the scenario runner, the CLI option.
//
// Quick tier (no chip engine needed): a stand-in engine that counts calls proves the pure harness logic: spec validation and encoding, refusal before anything boots, run() stopping
// at once on a power cut and staying stopped, the three states kept apart, the explicit-outcome rule of powerCycle().
// Full tier (needs the chip-profile engine; reported SKIPPED without it): real firmware: a successful run, a power cut, an ordinary crash, deterministic replay, inspection of the
// affected ranges, "a power-cut machine cannot continue", carrying the indeterminate list across a reboot with an explicit synthetic outcome, the CLI.
// Nothing here claims what a physical chip holds after a cut: outcomes are named synthetic policies, kept apart from the engine's own record.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Fm1Machine, corruptedSectors } from "./machine.mjs";
import { watch } from "./monitor.mjs";
import { LiveChip, pat } from "./chiplive.mjs";
import { parseFaultSpec, FaultHarnessError, FAULT_OPS } from "./fault.mjs";
import { runFaultScenario, normalizeScenario } from "./faultscenario.mjs";
import { materialize } from "./faultpolicy.mjs";

const a3 = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const hashOf = (u8) => Buffer.from(u8).toString("hex");
const CODE = (code) => (e) => e instanceof FaultHarnessError && e.code === code;

/** A stand-in for the engine's exports: enough for Fm1Machine.run/status/powerCycle, counting every call. `script` decides when it halts or loses power. */
function standIn({ cutAfterRenders = Infinity, haltAfterRenders = Infinity } = {}) {
  const memory = new WebAssembly.Memory({ initial: 40 });
  const calls = { render: 0, other: [] };
  const x = {
    memory,
    fm1_halted: () => (calls.render >= haltAfterRenders ? 1 : 0),
    fm1_power_cut: () => (calls.render >= cutAfterRenders ? 1 : 0),
    fm1_fault_record: () => -1,                          // no record (the cut is only a flag here)
    fm1_render: () => { calls.render++; },
    fm1_out_l: () => 0x20000,
    fm1_flash: () => 0x40000,
    fm1_flash_len: () => 1 << 20,
  };
  const engine = { name: "stand-in", capabilities: { boot: true, flashRead: true, faultInjection: true, selectFlashChip: true, flashBase: true } };
  const m = new Fm1Machine(engine, x, new Uint8Array(4), { mhz: 100 });
  m.flashChipInfo = { chip: "puya", timing: "typical", jedec: [0x85, 0x60, 0x14] };
  return { m, x, calls, engine };
}

export function registerFaultHarnessQuickTests(testQuick) {
  const T = (name, fn) => testQuick(`fault harness: ${name}`, fn);

  T("a fault spec is validated and encoded exactly as fm1_fault_arm takes it; an outcome policy is never part of a trigger", () => {
    const enc = (spec) => parseFaultSpec(spec).args;
    assert.deepEqual(enc({ op: "program", at: { atAccept: true } }), [0, 1, 0, 0]);
    assert.deepEqual(enc({ op: "erase64k", nth: 2, at: { afterCycles: 123 } }), [3, 2, 3, 123]);
    assert.deepEqual(enc({ op: "chip-erase", at: { afterUs: 5 } }), [5, 1, 2, 5]);
    assert.deepEqual(enc({ op: "any", nth: 3, at: { fraction: 0.25 } }), [6, 3, 1, 0.25]);
    assert.deepEqual(Object.keys(FAULT_OPS), ["program", "erase4k", "erase32k", "erase64k", "erase", "chip-erase", "any"]);
    assert.deepEqual(parseFaultSpec({ op: "erase", at: { afterCycles: 7 } }).canonical, { op: "erase", nth: 1, at: { afterCycles: 7 } }, "defaults filled in");
    for (const [spec, code] of [
      [null, "bad-spec"], [[], "bad-spec"], [{ op: "wrsr", at: { atAccept: true } }, "bad-op"], [{ op: "program", nth: 0, at: { atAccept: true } }, "bad-nth"],
      [{ op: "program", nth: 1.5, at: { atAccept: true } }, "bad-nth"], [{ op: "program" }, "bad-at"], [{ op: "program", at: {} }, "bad-at"],
      [{ op: "program", at: { atAccept: true, afterUs: 1 } }, "bad-at"], [{ op: "program", at: { atAccept: false } }, "bad-at"], [{ op: "program", at: { fraction: 1 } }, "bad-at"],
      [{ op: "program", at: { fraction: -0.1 } }, "bad-at"], [{ op: "program", at: { afterCycles: 1.5 } }, "bad-at"], [{ op: "program", at: { afterCycles: -1 } }, "bad-at"],
      [{ op: "program", at: { afterUs: 2 ** 32 } }, "bad-at"], [{ op: "program", at: { atAccept: true }, policy: { kind: "ff" } }, "policy-not-here"],
      [{ op: "program", at: { atAccept: true }, fill: "ff" }, "policy-not-here"], [{ op: "program", at: { atAccept: true }, seed: 1 }, "policy-not-here"],
      [{ op: "program", at: { atAccept: true }, nope: 1 }, "bad-spec"],
    ]) assert.throws(() => parseFaultSpec(spec), CODE(code), JSON.stringify(spec));
  });

  T("a scenario is normalised with every default visible, and refuses what it cannot run before anything boots", () => {
    const n = normalizeScenario({ fault: { op: "any", at: { afterCycles: 5000 } }, policy: { kind: "random", seed: 3 }, rebootMs: 500 });
    assert.deepEqual(n, { chip: "puya", timing: "typical", fault: { op: "any", nth: 1, at: { afterCycles: 5000 } }, maxMs: 3000, policy: { kind: "random", seed: 3 }, rebootMs: 500, mhz: 100, jit: false, flashUid: null });
    assert.throws(() => normalizeScenario({ chip: "legacy" }), CODE("needs-chip"));
    assert.throws(() => normalizeScenario({ rebootMs: 100 }), CODE("outcome-required"), "a reboot needs an explicit policy: there is no default fill");
    assert.throws(() => normalizeScenario({ rebootMs: 100, policy: { kind: "random" } }), /seed/, "and a seeded fill needs its seed");
    assert.throws(() => normalizeScenario({ fault: { op: "program" } }), CODE("bad-at"));
    assert.equal(normalizeScenario({}).policy, null);
  });

  T("bad or unusable fault options are refused before anything boots (no engine call is made)", () => {
    const boots = [];
    const engine = { name: "stand-in", capabilities: { boot: true, flashRead: true, faultInjection: true, selectFlashChip: true }, instantiate() { boots.push(1); throw new Error("booted"); } };
    const noFault = { ...engine, capabilities: { boot: true, flashRead: true, selectFlashChip: true } };
    const spec = { op: "program", at: { atAccept: true } };
    assert.throws(() => Fm1Machine.boot(engine, new Uint8Array(4), { fault: spec }), CODE("needs-chip"), "the legacy model has no cycle to interrupt");
    assert.throws(() => Fm1Machine.boot(engine, new Uint8Array(4), { faultJournal: true }), CODE("needs-chip"));
    assert.throws(() => Fm1Machine.boot(noFault, new Uint8Array(4), { flashChip: "puya", fault: spec }), CODE("unsupported-engine"));
    assert.throws(() => Fm1Machine.boot(engine, new Uint8Array(4), { flashChip: "puya", fault: { op: "program" } }), CODE("bad-at"));
    assert.throws(() => Fm1Machine.boot(engine, new Uint8Array(4), { flashChip: "puya", fault: { op: "program", at: { atAccept: true }, policy: { kind: "ff" } } }), CODE("policy-not-here"));
    assert.deepEqual(boots, [], "nothing booted");
  });

  T("run() stops at once on a power cut and stays stopped; a power cut is never a halt and a halt is never a power cut", () => {
    const { m, x, calls } = standIn({ cutAfterRenders: 3 });
    assert.equal(m.status, "running");
    m.run(1000);                                          // 1000 ms is 345 quanta
    assert.equal(calls.render, 3, "rendered up to the quantum in which the cut fired and not one more");
    assert.equal(m.frames, 3 * 128);
    assert.deepEqual([m.powerCut, m.halted, m.status, x.fm1_halted()], [true, false, "power_cut", 0], "a power cut is not a halt");
    for (let i = 0; i < 5; i++) m.run(1000);
    assert.equal(calls.render, 3, "a machine without power never renders again");
    assert.equal(m.frames, 3 * 128);

    const h = standIn({ haltAfterRenders: 2 });
    h.m.run(1000);
    assert.equal(h.calls.render, 2);
    assert.deepEqual([h.m.powerCut, h.m.halted, h.m.status], [false, true, "halted"], "a halt is not a power cut");
    h.m.run(1000);
    assert.equal(h.calls.render, 2, "a halted machine does not run either (as before)");

    const e = { ...standIn().engine, capabilities: { boot: true, flashRead: true } };    // an engine without fault injection can never report a cut
    const plain = new Fm1Machine(e, { memory: new WebAssembly.Memory({ initial: 1 }), fm1_halted: () => 0, fm1_render() {}, fm1_out_l: () => 0 }, new Uint8Array(4), {});
    assert.equal(plain.powerCut, false);
    assert.equal(plain.status, "running");
  });

  T("runUntilCut reports power-cut, halted or not-triggered, never throws for a missing cut, and stops promptly", () => {
    const a = standIn({ cutAfterRenders: 5 });
    const ra = a.m.runUntilCut(10_000);
    assert.equal(ra.outcome, "power-cut");
    assert.ok(a.calls.render <= 5 + 18, `${a.calls.render} renders`);               // (one step of 50 ms is 18 quanta; the cut fires in the 5th)
    assert.equal(a.m.runUntilCut(10_000).outcome, "power-cut", "and stays so");
    const b = standIn({ haltAfterRenders: 4 });
    assert.equal(b.m.runUntilCut(10_000).outcome, "halted");
    const c = standIn();
    const rc = c.m.runUntilCut(200);
    assert.deepEqual([rc.outcome, rc.record], ["not-triggered", null]);
    assert.ok(rc.ranMs >= 200 && rc.ranMs < 300, `${rc.ranMs} ms`);
    assert.throws(() => c.m.runUntilCut(0), RangeError);
  });

  T("powerCycle() of a power-cut machine needs an explicit outcome; outcome without a cut is refused; nothing is invented", () => {
    const { m } = standIn({ cutAfterRenders: 1 });
    m.run(100);
    assert.equal(m.powerCut, true);
    assert.throws(() => m.powerCycle(), CODE("outcome-required"), "no default fill");
    assert.throws(() => m.powerCycle({ outcome: null }), CODE("outcome-required"));
    const ok = standIn();
    assert.throws(() => ok.m.powerCycle({ outcome: { kind: "ff" } }), CODE("outcome-without-cut"));
  });
}

export function registerFaultHarnessLiveTests(testChip, { chipEngine, shipped, pkg, quadro }) {
  const T = (name, fn) => testChip(`fault harness: ${name}`, fn);
  const AFTER = { op: "any", nth: 1, at: { afterCycles: 5000 } };        // quadro-fm1's first flash write on the Puya profile, cut 5,000 cycles in
  const boot = (options = {}) => Fm1Machine.boot(chipEngine, quadro, { flashChip: "puya", usb: false, ...options });
  const snapshot = (m) => ({ cycles: m.x.fm1_cycles(), minsns: m.x.fm1_minsns(), ms: m.x.fm1_ms(), flash: m.flashHash(), lcd: hashOf(m.lcd()), frames: m.frames, rev: m.x.fm1_flash_revision() });

  T("a successful run: no trigger, a trigger that never matches and a control that completes report no cut, no halt and no record", () => {
    const control = runFaultScenario(chipEngine, quadro, { fault: null, maxMs: 1500 });
    assert.deepEqual([control.stop.outcome, control.stop.status, control.record, control.indeterminate, control.reboot], ["ran", "running", null, [], null]);
    assert.equal(control.state.fired, 0);
    const never = runFaultScenario(chipEngine, quadro, { fault: { op: "chip-erase", at: { atAccept: true } }, maxMs: 1500 });     // quadro-fm1 never chip-erases
    assert.deepEqual([never.stop.outcome, never.stop.status, never.record], ["not-triggered", "running", null]);
    assert.equal(never.state.armed, true, "still armed: it simply never matched");
    assert.equal(never.state.seen, 0);
    assert.equal(never.flash.hashAtStop, control.flash.hashAtStop, "an armed trigger that never matches changes nothing the firmware did");
    assert.equal(never.state.accepted, control.state.accepted);
  });

  T("a power cut stops the machine as a power cut: status, observation, watch verdict and CLI exit code, never a crash", () => {
    const m = boot({ fault: AFTER });
    assert.deepEqual(m.faultInfo, AFTER);
    const r = m.runUntilCut(3000);
    assert.equal(r.outcome, "power-cut");
    assert.deepEqual([m.powerCut, m.halted, m.status], [true, false, "power_cut"]);
    const o = m.observe();
    assert.deepEqual([o.powerCut, o.halted], [true, false], "observed apart");
    const w = watch(boot({ fault: AFTER }), { seconds: 3 });
    assert.equal(w.verdict, "power-cut");
    assert.equal(w.haltedAtMs, null, "not a crash");
    assert.equal(typeof w.powerCutAtMs, "number");
    assert.ok(w.samples.length < 30, "watch stops at the cut");
    const cli = spawnSync(process.execPath, [resolve(import.meta.dirname, "cli.mjs"), "--fw", "quadro-fm1", "--flash-chip", "puya", "--fault", JSON.stringify(AFTER), "--expect", "power-cut", "--seconds", "3", "--json", "--engine", chipEngine.wasmPath], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    const j = JSON.parse(cli.stdout);
    assert.deepEqual([j.verdict, j.pass, j.fault.status, j.fault.halted, j.haltedAtMs], ["power-cut", true, "power_cut", false, null]);
    assert.equal(j.fault.record.requestedCutCycle, j.fault.record.actualCutCycle);
    const crashed = spawnSync(process.execPath, [resolve(import.meta.dirname, "cli.mjs"), "--fw", "quadro-fm1", "--flash-chip", "puya", "--fault", JSON.stringify(AFTER), "--expect", "crashed", "--seconds", "3", "--engine", chipEngine.wasmPath], { encoding: "utf8" });
    assert.equal(crashed.status, 1, "a power cut does not satisfy --expect crashed");
  });

  T("an ordinary crash stays a halt: verdict crashed, powerCut false, even with a trigger armed", () => {
    const sectors = corruptedSectors(chipEngine, pkg, ["erase:0x20000"], { usb: false });
    const m = Fm1Machine.boot(chipEngine, pkg, { usb: false, flashChip: "puya", sectors, fault: { op: "chip-erase", at: { atAccept: true } } });
    const r = m.runUntilCut(3000);
    assert.equal(r.outcome, "halted");
    assert.deepEqual([m.halted, m.powerCut, m.status, r.record], [true, false, "halted", null]);
    const w = watch(Fm1Machine.boot(chipEngine, pkg, { usb: false, flashChip: "puya", sectors }), { seconds: 3 });
    assert.equal(w.verdict, "crashed");
    assert.equal(w.powerCutAtMs, undefined, "no power-cut field on a crash");
  });

  T("the audit record and the indeterminate ranges: requested = actual cycle, the machine stopped there, the placeholder is the engine's pre-image, unknown bytes are marked", () => {
    const m = boot({ fault: AFTER });
    m.runUntilCut(3000);
    const s = m.faultState(), rec = s.record;
    assert.equal(rec.source, "scheduled");
    assert.equal(rec.requestedCutCycle, rec.acceptedAtCycle + 5000, "requested = accept + 5000 cycles");
    assert.equal(rec.actualCutCycle, rec.requestedCutCycle, "fired exactly at its cycle under the machine's own loops");
    assert.equal(s.cycles, rec.actualCutCycle, "and the machine stopped there");
    assert.ok(rec.endWouldBeAtCycle > rec.requestedCutCycle);
    assert.deepEqual(s.indeterminate, rec.ranges, "the bytes the cut put at risk are the indeterminate list");
    assert.equal(s.interrupted, 1);
    assert.equal(s.completed, 0);
    assert.deepEqual([s.powerCut, s.halted, s.chipOff, s.status], [true, false, true, "power_cut"], "the state object reports the cut as a cut");
    assert.deepEqual(s.trigger, AFTER, "the state names the trigger that was armed");
    assert.equal(boot().faultState().trigger, null, "and none when none was");
    const [[lo, hi]] = rec.ranges;
    assert.equal(rec.before.length, hi - lo + 1);
    assert.deepEqual(Array.from(m.flash().subarray(lo, hi + 1)), Array.from(rec.before), "the array holds the pre-image as a placeholder, not an outcome");
    const k = m.peekKnown(lo - 4, 12);
    assert.deepEqual(Array.from(k.unknown), [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1], "the cut range is marked unknown, its neighbours are known");
    assert.deepEqual(Array.from(k.bytes.subarray(4)), new Array(8).fill(0), "unknown bytes read as a 0 placeholder, not a claim");
    assert.throws(() => m.peekKnown(0, (1 << 20) + 1), RangeError);
  });

  T("deterministic replay: the same scenario gives a byte-identical report; a different trigger differs; seeded outcomes reproduce", () => {
    const cfg = { fault: AFTER, policy: { kind: "random", seed: 7 }, rebootMs: 1500, maxMs: 3000 };
    const a = runFaultScenario(chipEngine, quadro, cfg), b = runFaultScenario(chipEngine, quadro, cfg);
    assert.deepEqual(a, b);
    assert.equal(a.reportSha256, b.reportSha256);
    assert.equal(a.stop.outcome, "power-cut");
    const later = runFaultScenario(chipEngine, quadro, { ...cfg, fault: { op: "any", nth: 1, at: { afterCycles: 9000 } }, rebootMs: 0, policy: null });
    assert.notEqual(later.record.requestedCutCycle, a.record.requestedCutCycle);
    assert.equal(later.record.acceptedAtCycle, a.record.acceptedAtCycle, "the same cycle was accepted: only the cut time moved");
    assert.deepEqual(JSON.parse(JSON.stringify(a)), a, "plain JSON");
    // the hash with the unknown bytes masked is what peekKnown says (not the raw array, whose cut range holds the placeholder)
    const m = boot({ fault: AFTER });
    m.runUntilCut(3000);
    const known = m.peekKnown(0, 1 << 20).bytes;
    assert.equal(a.flash.knownHashAtStop, createHash("sha256").update(known).digest("hex").slice(0, 16));
    assert.notEqual(a.flash.knownHashAtStop, a.flash.hashAtStop, "masking changes the hash: the placeholder bytes are not zero");
  });

  T("a scenario's reboot report keeps the list carried in apart from the list at the end of the run", () => {
    const r = runFaultScenario(chipEngine, quadro, { fault: AFTER, policy: { kind: "ff" }, rebootMs: 3000 });
    assert.deepEqual(r.reboot.indeterminateCarriedIn, r.indeterminate, "what the reboot started with");
    assert.ok(r.reboot.indeterminateCarriedIn.length > 0);
    assert.deepEqual(r.reboot.indeterminateAtEnd, [], "the firmware completed an erase over the unknown bytes, which made them known again");
    assert.ok(r.reboot.indeterminateReads >= 1);
  });

  T("a cut over bytes that hold data: `old`, `new` and `ff` reboot into three different flashes, each exactly what the named policy says; the engine's record carries both bounds", () => {
    const FILL = { old: (b) => b.before, new: (b) => b.ifCompleted, ff: (b) => b.before.map(() => 0xff) };
    for (const kind of ["old", "new", "ff"]) {
      const c = LiveChip.boot(chipEngine, pkg, { flashChip: "puya" }).fill("pat");
      const m = c.m;
      assert.equal(m.armFault({ op: "program", nth: 1, at: { atAccept: true } }) !== null, true);
      c.wren(); c.tx([0x02, ...a3(0x1000), 0x0f, 0xf0, 0x55, 0xaa]);
      const rec = m.faultState().record;
      assert.deepEqual(Array.from(rec.before), [pat(0x1000), pat(0x1001), pat(0x1002), pat(0x1003)], "before: the data that was there");
      assert.deepEqual(Array.from(rec.ifCompleted), [pat(0x1000) & 0x0f, pat(0x1001) & 0xf0, pat(0x1002) & 0x55, pat(0x1003) & 0xaa], "if completed: old AND data");
      const next = m.powerCycle({ outcome: { kind } });
      const got = Array.from(next.flash().subarray(0x1000, 0x1004));
      assert.deepEqual(got, Array.from(FILL[kind](rec)), `${kind}: exactly the named fill`);
      assert.deepEqual(next.indeterminateRanges(), [[0x1000, 0x1003]], "and the bytes stay unknown whatever the fill");
      assert.deepEqual(Array.from(next.flash().subarray(0x1004, 0x1008)), [pat(0x1004), pat(0x1005), pat(0x1006), pat(0x1007)], "nothing beside the range was touched");
    }
  });

  T("after a bulk clock move the actual firing cycle is later than the requested one, and the record says so", () => {
    const c = LiveChip.boot(chipEngine, pkg, { flashChip: "puya" }).fill("pat");
    const m = c.m;
    m.armFault({ op: "program", nth: 1, at: { afterCycles: 20_000 } });
    c.wren(); c.tx([0x02, ...a3(0x1000), 0x12]);
    c.advance(10_000);                                                       // 10 ms in one jump, far past the cycle's end
    const rec = m.faultState().record;
    assert.equal(rec.requestedCutCycle, rec.acceptedAtCycle + 20_000);
    assert.ok(rec.actualCutCycle > rec.requestedCutCycle, "noticed at the end of the jump");
    assert.equal(rec.actualCutCycle, m.cycles(), "at the cycle the clock had reached");
    assert.equal(m.faultState().completed, 0, "the cycle never completed");
  });

  T("a scenario over a program cycle: the record's images are the erased pre-image and the data, not each other", () => {
    const r = runFaultScenario(chipEngine, quadro, { fault: { op: "program", nth: 1, at: { atAccept: true } }, maxMs: 3000 });
    assert.equal(r.stop.outcome, "power-cut");
    assert.ok(r.record.bytesAtRisk <= 256 && r.record.images.beforeHex !== undefined);
    assert.match(r.record.images.beforeHex, /^(ff)+$/, "a program lands on erased flash");
    assert.notEqual(r.record.images.beforeHex, r.record.images.ifCompletedHex, "what a normal completion would have produced differs from what was there");
    assert.notEqual(r.record.images.before, r.record.images.ifCompleted);
  });

  T("policy separation: the engine's record is identical whatever the outcome policy; only the explicit synthetic outcome (and what the firmware does with it) differs, and it is labelled", () => {
    const base = { fault: { op: "any", nth: 1, at: { afterCycles: 5000 } }, rebootMs: 600, maxMs: 3000 };
    const reports = Object.fromEntries(["old", "new", "ff", "zero", "prefix"].map((kind) => [kind, runFaultScenario(chipEngine, quadro, { ...base, policy: kind === "prefix" ? { kind, fraction: 0.5 } : { kind } })]));
    reports.rand1 = runFaultScenario(chipEngine, quadro, { ...base, policy: { kind: "random", seed: 1 } });
    reports.rand2 = runFaultScenario(chipEngine, quadro, { ...base, policy: { kind: "random", seed: 2 } });
    const first = reports.old;
    for (const [name, r] of Object.entries(reports)) {
      assert.deepEqual(r.record, first.record, `${name}: the engine's record does not depend on the policy`);
      assert.deepEqual(r.indeterminate, first.indeterminate, name);
      assert.equal(r.flash.hashAtStop, first.flash.hashAtStop, `${name}: nor does the flash at the stop`);
      assert.equal(r.reboot.synthetic, true, name);
      assert.match(r.reboot.outcome.provenance.disclaimer, /not a prediction of the physical chip/, name);
      assert.match(r.disclaimer, /does not exhaust/, name);
      assert.deepEqual(r.reboot.policy, r.config.policy);
      assert.deepEqual(r.reboot.indeterminateCarriedIn, first.indeterminate, `${name}: a fill does not make the bytes known: the list is carried unchanged`);
    }
    assert.notEqual(reports.rand1.reboot.outcome.hash, reports.rand2.reboot.outcome.hash, "the seed matters");
    assert.equal(reports.old.reboot.outcome.bytes, first.record.bytesAtRisk);
    // the engine never computed a fill: its images are policy inputs and equal across runs (checked above); `old` and `new` are the two bounds and equal here (a blank sector erased)
    assert.equal(reports.old.reboot.outcome.hash, reports.new.reboot.outcome.hash);
  });

  T("a power-cut machine cannot continue executing firmware, however it is poked", () => {
    const m = boot({ fault: AFTER });
    m.runUntilCut(3000);
    const before = snapshot(m);
    m.run(5000);
    for (let i = 0; i < 20; i++) m.x.fm1_render(128, 4_000_000);          // even a harness that calls the engine directly
    m.key(3, true); m.midi([0x90, 60, 100]); m.pot(1000); m.encoder(0, 5);
    m.run(2000);
    const w = watch(m, { seconds: 2 });
    assert.equal(w.verdict, "power-cut");
    assert.deepEqual(snapshot(m), before, "no cycle, instruction, flash change, picture or audio frame after the cut");
    assert.equal(m.x.fm1_halted(), 0, "and it did not become a crash either");
    assert.throws(() => m.armFault(AFTER), CODE("use-restore"), "a powered-off chip cannot be armed");
    assert.throws(() => m.cutPower(), CODE("already-off"));
    m.restoreChip();                                                         // power returns to the CHIP only
    assert.equal(m.powerCut, true, "the machine stays terminal");
    m.run(2000);
    assert.deepEqual(snapshot(m), before, "restoring the chip does not restart the machine");
    assert.throws(() => m.powerCycle(), CODE("outcome-required"));
    assert.deepEqual(snapshot(m), before);
  });

  T("a reboot after a cut takes an explicit outcome, carries the indeterminate list, counts reads of it and runs the firmware again", () => {
    const m = boot({ fault: AFTER });
    m.runUntilCut(3000);
    const ranges = m.indeterminateRanges(), record = m.faultState().record;
    const next = m.powerCycle({ outcome: { kind: "ff" } });
    assert.equal(next.status, "running", "a new machine");
    assert.equal(m.status, "power_cut", "the old one stays what it was");
    assert.deepEqual(next.indeterminateRanges(), ranges, "carried into the reboot before the first instruction");
    assert.equal(next.faultOutcome.provenance.synthetic, true);
    assert.deepEqual(next.faultOutcome.provenance.policy, { kind: "ff" });
    const [[lo, hi]] = ranges;
    // the new flash holds the explicit fill there (and the engine's list still calls those bytes unknown)
    assert.ok(next.flash().subarray(lo, hi + 1).every((b) => b === 0xff));
    const k = next.peekKnown(lo, 1);
    assert.equal(k.unknown[0], 1);
    next.run(3000);
    assert.equal(next.halted, false);
    assert.ok(next.faultState().reads >= 1, "the firmware read bytes the cut left unknown, and the engine counted it");
    // a power cycle with no cut carries the list on (until a complete erase clears it) and refuses an outcome
    assert.throws(() => next.powerCycle({ outcome: { kind: "ff" } }), CODE("outcome-without-cut"));
    // the trigger is NOT re-armed by a power cycle
    assert.equal(next.faultInfo, null);
    assert.equal(next.faultState().armed, false);
    // a different chip swapped in while off has no unknown bytes
    const swapped = m.powerCycle({ outcome: { kind: "zero" }, flashChip: "uc25hq80" });
    assert.deepEqual(swapped.indeterminateRanges(), [], "a different physical chip starts with none");
    // the outcome really is what the policy module says it is (the harness adds nothing)
    const expected = materialize({ fired: true, op: record.op, cutAt: record.requestedCutCycle, profile: "puya", timing: "typical", ranges: record.ranges, before: record.before, unknownBefore: record.unknownBefore, ifCompleted: record.ifCompleted, unknownIfCompleted: record.unknownIfCompleted }, { kind: "ff" });
    assert.deepEqual(Array.from(next.faultOutcome.bytes), Array.from(expected.bytes));
  });

  T("a harness-initiated cut: journal first, then cutPower() returns the record; refusals are distinct", () => {
    const c = LiveChip.boot(chipEngine, pkg, { flashChip: "puya" }).fill("pat");
    const m = c.m;
    assert.throws(() => m.cutPower(), CODE("no-cycle"));
    c.wren(); c.tx([0x02, ...a3(0x1000), 0x12]);
    assert.throws(() => m.cutPower(), CODE("not-enabled"), "accepted before the journal was on: refused, never faked");
    c.settle();
    m.enableFaultJournal();
    c.wren(); c.tx([0x02, ...a3(0x2000), 0x12, 0x34]);
    const t = m.cycles();
    c.advance(100);
    const rec = m.cutPower();
    assert.deepEqual([rec.source, rec.op, rec.nth, rec.ranges], ["harness", "program", null, [[0x2000, 0x2001]]]);
    assert.equal(rec.requestedCutCycle, t + 100 * 100);
    assert.deepEqual([m.status, m.halted], ["power_cut", false]);
    assert.deepEqual(Array.from(m.flash().subarray(0x2000, 0x2002)), [pat(0x2000), pat(0x2001)], "placeholder = pre-image");
  });

  T("disabled means untouched: the shipped engine's observation shape is unchanged, and a chip engine without fault options behaves as before", () => {
    const keysShipped = Object.keys(Fm1Machine.boot(shipped, pkg, { usb: false }).observe());
    assert.ok(!keysShipped.includes("powerCut"), "no new key on the shipped engine");
    assert.throws(() => Fm1Machine.boot(shipped, pkg, { usb: false }).faultState(), CODE("unsupported-engine"));
    assert.throws(() => Fm1Machine.boot(shipped, pkg, { usb: false, flashChip: "puya", fault: AFTER }), /flash chip|fault/);
    const plain = boot(), withNull = boot({ fault: null, faultJournal: false, faultIndeterminate: null });
    plain.run(1500); withNull.run(1500);
    assert.deepEqual(snapshot(plain), snapshot(withNull), "explicit nulls are the same as nothing");
    assert.equal(plain.observe().powerCut, false);
    const w = watch(boot(), { seconds: 1 });
    assert.equal(w.verdict, "booted");
    assert.equal(w.powerCutAtMs, undefined, "no new field on a normal report");
    assert.equal(plain.faultState().fired, 0);
    // legacy model: the options are refused, not silently ignored
    assert.throws(() => Fm1Machine.boot(chipEngine, pkg, { usb: false, fault: AFTER }), CODE("needs-chip"));
  });
}
