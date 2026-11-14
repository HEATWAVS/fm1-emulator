// Tests for the fault-injection extension of the flash-chip reference model (Component 5, Stage 5B): interruption, affected range, indeterminate state, power state,
// the separate synthetic outcome policies, determinism, cut precedence and "disabled means unchanged". JavaScript only; milliseconds; no engine.
// Cycle durations come from chiptests.mjs TIMING, which is typed from the datasheets (Puya Table 5-4 p11, UC25HQ80 Table-18 p53), not from the spec.
//
// What these tests do NOT claim: that any fill is what a physical chip would hold. The datasheets do not say (FAULT-INJECTION.md section 2).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { ChipModel, ManualClock, FaultError, PoweredOff, NotModeled, UnspecifiedBehavior, FAULT_OPS } from "./chipmodel.mjs";
import { FILLS, DISCLAIMER, FaultPolicyError, materialize, applyToImage, validatePolicy, mulberry32, standardSweep, describeOutcome } from "./faultpolicy.mjs";

const BYTES = 1 << 20;
const PATTERN = (() => { const a = new Uint8Array(BYTES); for (let i = 0; i < BYTES; i++) a[i] = ((i * 131 + (i >> 8) * 17) ^ 0x5a) & 0xff; return a; })();
const pat = () => Uint8Array.from(PATTERN);
const a3 = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const S = { WEL: 0x2, WIP: 0x1 };

// One command per in-scope kind, with the datasheet key of its duration and the range it puts at risk (a unit: the whole erase unit; a program: the latched bytes).
const KINDS = {
  program: { key: "pp", tx: [0x02, ...a3(0x12010), 0x11, 0x22, 0x33], range: [[0x12010, 0x12012]] },
  erase4k: { key: "se", tx: [0x20, ...a3(0x24567)], range: [[0x24000, 0x24fff]] },
  erase32k: { key: "be32", tx: [0x52, ...a3(0x58123)], range: [[0x58000, 0x5ffff]] },
  erase64k: { key: "be64", tx: [0xd8, ...a3(0xa1234)], range: [[0xa0000, 0xaffff]] },
  "chip-erase": { key: "ce", tx: [0x60], range: [[0, BYTES - 1]] },
};
const AT = (dur) => [
  [{ atAccept: true }, 0], [{ fraction: 0 }, 0], [{ fraction: 0.25 }, Math.floor(0.25 * dur)], [{ fraction: 0.5 }, Math.floor(0.5 * dur)],
  [{ fraction: 0.99 }, Math.floor(0.99 * dur)], [{ fraction: 1 / 3 }, Math.floor(dur / 3)], [{ fraction: 0.999 }, Math.floor(0.999 * dur)],   // (1/3 and 0.999 are not whole microseconds: the floor is observable)
  [{ afterUs: 1 }, 1], [{ afterUs: dur - 1 }, dur - 1],
];
const idThrows = (fn, Cls, id) => assert.throws(fn, (e) => e instanceof Cls && e.id === id, `expected ${Cls.name} ${id}`);

export function registerFaultTests({ test, T, both, mk, TIMING }) {
  const dur = (p, timing, kind) => TIMING[p][timing][KINDS[kind].key];
  const setup = (p, { timing = "typical", fault = null, image = PATTERN, opts = {} } = {}) => {      // (ChipModel copies the image: PATTERN is never modified)
    const m = mk(p, { timing, image, ...opts });
    if (fault) m.chip.armFault(fault);
    return m;
  };
  /** accept `kind` (WREN + command); returns the context with start/end of the cycle */
  const accept = (m, kind) => { m.wren(); m.chip.transact(KINDS[kind].tx); const start = m.clock.now(); return { start }; };

  // ---------------------------------------------------------------- arming: interface refusals
  both(["fault.out-of-scope"], "armFault refuses bad triggers, a policy, out-of-scope kinds, a second arming and any cut that would be a normal completion", (p) => {
    const { chip } = mk(p);
    for (const op of ["wrsr", "erase-page", "81h", "suspend", "reset", "brown-out"]) idThrows(() => chip.armFault({ op, at: { atAccept: true } }), FaultError, "fault.out-of-scope");
    for (const op of ["bogus", undefined, null, 5, "PROGRAM"]) idThrows(() => chip.armFault({ op, at: { atAccept: true } }), FaultError, "fault.bad-op");
    for (const nth of [0, -1, 1.5, "1", NaN, null]) idThrows(() => chip.armFault({ op: "program", nth, at: { atAccept: true } }), FaultError, "fault.bad-nth");
    const minPp = TIMING[p].typical.pp;
    for (const at of [undefined, null, {}, 5, { atAccept: false }, { atAccept: 1 }, { fraction: 1 }, { fraction: 1.5 }, { fraction: -0.1 }, { fraction: NaN }, { fraction: "0.5" },
      { afterUs: -1 }, { afterUs: 1.5 }, { afterUs: minPp }, { afterUs: minPp + 1 }, { afterUs: "5" }, { atAccept: true, fraction: 0.5 }, { fraction: 0.5, afterUs: 1 }]) {
      idThrows(() => chip.armFault({ op: "program", at }), FaultError, "fault.bad-at");
    }
    for (const extra of [{ policy: { kind: "old" } }, { fill: "old" }, { seed: 1 }]) idThrows(() => chip.armFault({ op: "program", at: { atAccept: true }, ...extra }), FaultError, "fault.policy-not-here");
    for (const spec of [null, 5, "program"]) idThrows(() => chip.armFault(spec), FaultError, "fault.bad-spec");
    chip.armFault({ op: "program", at: { afterUs: minPp - 1 } });                      // the largest allowed offset is one microsecond before the end
    idThrows(() => chip.armFault({ op: "program", at: { atAccept: true } }), FaultError, "fault.already-armed");
    chip.disarmFault();
    chip.armFault({ op: "any", at: { atAccept: true } });                             // after disarming it can be armed again
    assert.deepEqual(FAULT_OPS, ["program", "erase4k", "erase32k", "erase64k", "erase", "chip-erase", "any"]);
    // afterUs is bounded by the SHORTEST cycle a selector can match
    const m2 = mk(p);
    idThrows(() => m2.chip.armFault({ op: "any", at: { afterUs: minPp } }), FaultError, "fault.bad-at");
    m2.chip.armFault({ op: "erase", at: { afterUs: TIMING[p].typical.se - 1 } });
  });

  // ---------------------------------------------------------------- firing at the scheduled instant, not before
  for (const timing of ["typical", "maximum"]) {
    both(["fault.range", "fault.cut-contents"], `the cut fires at exactly the scheduled instant and not before (${timing}): every kind, every trigger form`, (p) => {
      for (const kind of Object.keys(KINDS)) {
        const d = dur(p, timing, kind);
        for (const [at, offset] of AT(d)) {
          const m = setup(p, { timing, fault: { op: kind, at } }), { start } = accept(m, kind), where = `${kind} ${JSON.stringify(at)}`;
          if (offset > 0) {                                              // (a cut at the accept instant fires on the first observation, so there is no "before")
            assert.equal(m.chip.faultState().last, null, `${where}: nothing fired before the cut instant`);
            assert.equal(m.chip.faultState().armed.scheduled, true, where);
            m.clock.advance(offset - 1);
            assert.equal(m.chip.busyUntil(), start + d, `${where}: one microsecond before the cut the cycle is still in flight`);
            assert.equal(m.chip.faultState().last, null, where);
            m.clock.advance(1);
          }
          assert.equal(m.chip.busyUntil(), null, `${where}: at the cut instant the cycle is gone`);
          const r = m.chip.faultState().last;
          assert.ok(r && r.fired === true, where);
          assert.deepEqual([r.source, r.op, r.nth, r.ordinal, r.startedAt, r.cutAt, r.endWouldBeAt, r.detectedAt, r.wipAtCut, r.profile, r.timing],
            ["scheduled", kind, 1, 1, start, start + offset, start + d, start + offset, true, p, timing], where);
          assert.ok(r.cutAt < r.endWouldBeAt, `${where}: the cut is strictly before the end`);
          assert.deepEqual(r.ranges, KINDS[kind].range, `${where}: the range at risk`);
          assert.equal(m.chip.faultState().poweredOff, true, where);
          assert.deepEqual(m.chip.faultState().ops, { accepted: 1, completed: 0, interrupted: 1 }, where);
        }
      }
    });
  }

  // ---------------------------------------------------------------- precedence: cut before completion, however late the chip is next touched
  for (const timing of ["typical", "maximum"]) {
    both(["fault.cut-contents"], `CUT PRECEDENCE (${timing}): a cut whose time has passed is never observed as a normal completion, however late the chip is touched`, (p) => {
      for (const kind of Object.keys(KINDS)) {
        const d = dur(p, timing, kind);
        // CONTROL (once per kind): the identical scenario with no fault armed completes normally, so the interruption below is the fault's doing and not a property of waiting
        { const c = setup(p, { timing }); accept(c, kind); c.clock.advance(d + 5000);
          assert.equal(c.chip.busyUntil(), null);
          assert.deepEqual(c.chip.faultState().ops, { accepted: 1, completed: 1, interrupted: 0 }, `${kind}: control completes`);
          assert.equal(c.chip.faultState().poweredOff, false); }
        for (const [at, offset] of AT(d)) {
          const where = `${kind} ${JSON.stringify(at)}`;
          // the clock jumps far past the END of the cycle with NO chip access in between
          const m = setup(p, { timing, fault: { op: kind, at } }), { start } = accept(m, kind);
          m.clock.advance(d + 5000);
          assert.throws(() => m.chip.readStatus(), PoweredOff, `${where}: the first access after the end finds the chip cut, not completed`);
          const r = m.chip.faultState().last;
          assert.deepEqual([r.cutAt, r.endWouldBeAt, r.detectedAt, r.source], [start + offset, start + d, start + d + 5000, "scheduled"], where);
          assert.deepEqual(m.chip.faultState().ops, { accepted: 1, completed: 0, interrupted: 1 }, `${where}: it was never counted as completed`);
          m.chip.powerRestore();
          m.clock.advance(1e7);
          const k = m.chip.peekKnown(KINDS[kind].range[0][0], Math.min(KINDS[kind].range[0][1] - KINDS[kind].range[0][0] + 1, 64));
          assert.ok(k.unknown.every((u) => u === 1), `${where}: the range is still indeterminate long after the would-be end: the cycle never completes`);
          assert.equal(m.chip.faultState().ops.completed, 0, where);
        }
      }
    });
    both(["fault.cut-contents"], `CUT PRECEDENCE (${timing}): the latest allowed cut (1 us before the end) beats a first access at exactly the end`, (p) => {
      for (const kind of Object.keys(KINDS)) {
        const d = dur(p, timing, kind), m = setup(p, { timing, fault: { op: kind, at: { afterUs: d - 1 } } }), { start } = accept(m, kind);
        m.clock.advance(d);                                              // now == end exactly
        assert.throws(() => m.chip.readStatus(), PoweredOff, `${kind}: interrupted, not completed, although now == end`);
        const r = m.chip.faultState().last;
        assert.deepEqual([r.cutAt, r.endWouldBeAt, r.detectedAt], [start + d - 1, start + d, start + d], kind);
        assert.equal(m.chip.faultState().ops.completed, 0, kind);
      }
    });
  }

  // ---------------------------------------------------------------- trigger selection
  both(["fault.out-of-scope"], "nth counts only ACCEPTED cycles of the matching kind: ignored commands and other kinds do not count; excluded kinds are never cut", (p) => {
    const m = setup(p, { fault: { op: "program", nth: 2, at: { fraction: 0.5 } } });
    m.chip.transact([0x02, ...a3(0x1000), 0x00]);                                       // no WREN: not accepted, not counted
    m.wren(); m.chip.transact([0x20, ...a3(0x3000)]); m.finish();                        // a sector erase: a different kind, not counted
    m.wren(); m.chip.transact([0x81, ...a3(0x5000)]); m.finish();                        // page erase 81h: out of scope, never matched, completes normally
    m.wren(); m.chip.transact([0x01, 0x04, 0x00]); m.finish();                           // WRSR: out of scope, completes normally
    m.wren(); m.chip.transact([0x02, ...a3(0x2000), 0x0f]); m.finish();                  // the 1st accepted program: completes normally
    assert.equal(m.chip.faultState().last, null);
    assert.equal(m.chip.faultState().armed.seen, 1);
    assert.equal(m.chip.peek(0x2000)[0], PATTERN[0x2000] & 0x0f, "program #1 completed normally");
    assert.equal(m.chip.peek(0x3000)[0], 0xff, "the erase completed normally");
    m.wren(); m.chip.transact([0x02, ...a3(0x4000), 0x0f]);                              // the 2nd accepted program: scheduled
    assert.equal(m.chip.faultState().armed.scheduled, true);
    m.clock.advance(TIMING[p].typical.pp);                                               // well past the cut
    assert.throws(() => m.chip.readStatus(), PoweredOff);
    assert.equal(m.chip.faultState().last.nth, 2);
    assert.equal(m.chip.faultState().last.ordinal, 5, "the 5th accepted cycle overall: sector erase, 81h, WRSR, program, then this program");
    assert.deepEqual(m.chip.faultState().ops, { accepted: 5, completed: 4, interrupted: 1 });
    // selectors: erase = 4k/32k/64k (not chip erase, not program); erase4k is exact; any = every in-scope kind; excluded kinds never match even for any
    const e = setup(p, { fault: { op: "erase", at: { atAccept: true } } });
    e.wren(); e.chip.transact([0x02, ...a3(0x1000), 0x0f]); e.finish(); e.wren(); e.chip.transact([0x60]); e.finish();   // program and chip erase do not match "erase"
    assert.equal(e.chip.faultState().last, null);
    e.chip.disarmFault(); e.chip.armFault({ op: "erase4k", at: { atAccept: true } });
    e.wren(); e.chip.transact([0x52, ...a3(0x40000)]); e.finish();                      // 32 KiB does not match erase4k
    assert.equal(e.chip.faultState().last, null);
    const a = setup(p, { fault: { op: "any", at: { atAccept: true } } });
    a.wren(); a.chip.transact([0x81, ...a3(0x100)]); a.finish(); a.wren(); a.chip.transact([0x01, 0, 0]); a.finish();
    assert.equal(a.chip.faultState().last, null, "81h and WRSR never match, even for any");
    a.wren(); a.chip.transact([0xd8, ...a3(0x10000)]);
    assert.equal(a.chip.busyUntil(), null);
    assert.equal(a.chip.faultState().last.op, "erase64k");
  });

  // ---------------------------------------------------------------- ranges; neighbours; unknown tracked apart from known
  both(["fault.range", "fault.neighbours", "fault.cut-contents"], "the indeterminate range is exactly the cycle's own bytes; every neighbour is known and unchanged; the array itself is never overwritten with a guess", (p) => {
    for (const kind of Object.keys(KINDS)) {
      const m = setup(p, { fault: { op: kind, at: { fraction: 0.5 } } }), before = pat();
      accept(m, kind); m.clock.advance(dur(p, "typical", kind));
      assert.throws(() => m.chip.readStatus(), PoweredOff);
      m.chip.powerRestore();
      const st = m.chip.faultState(), [[lo, hi]] = KINDS[kind].range;
      assert.deepEqual(st.indeterminate, KINDS[kind].range, kind);
      assert.equal(st.indeterminateBytes, hi - lo + 1, kind);
      if (kind !== "chip-erase") {
        for (const a of [lo - 1, hi + 1, lo - 4096 >= 0 ? lo - 4096 : lo - 1, hi + 4096 <= BYTES - 1 ? hi + 4096 : hi + 1]) {
          const k = m.chip.peekKnown(a, 1);
          assert.deepEqual([k.bytes[0], k.unknown[0]], [before[a], 0], `${kind}: neighbour ${a.toString(16)} untouched and known`);
        }
        assert.equal(m.chip.peek(lo - 1, 1)[0], before[lo - 1], "peek works outside the range");
      }
      assert.throws(() => m.chip.peek(lo, 1), (e) => e instanceof UnspecifiedBehavior && e.id === "fault.cut-contents", `${kind}: peek refuses indeterminate bytes`);
      const k = m.chip.peekKnown(lo, Math.min(hi - lo + 1, 4096));
      assert.ok(k.unknown.every((u) => u === 1) && k.bytes.every((b) => b === 0), `${kind}: unknown bytes carry a 0 placeholder, never a value`);
    }
  });
  both(["fault.range"], "a page program puts only its latched bytes at risk (wrapped runs, repeated positions, more than 256 bytes), not the rest of the page", (p) => {
    const m = setup(p, { fault: { op: "program", at: { atAccept: true } } }), page = 0x31000;
    m.wren(); m.chip.transact([0x02, ...a3(page + 0xfe), 1, 2, 3, 4, 5, 6]);            // positions FE FF 00 01 02 03
    assert.throws(() => m.chip.readStatus(), PoweredOff);
    assert.deepEqual(m.chip.faultState().last.ranges, [[page, page + 3], [page + 0xfe, page + 0xff]]);
    const m2 = setup(p, { fault: { op: "program", at: { atAccept: true } } });
    m2.wren(); m2.chip.transact([0x02, ...a3(0x40010), ...Array.from({ length: 300 }, (_, i) => i & 0xff)]);   // 300 bytes: every position is latched (last 256 win)
    assert.throws(() => m2.chip.readStatus(), PoweredOff);
    assert.deepEqual(m2.chip.faultState().last.ranges, [[0x40000, 0x400ff]]);
    const m3 = setup(p, { fault: { op: "program", at: { atAccept: true } } });
    m3.wren(); m3.chip.transact([0x02, ...a3(0x50000 + 0x80), 9]);                       // one byte
    assert.throws(() => m3.chip.readStatus(), PoweredOff);
    assert.deepEqual(m3.chip.faultState().last.ranges, [[0x50080, 0x50080]]);
    m3.chip.powerRestore();
    assert.deepEqual(m3.chip.peekKnown(0x5007f, 3).unknown, Uint8Array.from([0, 1, 0]), "only the one latched byte is indeterminate");
  });
  both(["fault.cut-contents", "fault.program-over-indeterminate", "fault.erase-clears"], "reads see indeterminate bytes as UNKNOWN (mask FF, counted), never as a value; a program over them stays unknown; an erase that covers them makes them known 0xFF", (p) => {
    const m = setup(p, { fault: { op: "erase32k", at: { fraction: 0.5 } } }), lo = 0x58000, hi = 0x5ffff, before = pat();
    accept(m, "erase32k"); m.clock.advance(dur(p, "typical", "erase32k"));
    assert.throws(() => m.chip.readStatus(), PoweredOff); m.chip.powerRestore();
    assert.equal(m.chip.faultState().indeterminateReads, 0);
    let r = m.chip.transact([0x03, ...a3(lo - 2)], { read: 4 });
    assert.deepEqual([...r.out], [before[lo - 2], before[lo - 1], 0, 0]); assert.deepEqual([...r.unknown], [0, 0, 0xff, 0xff]);
    assert.equal(m.chip.faultState().indeterminateReads, 1, "one read transaction touched indeterminate bytes");
    r = m.chip.transact([0x0b, ...a3(hi - 1), 0], { read: 4 });
    assert.deepEqual([...r.out], [0, 0, before[hi + 1], before[hi + 2]]); assert.deepEqual([...r.unknown], [0xff, 0xff, 0, 0]);
    assert.equal(m.chip.faultState().indeterminateReads, 2);
    m.chip.transact([0x03, ...a3(0x1000)], { read: 8 });
    assert.equal(m.chip.faultState().indeterminateReads, 2, "a read that touches none is not counted");
    // a program over indeterminate bytes: they stay unknown (the result depends on contents nobody knows)
    m.wren(); m.chip.transact([0x02, ...a3(lo + 5), 0x00, 0x00]); m.finish();
    assert.deepEqual([...m.chip.peekKnown(lo + 4, 4).unknown], [1, 1, 1, 1]);
    assert.equal(m.chip.faultState().indeterminateBytes, hi - lo + 1);
    // a 4 KiB erase inside the range clears only that unit
    m.wren(); m.chip.transact([0x20, ...a3(lo + 0x1000)]); m.finish();
    assert.deepEqual(m.chip.faultState().indeterminate, [[lo, lo + 0xfff], [lo + 0x2000, hi]]);
    const k = m.chip.peekKnown(lo + 0x1000, 8); assert.deepEqual([[...k.bytes], [...k.unknown]], [new Array(8).fill(0xff), new Array(8).fill(0)]);
    // a 64 KiB erase covering the rest clears everything
    m.wren(); m.chip.transact([0xd8, ...a3(0x50000)]); m.finish();
    assert.deepEqual(m.chip.faultState().indeterminate, []);
    assert.equal(m.chip.peek(lo, 1)[0], 0xff);
    // chip erase clears all
    const c = setup(p, { fault: { op: "erase4k", at: { atAccept: true } } });
    c.wren(); c.chip.transact([0x20, ...a3(0x9000)]);
    assert.throws(() => c.chip.readStatus(), PoweredOff); c.chip.powerRestore();
    c.wren(); c.chip.transact([0x60]); c.finish();
    assert.deepEqual(c.chip.faultState().indeterminate, []);
  });

  // ---------------------------------------------------------------- power state: off, restore
  both(["fault.powerup-standby", "fault.status-after-restore", "fault.wel-sus-cleared", "fault.nv-retained"], "after a cut the chip answers nothing until powerRestore(); power returns in standby: WEL 0, WIP 0, non-volatile bits kept, SRP 1:0 back to 0:0, the cycle never resumes", (p) => {
    const m = setup(p, { opts: { uid: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] } });
    m.wren(); m.chip.transact([0x01, 0x14 | 0x80, 0x42]); m.finish();                    // BP0 BP2 + SRP0, CMP + QE: non-volatile bits to keep
    const before = m.st().value;
    assert.equal(before, 0x4294, "BP2 BP0 SRP0 = 0x94, QE 0x200 + CMP 0x4000");
    m.chip.armFault({ op: "program", at: { fraction: 0.5 } });
    // CMP=1 with BP=00101 protects nothing (printed table), so a program is accepted
    m.wren(); m.chip.transact([0x02, ...a3(0x777), 0x0f]);
    assert.equal(m.st().value & S.WIP, S.WIP, "in flight before the cut");
    m.clock.advance(TIMING[p].typical.pp);
    assert.throws(() => m.chip.transact([0x05], { read: 1 }), PoweredOff, "off");
    assert.throws(() => m.chip.transact([0x9f], { read: 3 }), PoweredOff);
    assert.throws(() => m.chip.peek(0, 1), PoweredOff);
    idThrows(() => m.chip.powerCycle(), FaultError, "fault.use-restore");
    idThrows(() => m.chip.armFault({ op: "program", at: { atAccept: true } }), FaultError, "fault.use-restore");
    m.chip.powerRestore();
    idThrows(() => m.chip.powerRestore(), FaultError, "fault.not-off");
    assert.equal(m.st().value, before & ~S.WEL & ~S.WIP, "WEL and WIP are 0; BP, SRP0, QE, CMP are retained exactly");
    m.clock.advance(1e7);
    assert.equal(m.st().value & (S.WIP | S.WEL), 0, "the interrupted cycle did not resume");
    assert.equal(m.chip.faultState().ops.completed, 1, "only the earlier WRSR completed");
    assert.deepEqual([...m.chip.transact([0x4b, 0, 0, 0, 0], { read: 16 }).out], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], "the factory ID is untouched by the cut");
    // ordinary operation resumes with ordinary timing
    m.wren(); m.chip.transact([0x02, ...a3(0x2000), 0x00]);
    assert.equal(m.chip.busyUntil(), m.clock.now() + TIMING[p].typical.pp);
    m.finish();
    assert.equal(m.chip.peek(0x2000)[0], PATTERN[0x2000] & 0, "a later program completes normally");
    // lock-down SRP1:SRP0 = 1:0 returns to 0:0 at power-up
    const l = setup(p);
    l.wren(); l.chip.transact([0x01, 0x00, 0x01]); l.finish();
    assert.equal(l.st().value, 0x0100, "SRP1 alone: lock-down");
    l.chip.armFault({ op: "erase4k", at: { atAccept: true } });
    l.wren(); l.chip.transact([0x20, ...a3(0x1000)]);
    assert.throws(() => l.chip.readStatus(), PoweredOff); l.chip.powerRestore();
    assert.equal(l.st().value, 0, "lock-down returned to 0:0");
  });
  both(["fault.out-of-scope"], "powerCut(): harness-initiated at the present chip time; refused (never silently completed) with no cycle, after completion, or for out-of-scope kinds", (p) => {
    const m = setup(p, { fault: { op: "program", nth: 99, at: { atAccept: true } } });          // armed but not due: powerCut is independent of it
    idThrows(() => m.chip.powerCut(), FaultError, "fault.no-cycle");
    m.wren(); m.chip.transact([0x02, ...a3(0x1000), 0x0f]);
    m.clock.advance(300);
    const start = m.clock.now() - 300, r = m.chip.powerCut();
    assert.deepEqual([r.source, r.op, r.cutAt, r.startedAt, r.endWouldBeAt, r.nth], ["harness", "program", start + 300, start, start + TIMING[p].typical.pp, null]);
    assert.equal(m.chip.faultState().poweredOff, true);
    idThrows(() => m.chip.powerCut(), FaultError, "fault.already-off");
    m.chip.powerRestore();
    // a cut at the very instant of completion finds nothing in flight: the cycle completed, there is nothing to cut
    const c = setup(p);
    c.wren(); c.chip.transact([0x02, ...a3(0x1000), 0x0f]);
    c.clock.advance(TIMING[p].typical.pp);
    idThrows(() => c.chip.powerCut(), FaultError, "fault.no-cycle");
    assert.equal(c.chip.faultState().ops.completed, 1);
    // out-of-scope cycles
    const w = setup(p); w.wren(); w.chip.transact([0x01, 0x04, 0x00]);
    idThrows(() => w.chip.powerCut(), NotModeled, "fault.out-of-scope");
    assert.notEqual(w.chip.busyUntil(), null, "the WRSR cycle was left alone");
    const e = setup(p); e.wren(); e.chip.transact([0x81, ...a3(0x1000)]);
    idThrows(() => e.chip.powerCut(), NotModeled, "fault.out-of-scope");
    // when a scheduled cut was already due, powerCut reports THAT cut
    const d = setup(p, { fault: { op: "erase4k", at: { fraction: 0.5 } } });
    d.wren(); d.chip.transact([0x20, ...a3(0x9000)]);
    d.clock.advance(TIMING[p].typical.se);
    const rec = d.chip.powerCut();
    assert.equal(rec.source, "scheduled", "the scheduled cut came first");
    assert.equal(d.chip.faultState().firedCount, 1);
  });

  // ---------------------------------------------------------------- determinism
  both(["fault.range"], "deterministic: the same flash, profile, timing, trigger and operations give identical records, ranges and inputs; typical and maximum timing give different instants", (p) => {
    const run = (timing) => {
      const m = setup(p, { timing, fault: { op: "erase", nth: 2, at: { fraction: 0.37 } } });
      for (const a of [0x1000, 0x2000]) { m.wren(); m.chip.transact([0x20, ...a3(a)]); if (a === 0x1000) m.finish(); }
      m.clock.advance(50000);
      assert.throws(() => m.chip.readStatus(), PoweredOff);
      m.chip.powerRestore();
      const st = m.chip.faultState(), l = st.last;
      return { rec: { ...l, before: [...l.before], ifCompleted: [...l.ifCompleted], unknownBefore: [...l.unknownBefore], unknownIfCompleted: [...l.unknownIfCompleted] }, ranges: st.indeterminate, ops: st.ops, read: [...m.chip.transact([0x03, ...a3(0x1ffc)], { read: 8 }).unknown] };
    };
    assert.deepEqual(run("typical"), run("typical"));
    assert.deepEqual(run("maximum"), run("maximum"));
    assert.notEqual(run("typical").rec.cutAt, run("maximum").rec.cutAt);
    assert.equal(run("typical").rec.cutAt - run("typical").rec.startedAt, Math.floor(0.37 * TIMING[p].typical.se));
  });

  // ---------------------------------------------------------------- disabled means unchanged
  both(["fault.out-of-scope"], "fault injection disabled or idle changes nothing: an unarmed chip, an armed-then-disarmed chip and an armed chip whose kind never occurs behave identically; powerCycle() mid-cycle is unchanged", (p) => {
    const script = (m) => {
      const out = [];
      const t = (tx, o) => { try { const r = m.chip.transact(tx, o); out.push([r.outcome, r.out && [...r.out], r.unknown && [...r.unknown]]); } catch (e) { out.push([e.name, e.id ?? e.message]); } };
      m.wren(); t([0x02, ...a3(0x2000), 0x12, 0x34]); t([0x05], { read: 1 }); t([0x03, ...a3(0x2000)], { read: 4 }); m.clock.advance(TIMING[p].typical.pp - 1); t([0x05], { read: 1 });
      m.clock.advance(1); t([0x05], { read: 1 }); t([0x03, ...a3(0x2000)], { read: 4 });
      m.wren(); t([0x20, ...a3(0x3000)]); m.finish(); t([0x03, ...a3(0x3000)], { read: 2 }); m.wren(); t([0x60]); m.finish(); t([0x9f], { read: 3 }); t([0x01, 0x1c, 0x00]);
      m.wren(); t([0x01, 0x1c, 0x00]); m.finish(); t([0x05], { read: 1 }); m.chip.powerCycle(); t([0x05], { read: 1 });
      out.push(m.chip.peek(0, 64).join(","));
      return JSON.stringify(out);
    };
    const never = script(setup(p)), armedDisarmed = (() => { const m = setup(p, { fault: { op: "any", at: { atAccept: true } } }); m.chip.disarmFault(); return script(m); })();
    const nonMatching = (() => { const m = setup(p, { fault: { op: "program", nth: 50, at: { fraction: 0.5 } } }); return script(m); })();      // the 50th program never happens
    assert.equal(armedDisarmed, never); assert.equal(nonMatching, never);
    const idle = setup(p).chip.faultState();
    assert.deepEqual([idle.armed, idle.poweredOff, idle.firedCount, idle.last, idle.indeterminate, idle.indeterminateBytes, idle.indeterminateReads, idle.ops], [null, false, 0, null, [], 0, 0, { accepted: 0, completed: 0, interrupted: 0 }]);
    for (const fault of [null, { op: "program", at: { fraction: 0.5 } }]) {
      const m = setup(p, { fault }); m.wren(); m.chip.transact([0x02, ...a3(0x1000), 0x0f]);
      idThrows(() => m.chip.powerCycle(), NotModeled, "nm.power-loss");                  // an orderly power cycle during a cycle is still refused exactly as before
    }
  });

  // ================================================================ the outcome policies: pure functions, no chip involved
  /** a hand-made fired record: ranges [[10, 13], [20, 21]] (6 bytes) */
  const rec = (over = {}) => ({
    fired: true, op: "program", cutAt: 5, profile: "puya", timing: "typical", ranges: [[10, 13], [20, 21]],
    before: Uint8Array.from([0xff, 0xf0, 0xaa, 0x0f, 0x33, 0xcc]), unknownBefore: Uint8Array.from([0, 0, 0, 0, 0, 0]),
    ifCompleted: Uint8Array.from([0x12, 0x30, 0x0a, 0x00, 0x11, 0x44]), unknownIfCompleted: Uint8Array.from([0, 0, 0, 0, 0, 0]), ...over,
  });
  test("outcome policy: an explicit policy is REQUIRED (no default fill, no default seed); every malformed policy is refused with its id", () => {
    const bad = (policy, id) => assert.throws(() => materialize(rec(), policy), (e) => e instanceof FaultPolicyError && e.id === id, JSON.stringify(policy));
    for (const p of [undefined, null, 5, "old", [], [{ kind: "old" }]]) bad(p, "fault.policy-required");
    bad({}, "fault.bad-policy"); bad({ kind: "bogus" }, "fault.bad-policy"); bad({ kind: "OLD" }, "fault.bad-policy"); bad({ kind: undefined }, "fault.bad-policy");
    for (const kind of ["random", "bit-mix"]) { bad({ kind }, "fault.seed-required"); for (const seed of [-1, 1.5, 2 ** 32, "1", NaN, null]) bad({ kind, seed }, "fault.seed-required"); bad({ kind, seed: 1, fraction: 0.5 }, "fault.bad-policy"); }
    for (const kind of ["old", "new", "ff", "zero"]) { bad({ kind, seed: 1 }, "fault.bad-policy"); bad({ kind, fraction: 0.5 }, "fault.bad-policy"); bad({ kind, extra: 1 }, "fault.bad-policy"); }
    for (const fraction of [undefined, -0.1, 1.1, NaN, "0.5"]) bad({ kind: "prefix", fraction }, "fault.bad-policy");
    for (const p of [{ kind: "old" }, { kind: "new" }, { kind: "ff" }, { kind: "zero" }, { kind: "random", seed: 0 }, { kind: "bit-mix", seed: 0xffffffff }, { kind: "prefix", fraction: 0 }, { kind: "prefix", fraction: 1 }]) assert.deepEqual(validatePolicy(p), p);
    assert.deepEqual(FILLS, ["old", "new", "ff", "zero", "random", "bit-mix", "prefix"]);
    assert.throws(() => materialize(null, { kind: "old" }), (e) => e.id === "fault.bad-record");
    assert.throws(() => materialize({ fired: false }, { kind: "old" }), (e) => e.id === "fault.bad-record");
    assert.throws(() => materialize(rec({ ranges: [[0, 1]] }), { kind: "old" }), (e) => e.id === "fault.bad-record");
  });
  test("outcome policy: old, new, ff and zero give the literal bytes, in record order, and never touch the record", () => {
    const r = rec(), snapshot = JSON.stringify({ ...r, before: [...r.before], ifCompleted: [...r.ifCompleted], unknownBefore: [...r.unknownBefore], unknownIfCompleted: [...r.unknownIfCompleted] });
    assert.deepEqual([...materialize(r, { kind: "old" }).bytes], [0xff, 0xf0, 0xaa, 0x0f, 0x33, 0xcc]);
    assert.deepEqual([...materialize(r, { kind: "new" }).bytes], [0x12, 0x30, 0x0a, 0x00, 0x11, 0x44]);
    assert.deepEqual([...materialize(r, { kind: "ff" }).bytes], new Array(6).fill(0xff));
    assert.deepEqual([...materialize(r, { kind: "zero" }).bytes], new Array(6).fill(0));
    assert.deepEqual(materialize(r, { kind: "old" }).ranges, [[10, 13], [20, 21]]);
    assert.equal(JSON.stringify({ ...r, before: [...r.before], ifCompleted: [...r.ifCompleted], unknownBefore: [...r.unknownBefore], unknownIfCompleted: [...r.unknownIfCompleted] }), snapshot, "the record is not modified");
  });
  test("outcome policy: the PRNG is mulberry32, matching an independent implementation and frozen literal vectors; random uses the TOP byte, one draw per record byte", () => {
    const indep = (seed) => { let a = BigInt(seed >>> 0); const M = 0xffffffffn; return () => { a = (a + 0x6d2b79f5n) & M; let t = a; t = ((t ^ (t >> 15n)) * ((1n | t) & M)) & M; t = ((t + (((t ^ (t >> 7n)) * ((61n | t) & M)) & M)) ^ t) & M; return Number((t ^ (t >> 14n)) & M); }; };
    for (const seed of [0, 1, 12345, 0x7fffffff, 0xffffffff]) { const a = mulberry32(seed), b = indep(seed); for (let i = 0; i < 50; i++) assert.equal(a(), b(), `seed ${seed} draw ${i}`); }
    const first = (seed, n) => { const g = mulberry32(seed); return Array.from({ length: n }, () => g()); };
    assert.deepEqual(first(1, 4), [2693262067, 11749833, 2265367787, 4213581821], "frozen vectors for seed 1");
    assert.deepEqual(first(0, 3), [1144304738, 1416247, 958946056], "frozen vectors for seed 0");
    const out = materialize(rec(), { kind: "random", seed: 1 });
    assert.deepEqual([...out.bytes], first(1, 6).map((v) => v >>> 24), "random = top byte of each draw, in record order");
    assert.ok(out.unknown.every((u) => u === 0), "random bytes are known (they are an input, not a physical claim)");
  });
  test("outcome policy: determinism and seed sensitivity: identical inputs give identical bytes; different seeds give different bytes; the draw does not depend on unknown bytes", () => {
    for (const kind of ["random", "bit-mix"]) {
      const a = materialize(rec(), { kind, seed: 7 }), b = materialize(rec(), { kind, seed: 7 }), c = materialize(rec(), { kind, seed: 8 });
      assert.deepEqual(a, b, `${kind} repeats`);
      assert.notDeepEqual([...a.bytes], [...c.bytes], `${kind}: another seed differs`);
    }
    const withUnknown = rec({ unknownBefore: Uint8Array.from([0, 1, 0, 0, 0, 0]) }), plain = materialize(rec(), { kind: "random", seed: 9 });
    assert.deepEqual([...materialize(withUnknown, { kind: "random", seed: 9 }).bytes], [...plain.bytes], "random is independent of which bytes are unknown");
  });
  test("outcome policy: bit-mix takes every bit from old or from completed (never invented); both sources occur; bits where they agree are fixed", () => {
    const n = 256, before = Uint8Array.from({ length: n }, (_, i) => (i * 7 + 1) & 0xff), done = Uint8Array.from({ length: n }, (_, i) => before[i] & ((i * 13 + 5) & 0xff));
    const r = rec({ ranges: [[0, n - 1]], before, ifCompleted: done, unknownBefore: new Uint8Array(n), unknownIfCompleted: new Uint8Array(n) });
    let fromOld = 0, fromNew = 0;
    for (const seed of [1, 2, 3, 4]) {
      const out = materialize(r, { kind: "bit-mix", seed });
      for (let i = 0; i < n; i++) for (let b = 0; b < 8; b++) {
        const o = (before[i] >> b) & 1, d = (done[i] >> b) & 1, x = (out.bytes[i] >> b) & 1;
        assert.ok(x === o || x === d, `seed ${seed} byte ${i} bit ${b} is neither old nor completed`);
        if (o !== d) { if (x === o) fromOld++; else fromNew++; }
      }
      for (let i = 0; i < n; i++) assert.equal(out.bytes[i] & ~before[i] & 0xff, 0, "a program can only clear bits: no bit is set that was clear before");
    }
    assert.ok(fromOld > 200 && fromNew > 200, `both sources occur (${fromOld} / ${fromNew})`);
  });
  test("outcome policy: prefix(f) takes the first floor(f * length) bytes completed and the rest old, at every boundary", () => {
    const r = rec();
    const at = (f) => [...materialize(r, { kind: "prefix", fraction: f }).bytes];
    const old = [0xff, 0xf0, 0xaa, 0x0f, 0x33, 0xcc], done = [0x12, 0x30, 0x0a, 0x00, 0x11, 0x44];
    assert.deepEqual(at(0), old); assert.deepEqual(at(1), done);
    assert.deepEqual(at(0.5), [...done.slice(0, 3), ...old.slice(3)]);
    assert.deepEqual(at(0.99), [...done.slice(0, 5), ...old.slice(5)]);
    assert.deepEqual(at(1 / 6), [...done.slice(0, 1), ...old.slice(1)]);
    assert.deepEqual(at(0.16), old, "floor(0.16 * 6) = 0");
  });
  test("outcome policy: UNKNOWN stays unknown: outputs that depend on an unknown input are marked unknown (placeholder 0), constants and random never are", () => {
    const r = rec({ unknownBefore: Uint8Array.from([0, 1, 0, 0, 0, 0]), unknownIfCompleted: Uint8Array.from([0, 1, 0, 1, 0, 0]) });
    const m = (policy) => { const o = materialize(r, policy); return [[...o.unknown], [...o.bytes]]; };
    assert.deepEqual(m({ kind: "old" }), [[0, 1, 0, 0, 0, 0], [0xff, 0, 0xaa, 0x0f, 0x33, 0xcc]]);
    assert.deepEqual(m({ kind: "new" }), [[0, 1, 0, 1, 0, 0], [0x12, 0, 0x0a, 0, 0x11, 0x44]]);
    assert.deepEqual(m({ kind: "bit-mix", seed: 3 })[0], [0, 1, 0, 1, 0, 0], "bit-mix is unknown where either source is");
    assert.deepEqual(m({ kind: "prefix", fraction: 0.5 })[0], [0, 1, 0, 0, 0, 0], "prefix: completed part [0,3) uses the completed mask, the rest the old mask");
    for (const p of [{ kind: "ff" }, { kind: "zero" }, { kind: "random", seed: 1 }]) assert.deepEqual(m(p)[0], [0, 0, 0, 0, 0, 0], `${p.kind} is known everywhere`);
  });
  test("outcome policy: every outcome is labelled SYNTHETIC and carries the standing statement that a finite set of fills does not exhaust the possible outcomes", () => {
    assert.match(DISCLAIMER, /not a prediction of the physical chip/); assert.match(DISCLAIMER, /does not exhaust the possible physical outcomes/);
    const sweep = standardSweep();
    assert.equal(sweep.exhaustive, false); assert.equal(sweep.disclaimer, DISCLAIMER);
    assert.deepEqual(sweep.policies.map((p) => p.kind), ["old", "new", "ff", "zero", "prefix", "random", "bit-mix", "random", "bit-mix", "random", "bit-mix"]);
    assert.deepEqual(standardSweep({ seeds: [5] }).policies.slice(-2), [{ kind: "random", seed: 5 }, { kind: "bit-mix", seed: 5 }]);
    assert.deepEqual(standardSweep(), standardSweep(), "the sweep list is deterministic");
    for (const p of sweep.policies) {
      const o = materialize(rec(), p);
      assert.equal(o.provenance.synthetic, true); assert.equal(o.provenance.disclaimer, DISCLAIMER); assert.deepEqual(o.provenance.policy, p);
      assert.match(describeOutcome(o), /^SYNTHETIC fill /); assert.ok(describeOutcome(o).endsWith(DISCLAIMER));
    }
  });

  // ================================================================ separation of physical uncertainty from synthetic outcomes
  both(["fault.cut-contents"], "separation: the chip model never takes a policy or states post-interruption contents; applying every fill to COPIES leaves the model's unknown state exactly as it was", (p) => {
    const m = setup(p, { fault: { op: "erase4k", at: { fraction: 0.5 } } });
    accept(m, "erase4k"); m.clock.advance(dur(p, "typical", "erase4k"));
    assert.throws(() => m.chip.readStatus(), PoweredOff); m.chip.powerRestore();
    const state0 = JSON.stringify(m.chip.faultState().indeterminate), probe = () => { const k = m.chip.peekKnown(0x24000, 16); return [[...k.bytes], [...k.unknown]]; };
    const p0 = probe(), record = m.chip.faultState().last;
    const images = standardSweep().policies.map((pol) => applyToImage(pat(), materialize(record, pol)));
    assert.ok(images.length === 11);
    assert.equal(JSON.stringify(m.chip.faultState().indeterminate), state0, "the model's indeterminate set did not change");
    assert.deepEqual(probe(), p0, "the model still reports the range as unknown, whatever fills were generated");
    assert.ok(p0[1].every((u) => u === 1) && p0[0].every((b) => b === 0));
    // the sources are structurally apart: the model imports no policy code and the policy code imports no model
    const here = (f) => readFileSync(resolve(import.meta.dirname, f), "utf8");
    assert.doesNotMatch(here("chipmodel.mjs"), /from\s+["']\.\/faultpolicy|\bmaterialize\s*\(|\bFILLS\b/, "chipmodel.mjs must not import or call fill code");
    assert.doesNotMatch(here("faultpolicy.mjs"), /from\s+["']\.\/chipmodel|new\s+ChipModel/, "faultpolicy.mjs must not use the model");
    // an applied outcome keeps its unknown marks separate from known bytes (an `old` fill of a range that was unknown stays unknown)
    const twice = applyToImage(pat(), materialize(record, { kind: "ff" }));
    assert.ok(twice.unknown.every((u) => u === 0), "ff is a known synthetic input");
    const base = new Uint8Array(BYTES); base[7] = 1;
    assert.equal(applyToImage(pat(), materialize(record, { kind: "old" }), base).unknown[7], 1, "unknown marks from the base image are kept");
  });
  both(["fault.range"], "control: the `new` fill equals a normal completion byte for byte and `old` equals the untouched chip, so a policy outcome can always be compared against the two bounds", (p) => {
    for (const kind of ["program", "erase4k", "erase64k"]) {
      const m = setup(p, { fault: { op: kind, at: { fraction: 0.5 } } }), done = setup(p), untouched = setup(p);
      accept(m, kind); accept(done, kind); m.clock.advance(dur(p, "typical", kind)); done.clock.advance(dur(p, "typical", kind));
      assert.throws(() => m.chip.readStatus(), PoweredOff);
      const r = m.chip.faultState().last, [[lo, hi]] = KINDS[kind].range;
      assert.deepEqual([...materialize(r, { kind: "new" }).bytes], [...done.chip.peek(lo, hi - lo + 1)], `${kind}: new == a normal completion`);
      assert.deepEqual([...materialize(r, { kind: "old" }).bytes], [...untouched.chip.peek(lo, hi - lo + 1)], `${kind}: old == untouched`);
      assert.notDeepEqual([...done.chip.peek(lo, hi - lo + 1)], [...untouched.chip.peek(lo, hi - lo + 1)], `${kind}: completing really changes the range, so the bounds differ`);
    }
  });
}

/** Full-tier regression: with fault injection disabled the oracle transcripts are byte-identical to the pre-fault baseline. */
export function registerFaultRegressionTests(test, { genPath }) {
  test("fault injection disabled: the oracle transcripts (default, --with-ruid, --no-partial --with-ruid) are byte-identical to the pre-fault baseline", async () => {
    const { createHash } = await import("node:crypto");
    const { mkdtempSync, readFileSync: rf, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "fm1-fault-regress-"));
    try {
      const baseline = [
        [[], "ff9b44b8d0b0b44d9c1546b43b279225ad160871c80e6a74e721061dd9f842a9"],
        [["--with-ruid"], "46749b805c73efbb541665fc89f42bfc2b759845f286c1f4c9e7c01ff3053f11"],
        [["--no-partial", "--with-ruid"], "6a52a23111e750dfe5d9ddc818161a80e6c37a59b21b334422d6b93b9e90a25c"],
      ];
      for (const [args, want] of baseline) {
        const file = join(dir, `t${args.length}.txt`);
        const r = spawnSync(process.execPath, [genPath, file, ...args], { encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(createHash("sha256").update(rf(file)).digest("hex"), want, `transcript ${JSON.stringify(args)} changed: the model's behaviour with no fault armed must not change`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
