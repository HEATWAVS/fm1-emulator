// Live fault-injection tests (Component 5, Stage 5C-3): the REAL chip-profile engine's `fm1_fault_*` exports, `fm1_power_cut`, `fm1_cycles`, and the clock syncs of the exports
// that move the SoC clock (`fm1_render`, `fm1_test_advance_us`). The engine records interruption, affected range and indeterminate state ONLY: nothing here applies a synthetic
// fill (Stage 5D) and nothing claims what a physical chip would hold after a cut.
// Full tier only; reported SKIPPED, never passed, when the chip engine has not been built. Names start "fault live".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LiveChip, FLASH_BYTES, SETTLE_US, pat } from "./chiplive.mjs";
import { Fm1Machine, corruptedSectors } from "./machine.mjs";

const CPU = 100;                                // cycles per microsecond at the harness's 100 MHz
const a3 = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const OP = { program: 0, erase4k: 1, erase32k: 2, erase64k: 3, erase: 4, chipErase: 5, any: 6 };
const AT = { accept: 0, fraction: 1, us: 2, cycles: 3 };
const ERR = { ok: 0, badNth: 1, badAt: 2, alreadyArmed: 3, useRestore: 4, noCycle: 5, alreadyOff: 6, notOff: 7, outOfScope: 8, notEnabled: 9, noChip: 10, badArg: 11 };
const STATE = { powerCut: 0, chipOff: 1, armed: 2, scheduled: 3, seen: 4, journaling: 5, fired: 6, accepted: 7, completed: 8, interrupted: 9, ranges: 10, bytes: 11, reads: 12, offAccesses: 13, refused: 14, record: 15 };
const REC = { cutAt: 0, detectedAt: 1, startedAt: 2, endWouldBeAt: 3, ordinal: 4, nth: 5, source: 6, op: 7, ranges: 8, length: 9 };
const PP_TYPICAL_US = { puya: 2000, uc25hq80: 1500 }, SE_TYPICAL_US = { puya: 8000, uc25hq80: 7000 };

/** Every export the engine has, classified by what it does to the SoC clock and to the flash view. A new export must be added here (the completeness test fails otherwise),
 * which forces the question "does it move the clock, and does it sync a due cut first?" to be answered. */
const MOVES_THE_CLOCK = ["fm1_render", "fm1_test_advance_us"];                       // each must fire a due cut before returning (tested one by one)
const SHOWS_OR_ANSWERS_FROM_THE_FLASH = [                                               // each fires a due cut first (nothing else can move the clock, so this is defence in depth)
  "fm1_flash", "fm1_xip", "fm1_flash_wip", "fm1_flash_events", "fm1_flash_nv_status", "fm1_test_bus_read32", "fm1_test_bus_write32",
  "fm1_fault_arm", "fm1_fault_cut", "fm1_fault_restore", "fm1_fault_state", "fm1_fault_record", "fm1_fault_record_range", "fm1_fault_range", "fm1_fault_bytes", "fm1_power_cut",
];
const NEITHER = [                                                                       // configuration, input, panel and memory-management exports: no clock, no flash content
  "__indirect_function_table", "memory", "fm1_ahead", "fm1_alloc", "fm1_analog", "fm1_bench_script", "fm1_board", "fm1_boot", "fm1_boot_fwsc", "fm1_enc", "fm1_flash_base",
  "fm1_flash_busy", "fm1_flash_chip", "fm1_flash_len", "fm1_flash_nv_restore", "fm1_flash_restore", "fm1_flash_revision", "fm1_flash_timing", "fm1_flash_uid_clear", "fm1_flash_uid_set",
  "fm1_halted", "fm1_idle_ms", "fm1_jit", "fm1_lcd", "fm1_lcd_revision", "fm1_leds", "fm1_load_syx", "fm1_midi", "fm1_minsns", "fm1_ms", "fm1_out_l", "fm1_out_r", "fm1_pads",
  "fm1_pot", "fm1_profile", "fm1_profile_report", "fm1_test_set_wp", "fm1_velocity", "fm1_xip_len", "fm1_key",
  "fm1_fault_enable", "fm1_fault_disarm", "fm1_cycles", "panel_board", "panel_draw", "panel_enc_id", "panel_height", "panel_hit", "panel_hit_y", "panel_lcd", "panel_leds", "panel_set", "panel_slide", "panel_width",
];

export function registerFaultLiveTests(testChip, { chipEngine, pkg, quadro }) {
  const T = (name, fn) => testChip(`fault live: ${name}`, fn);
  const open = (profile = "puya", { timing = "typical", fill = "pat" } = {}) => {
    const c = LiveChip.boot(chipEngine, pkg, { flashChip: profile, flashTiming: timing });
    return fill ? c.fill(fill) : c;
  };
  const st = (x, k) => x.fm1_fault_state(STATE[k]);
  const rec = (x, k) => x.fm1_fault_record(REC[k]);
  const view = (x, ptr, at, n) => new Uint8Array(x.memory.buffer, ptr + at, n);            // read WITHOUT calling an export
  const program = (c, at, data = [0x12, 0x34, 0x56, 0x78]) => { c.wren(); c.tx([0x02, ...a3(at), ...data]); };
  const ranges = (x) => { const out = []; for (let i = 0; ; i++) { const lo = x.fm1_fault_range(i, 0) >>> 0; if (lo === 0xffffffff) break; out.push([lo, x.fm1_fault_range(i, 1) >>> 0]); } return out; };
  const recRanges = (x) => { const out = []; for (let i = 0; i < rec(x, "ranges"); i++) out.push([x.fm1_fault_record_range(i, 0) >>> 0, x.fm1_fault_record_range(i, 1) >>> 0]); return out; };
  const bytes = (x, which) => Array.from(new Uint8Array(x.memory.buffer, x.fm1_fault_bytes(which), rec(x, "length")));

  // ------------------------------------------------------------------------------------------------ the export surface

  T("every export is classified: it moves the clock, shows flash content (and syncs first), or does neither", () => {
    const all = [...chipEngine.exportNames];
    const listed = new Set([...MOVES_THE_CLOCK, ...SHOWS_OR_ANSWERS_FROM_THE_FLASH, ...NEITHER]);
    const unclassified = all.filter((n) => !listed.has(n));
    assert.deepEqual(unclassified, [], `exports with no classification (does one move the clock or show flash content? then it must sync a due cut first): ${unclassified}`);
    const stale = [...listed].filter((n) => !chipEngine.exportNames.has(n));
    assert.deepEqual(stale, [], "the classification names exports the engine does not have");
    for (const n of ["fm1_fault_enable", "fm1_fault_arm", "fm1_fault_disarm", "fm1_fault_cut", "fm1_fault_restore", "fm1_fault_state", "fm1_fault_record", "fm1_fault_record_range", "fm1_fault_range", "fm1_fault_bytes", "fm1_power_cut", "fm1_cycles"]) {
      assert.ok(chipEngine.exportNames.has(n), `${n} is exported`);
    }
  });

  T("with no chip profile every fault export refuses (10) and reads zero; with a chip but unused, state is all zero (disabled means untouched)", () => {
    const legacy = Fm1Machine.boot(chipEngine, pkg, { usb: false });
    const x = legacy.x;
    assert.equal(x.fm1_fault_arm(OP.program, 1, AT.accept, 0), ERR.noChip);
    assert.equal(x.fm1_fault_enable(1), ERR.noChip);
    assert.equal(x.fm1_fault_cut(), ERR.noChip);
    assert.equal(x.fm1_fault_restore(), ERR.noChip);
    assert.equal(x.fm1_fault_disarm(), ERR.noChip);
    for (const k of Object.keys(STATE)) assert.equal(st(x, k), 0, `legacy ${k}`);
    assert.equal(x.fm1_power_cut(), 0);
    const c = open("puya");
    for (const k of Object.keys(STATE)) assert.equal(st(c.x, k), 0, `unused ${k}`);
    for (const k of Object.keys(REC)) assert.equal(rec(c.x, k), -1, `no record ${k}`);
    assert.equal(c.x.fm1_fault_bytes(0), 0, "no record: null pointer");
    assert.equal(c.x.fm1_fault_range(0, 0) >>> 0, 0xffffffff);
    // the program, erase and read paths are the ones the live conformance tests already check; here: a normal cycle changes nothing in the fault state but the counters
    c.run([0x02, ...a3(0x1000), 0x00]);
    assert.deepEqual([st(c.x, "accepted"), st(c.x, "completed"), st(c.x, "interrupted"), st(c.x, "ranges"), st(c.x, "chipOff"), st(c.x, "powerCut")], [1, 1, 0, 0, 0, 0]);
  });

  T("arming validates like the model and reports distinct error codes", () => {
    for (const profile of ["puya", "uc25hq80"]) {
      const c = open(profile), x = c.x, pp = PP_TYPICAL_US[profile];
      assert.equal(x.fm1_fault_arm(9, 1, AT.accept, 0), ERR.badArg, "op out of range");
      assert.equal(x.fm1_fault_arm(OP.program, 1, 7, 0), ERR.badArg, "trigger kind out of range");
      assert.equal(x.fm1_fault_arm(OP.program, 1, AT.cycles, 1.5), ERR.badArg, "cycles must be whole");
      assert.equal(x.fm1_fault_arm(OP.program, 1, AT.us, -1), ERR.badArg);
      assert.equal(x.fm1_fault_arm(OP.program, 1, AT.us, NaN), ERR.badArg);
      assert.equal(x.fm1_fault_arm(OP.program, 0, AT.accept, 0), ERR.badNth);
      assert.equal(x.fm1_fault_arm(OP.program, 1, AT.fraction, 1), ERR.badAt, "fraction 1 would be a normal completion");
      assert.equal(x.fm1_fault_arm(OP.program, 1, AT.fraction, -0.5), ERR.badAt);
      assert.equal(x.fm1_fault_arm(OP.program, 1, AT.us, pp), ERR.badAt, "afterUs at the end is a normal completion");
      assert.equal(x.fm1_fault_arm(OP.program, 1, AT.cycles, pp * CPU), ERR.badAt, "so is a cycle count at the end");
      assert.equal(st(x, "armed"), 0, "refused arms change nothing");
      assert.equal(x.fm1_fault_arm(OP.program, 1, AT.cycles, pp * CPU - 1), ERR.ok);
      assert.equal(st(x, "armed"), 1);
      assert.equal(st(x, "journaling"), 1, "arming turns journaling on");
      assert.equal(x.fm1_fault_arm(OP.program, 1, AT.accept, 0), ERR.alreadyArmed);
      assert.equal(x.fm1_fault_disarm(), 0);
      assert.equal(st(x, "armed"), 0);
    }
  });

  T("every op code arms exactly the kind it names: the matching command is cut and records that op, a different kind is not matched", () => {
    const CMD = {
      program: () => [0x02, ...a3(0x1000), 0x12],
      erase4k: () => [0x20, ...a3(0x4000)],
      erase32k: () => [0x52, ...a3(0x8000)],
      erase64k: () => [0xd8, ...a3(0x10000)],
      chipErase: () => [0x60],
    };
    // [arm code, kinds it matches (the record's op code is the CONCRETE kind), kinds it must not match]
    const CASES = [
      [OP.program, ["program"], ["erase4k", "chipErase"]],
      [OP.erase4k, ["erase4k"], ["erase32k", "program"]],
      [OP.erase32k, ["erase32k"], ["erase4k", "erase64k"]],
      [OP.erase64k, ["erase64k"], ["erase32k", "chipErase"]],
      [OP.erase, ["erase4k", "erase32k", "erase64k"], ["program", "chipErase"]],
      [OP.chipErase, ["chipErase"], ["erase4k", "program"]],
      [OP.any, ["program", "erase4k", "erase32k", "erase64k", "chipErase"], []],
    ];
    const RECORD_OP = { program: 0, erase4k: 1, erase32k: 2, erase64k: 3, chipErase: 5 };
    for (const [code, matches, misses] of CASES) {
      for (const kind of matches) {
        const c = open("puya", { fill: "pat" }), x = c.x;
        assert.equal(x.fm1_fault_arm(code, 1, AT.accept, 0), ERR.ok);
        c.wren(); c.tx(CMD[kind]());
        assert.equal(st(x, "powerCut"), 1, `arm ${code} must cut a ${kind}`);
        assert.equal(rec(x, "op"), RECORD_OP[kind], `arm ${code}: the record names the concrete kind ${kind}`);
      }
      for (const kind of misses) {
        const c = open("puya", { fill: "pat" }), x = c.x;
        assert.equal(x.fm1_fault_arm(code, 1, AT.accept, 0), ERR.ok);
        c.wren(); c.tx(CMD[kind]());
        assert.equal(st(x, "powerCut"), 0, `arm ${code} must not cut a ${kind}`);
        assert.equal(st(x, "seen"), 0, `and must not count it`);
      }
    }
  });

  T("a harness cut: refusals (no cycle, write-status, not journaled, already off, not off) and the record of a real one", () => {
    const c = open("puya"), x = c.x;
    assert.equal(x.fm1_fault_cut(), ERR.noCycle);
    assert.equal(x.fm1_fault_restore(), ERR.notOff);
    // a cycle accepted while journaling is off cannot be cut: refused, never faked
    program(c, 0x1000);
    assert.equal(x.fm1_fault_cut(), ERR.notEnabled);
    c.settle();
    assert.equal(st(x, "completed"), 1, "and it completes normally");
    // write-status is out of scope: refused, left to complete
    assert.equal(x.fm1_fault_enable(1), 0);
    c.wren(); c.tx([0x01, 0x00, 0x00]);
    assert.equal(x.fm1_fault_cut(), ERR.outOfScope);
    c.settle();
    assert.equal(st(x, "completed"), 2);
    // a real one
    program(c, 0x2000);
    const t = x.fm1_cycles();
    c.advance(100);
    assert.equal(x.fm1_fault_cut(), 0);
    assert.equal(st(x, "powerCut"), 1);
    assert.equal(st(x, "chipOff"), 1);
    assert.equal(rec(x, "source"), 1, "a harness cut");
    assert.equal(rec(x, "nth"), -1, "no trigger number");
    assert.equal(rec(x, "cutAt"), t + 100 * CPU, "cut where the clock was");
    assert.equal(rec(x, "cutAt"), rec(x, "detectedAt"));
    assert.equal(rec(x, "op"), OP.program);
    assert.equal(rec(x, "ordinal"), 3, "the 3rd cycle accepted: program, write-status, program");
    assert.equal(x.fm1_fault_cut(), ERR.alreadyOff);
    assert.equal(x.fm1_fault_arm(OP.program, 1, AT.accept, 0), ERR.useRestore, "arming a powered-off chip is refused");
    assert.equal(x.fm1_fault_restore(), 0);
    assert.equal(x.fm1_fault_restore(), ERR.notOff);
    assert.equal(st(x, "powerCut"), 1, "restoring the CHIP does not restart the machine");
    assert.equal(st(x, "chipOff"), 0);
  });

  // ------------------------------------------------------------------------------------------------ the clock exports sync a due cut before returning

  T("fm1_test_advance_us fires a due cut by itself: the array read through a pointer taken BEFORE, with no export call after, already shows the cut", () => {
    for (const profile of ["puya", "uc25hq80"]) {
      const c = open(profile), x = c.x, pp = PP_TYPICAL_US[profile];
      const ptr = x.fm1_flash();
      assert.equal(x.fm1_fault_arm(OP.program, 1, AT.cycles, 20_000), ERR.ok);
      program(c, 0x1000, [0x12, 0x34, 0x56, 0x78]);
      const t0 = x.fm1_cycles() - 0;                                   // (the accept's cycle: no time passes during a bus write)
      assert.deepEqual(Array.from(view(x, ptr, 0x1000, 4)), [pat(0x1000) & 0x12, pat(0x1001) & 0x34, pat(0x1002) & 0x56, pat(0x1003) & 0x78], "D33: the completed bytes show between the accept and the cut");
      x.fm1_test_advance_us(10 * pp);                                    // far beyond the end of the cycle; no chip access
      // NO export call from here on that could sync: read the memory directly
      assert.deepEqual(Array.from(view(x, ptr, 0x1000, 4)), [pat(0x1000), pat(0x1001), pat(0x1002), pat(0x1003)], `${profile}: the pre-image, not the completed bytes`);
      assert.equal(st(x, "powerCut"), 1);
      assert.equal(st(x, "completed"), 0, "the cycle never completed");
      assert.equal(rec(x, "cutAt"), t0 + 20_000, "requested deadline");
      assert.ok(rec(x, "detectedAt") >= t0 + 10 * pp * CPU, "noticed at the end of the bulk jump");
      assert.deepEqual(ranges(x), [[0x1000, 0x1003]]);
      // control: the same jump with nothing armed completes
      const k = open(profile);
      program(k, 0x1000);
      k.x.fm1_test_advance_us(10 * pp);
      assert.deepEqual([st(k.x, "completed"), st(k.x, "powerCut"), st(k.x, "ranges")], [1, 0, 0], "control completes");
    }
  });

  T("fm1_render stops on a power cut and reports it as a power cut, not a CPU crash; the audit record is exact", () => {
    const m = Fm1Machine.boot(chipEngine, quadro, { flashChip: "puya", usb: false }), x = m.x;
    assert.equal(x.fm1_fault_arm(OP.any, 1, AT.cycles, 5000), ERR.ok);
    const base = m.flash();
    const ptr = x.fm1_flash();
    let n = 0;
    while (!x.fm1_power_cut() && n++ < 3000) x.fm1_render(128, 4_000_000);
    assert.equal(x.fm1_power_cut(), 1, "the firmware's first flash write was cut and the machine stopped");
    assert.equal(x.fm1_halted(), 0, "NOT reported as a CPU halt");
    assert.equal(m.halted, false);
    assert.equal(st(x, "powerCut"), 1);
    assert.equal(st(x, "chipOff"), 1);
    assert.equal(st(x, "interrupted"), 1);
    // audit: requested, actual and where the machine stopped
    const cutAt = rec(x, "cutAt"), detectedAt = rec(x, "detectedAt");
    assert.equal(cutAt, rec(x, "startedAt") + 5000, "requested = accept + 5000 cycles");
    assert.equal(detectedAt, cutAt, "under the machine's own loops the cut fires exactly at its cycle");
    assert.equal(x.fm1_cycles(), cutAt, "and the machine stopped there");
    assert.ok(rec(x, "endWouldBeAt") > cutAt, "before the cycle would have ended");
    // nothing runs afterwards: the clock and the instruction counter stand still however often it is rendered
    const cycles = x.fm1_cycles(), insns = x.fm1_minsns();
    for (let k = 0; k < 8; k++) x.fm1_render(128, 4_000_000);
    assert.equal(x.fm1_cycles(), cycles, "rendering a machine without power runs nothing");
    assert.equal(x.fm1_minsns(), insns);
    assert.equal(x.fm1_halted(), 0);
    // the array: the cut range holds the pre-image as a placeholder (the record's `before`), everything else is what the firmware had written so far
    const now = new Uint8Array(x.memory.buffer, ptr, FLASH_BYTES), before = bytes(x, 0);
    const rr = recRanges(x);
    assert.ok(rr.length >= 1, "the record names the bytes at risk");
    let i = 0;
    for (const [lo, hi] of rr) for (let a = lo; a <= hi; a++, i++) assert.equal(now[a], before[i], `placeholder at ${a.toString(16)}`);
    assert.deepEqual(ranges(x), rr.map(([l, h]) => [l, h]).sort((a, b) => a[0] - b[0]).reduce((out, r) => { const last = out[out.length - 1]; if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else out.push([...r]); return out; }, []), "the indeterminate list is the record's ranges");
    assert.ok(base.length === FLASH_BYTES);
  });

  T("a real CPU fault is still a halt and never a power cut (the two states are distinguishable)", () => {
    const m = Fm1Machine.boot(chipEngine, pkg, { usb: false, sectors: corruptedSectors(chipEngine, pkg, ["erase:0x20000"], { usb: false }) });
    m.run(3000);
    assert.equal(m.x.fm1_halted(), 1, "the corrupted Felucca crashes (CPU halt)");
    assert.equal(m.x.fm1_power_cut(), 0, "and that is not a power cut");
    assert.equal(m.x.fm1_fault_state(STATE.powerCut), 0);
  });

  T("the cut is deterministic: the same arm and the same firmware give the same record and the same flash", () => {
    const run = () => {
      const m = Fm1Machine.boot(chipEngine, quadro, { flashChip: "puya", usb: false }), x = m.x;
      assert.equal(x.fm1_fault_arm(OP.program, 1, AT.fraction, 0.5), ERR.ok);
      let n = 0;
      while (!x.fm1_power_cut() && n++ < 3000) x.fm1_render(128, 4_000_000);
      assert.equal(x.fm1_power_cut(), 1);
      return { rec: Object.keys(REC).map((k) => rec(x, k)), ranges: ranges(x), before: bytes(x, 0), unkBefore: bytes(x, 1), done: bytes(x, 2), unkDone: bytes(x, 3), cycles: x.fm1_cycles(), flash: m.flashHash(), n };
    };
    const a = run(), b = run();
    assert.deepEqual(a, b);
    assert.equal(a.rec[REC.cutAt], a.rec[REC.startedAt] + Math.floor(0.5 * PP_TYPICAL_US.puya) * CPU, "fraction 0.5 of a 2000 us program is 1000 us = 100000 cycles");
  });

  // ------------------------------------------------------------------------------------------------ indeterminate ranges and read counts

  T("indeterminate ranges, read counts, power-off answers and the clearing erase are all reported correctly", () => {
    for (const profile of ["puya", "uc25hq80"]) {
      const c = open(profile), x = c.x;
      assert.equal(x.fm1_fault_arm(OP.program, 1, AT.accept, 0), ERR.ok);
      program(c, 0x10fe, [0x0f, 0xf0, 0x55, 0xaa]);                       // wraps inside the page: positions 0xfe 0xff 0x00 0x01
      assert.equal(st(x, "powerCut"), 1, "a cut at the accept fires inside the accepting write");
      assert.deepEqual(ranges(x), [[0x1000, 0x1001], [0x10fe, 0x10ff]]);
      assert.deepEqual(recRanges(x), ranges(x));
      assert.deepEqual([st(x, "ranges"), st(x, "bytes")], [2, 4]);
      assert.deepEqual(bytes(x, 0), [pat(0x1000), pat(0x1001), pat(0x10fe), pat(0x10ff)], "before");
      assert.deepEqual(bytes(x, 2), [pat(0x1000) & 0x55, pat(0x1001) & 0xaa, pat(0x10fe) & 0x0f, pat(0x10ff) & 0xf0], "what a normal completion would have produced");
      assert.deepEqual([...bytes(x, 1), ...bytes(x, 3)], [0, 0, 0, 0, 0, 0, 0, 0], "nothing unknown yet");
      assert.deepEqual(Array.from(c.mem().subarray(0x1000, 0x1002)), [pat(0x1000), pat(0x1001)], "the array holds the pre-image as a placeholder");
      // powered off: every byte offered is answered 0xFF and counted, nothing else changes
      const off = st(x, "offAccesses");
      assert.deepEqual(c.tx([0x05], 1), [0xff]);
      assert.equal(st(x, "offAccesses"), off + 2, "the opcode and the read slot");
      assert.equal(x.fm1_fault_restore(), 0);
      assert.equal(st(x, "reads"), 0);
      c.tx([0x03, ...a3(0x0ff0)], 8);                                       // known bytes only: not counted
      assert.equal(st(x, "reads"), 0);
      c.tx([0x03, ...a3(0x0ffc)], 8);                                       // straddles into 0x1000: counted once
      assert.equal(st(x, "reads"), 1);
      c.tx([0x03, ...a3(0x1000)], 100);                                     // many indeterminate bytes in one transaction: once
      assert.equal(st(x, "reads"), 2);
      c.tx([0x03, ...a3(0x10fe)], 2);
      assert.equal(st(x, "reads"), 3);
      c.tx([0x03, ...a3(0x2000)], 16);
      assert.equal(st(x, "reads"), 3, "a known region is never counted");
      assert.deepEqual(ranges(x), [[0x1000, 0x1001], [0x10fe, 0x10ff]], "reading changes nothing");
      // a later complete erase makes the bytes known again, at completion and not before
      const se = SE_TYPICAL_US[profile];
      c.wren(); c.tx([0x20, ...a3(0x1000)]);
      assert.equal(st(x, "ranges"), 2, "accepted only: still indeterminate");
      c.advance(se - 1);
      assert.equal(st(x, "ranges"), 2, "one microsecond before the erase completes");
      c.advance(1);
      assert.deepEqual([st(x, "ranges"), st(x, "bytes")], [0, 0], "completed: 0xFF and known");
      assert.ok(c.mem().subarray(0x1000, 0x2000).every((b) => b === 0xff));
      assert.equal(st(x, "reads"), 3, "the count is cumulative");
      assert.equal(st(x, "powerCut"), 1, "and the machine is still terminal");
    }
  });
}
