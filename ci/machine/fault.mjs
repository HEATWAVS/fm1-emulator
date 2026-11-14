// Flash-chip power-cut fault injection for the headless harness (Component 5, Stage 5D): the JavaScript side of the engine's `fm1_fault_*` exports.
//
// What this layer does: validates and encodes a fault spec, arms it, reads the engine's state and audit record back, reads the indeterminate list and carries it into a rebooted
// machine. What it does NOT do: it never decides what an interrupted range holds. The engine records interruption, affected range and indeterminate state only; a synthetic
// outcome is an explicit, named policy (faultpolicy.mjs) applied by the CALLER, labelled synthetic, and never confused with the engine's indeterminate list.
//
// The three ways a run can stop are distinct and stay distinct: running (nothing stopped it), HALTED (the CPU faulted: `fm1_halted`) and POWER CUT (the flash chip lost power
// and the machine with it: `fm1_power_cut`). Ordinary execution errors are exceptions of the harness, never reported as either.

export class FaultHarnessError extends Error {
  constructor(code, message) { super(`${message} [fault: ${code}]`); this.name = "FaultHarnessError"; this.code = code; }
}

/** Which cycles a trigger may match (the model's FAULT_OPS, chipmodel.mjs): the codes fm1_fault_arm takes. Page erase (81h), write-status, suspend/resume, reset and brown-out are out of scope. */
export const FAULT_OPS = { program: 0, erase4k: 1, erase32k: 2, erase64k: 3, erase: 4, "chip-erase": 5, any: 6 };
const OP_NAMES = Object.fromEntries(Object.entries(FAULT_OPS).map(([k, v]) => [v, k]));
const AT_KINDS = { atAccept: 0, fraction: 1, afterUs: 2, afterCycles: 3 };

/** fm1_fault_* error codes (docs/dev/FAULT-INJECTION.md section 12). */
export const ENGINE_ERRORS = {
  1: "bad-nth", 2: "bad-at", 3: "already-armed", 4: "use-restore", 5: "no-cycle", 6: "already-off", 7: "not-off", 8: "out-of-scope", 9: "not-enabled",
  10: "no-chip", 11: "bad-argument", 12: "bad-range", 13: "cycle-in-flight",
};
const STATE = { powerCut: 0, chipOff: 1, armed: 2, scheduled: 3, seen: 4, journaling: 5, fired: 6, accepted: 7, completed: 8, interrupted: 9, ranges: 10, bytes: 11, reads: 12, offAccesses: 13, refused: 14, record: 15 };
const REC = { cutAt: 0, detectedAt: 1, startedAt: 2, endWouldBeAt: 3, ordinal: 4, nth: 5, source: 6, op: 7, ranges: 8, length: 9 };

export function requiresFaultEngine(engine) {
  if (!engine.capabilities.faultInjection) throw new FaultHarnessError("unsupported-engine", `engine "${engine.name}" has no fault-injection exports (build the chip-profile engine: node ci/engine/build.mjs)`);
}

/**
 * Validate a fault spec and return its canonical form plus the arguments of fm1_fault_arm. A spec is { op, nth = 1, at } with op one of FAULT_OPS, nth >= 1 counting the matching
 * cycles accepted AFTER arming, and `at` exactly one of { atAccept: true } | { fraction } (0 <= f < 1 of the cycle's duration) | { afterUs } | { afterCycles } (whole numbers).
 * `afterCycles` is the exact form (SoC cycles; 100 per microsecond at the harness's default 100 MHz). A trigger at or after the end of the cycle is refused by the engine.
 * A policy, fill or seed is refused here: an outcome policy is a separate, explicit input (faultpolicy.mjs) and is never part of the trigger.
 */
export function parseFaultSpec(spec) {
  const bad = (code, m) => { throw new FaultHarnessError(code, m); };
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) bad("bad-spec", "a fault spec is { op, nth, at }");
  if ("policy" in spec || "fill" in spec || "seed" in spec) bad("policy-not-here", "an outcome policy is not part of the trigger: give it to the run or the reboot (faultpolicy.mjs), explicitly");
  const extra = Object.keys(spec).filter((k) => !["op", "nth", "at"].includes(k));
  if (extra.length) bad("bad-spec", `unknown fault spec field(s): ${extra.join(", ")}`);
  const { op, nth = 1, at } = spec;
  if (!(op in FAULT_OPS)) bad("bad-op", `op must be one of ${Object.keys(FAULT_OPS).join(", ")}`);
  if (!Number.isInteger(nth) || nth < 1) bad("bad-nth", "nth must be an integer >= 1");
  const forms = at && typeof at === "object" ? Object.keys(AT_KINDS).filter((k) => k in at) : [];
  if (forms.length !== 1 || Object.keys(at).length !== 1) bad("bad-at", "at must be exactly one of { atAccept: true } | { fraction } | { afterUs } | { afterCycles }");
  const kind = forms[0], value = at[kind];
  if (kind === "atAccept" && value !== true) bad("bad-at", "atAccept must be true");
  if (kind === "fraction" && !(typeof value === "number" && value >= 0 && value < 1)) bad("bad-at", "fraction must be a number with 0 <= fraction < 1");
  if ((kind === "afterUs" || kind === "afterCycles") && !(Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER)) bad("bad-at", `${kind} must be a non-negative whole number`);
  if (kind === "afterUs" && value > 0xffffffff) bad("bad-at", "afterUs must fit 32 bits");
  return { canonical: { op, nth, at: { [kind]: value } }, args: [FAULT_OPS[op], nth, AT_KINDS[kind], kind === "atAccept" ? 0 : value] };
}

const call = (code, what) => { if (code !== 0) throw new FaultHarnessError(ENGINE_ERRORS[code] ?? `engine-${code}`, `${what} refused by the engine: ${ENGINE_ERRORS[code] ?? code}`); };

/** Arm one single-shot power cut. Returns the canonical spec. */
export function armFault(x, spec) {
  const { canonical, args } = parseFaultSpec(spec);
  call(x.fm1_fault_arm(...args), "arming");
  return canonical;
}
export function disarmFault(x) { call(x.fm1_fault_disarm(), "disarming"); }
export function enableJournal(x, on = true) { call(x.fm1_fault_enable(on ? 1 : 0), "enabling the journal"); }

/** Cut power NOW while a program, erase or chip erase is in flight (the model's powerCut()). Returns the record. The machine goes terminal. */
export function cutPower(x) { call(x.fm1_fault_cut(), "the power cut"); return readRecord(x); }
/** Power returns to the CHIP (never to the machine: the SoC lost power too; only a reboot restarts it). */
export function restoreChip(x) { call(x.fm1_fault_restore(), "restoring the chip"); }

/** The indeterminate list: inclusive [lo, hi] ranges, sorted and disjoint (bytes whose contents are physically unknown). */
export function indeterminateRanges(x) {
  const out = [];
  for (let i = 0; ; i++) {
    const lo = x.fm1_fault_range(i, 0) >>> 0;
    if (lo === 0xffffffff) break;
    out.push([lo, x.fm1_fault_range(i, 1) >>> 0]);
  }
  return out;
}

/** Carry a list of indeterminate ranges into a machine just booted (REPLACES the list; the array is untouched). */
export function setIndeterminate(x, ranges) {
  const bytes = new Uint8Array(ranges.length * 8), dv = new DataView(bytes.buffer);
  ranges.forEach(([lo, hi], i) => {
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi < lo || hi >= (1 << 20)) throw new FaultHarnessError("bad-range", `bad indeterminate range ${JSON.stringify([lo, hi])}`);
    dv.setUint32(i * 8, lo, true); dv.setUint32(i * 8 + 4, hi, true);
  });
  const p = x.fm1_alloc(bytes.length);
  new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes);
  call(x.fm1_fault_set_ranges(p, bytes.length), "carrying the indeterminate ranges");
}

/** Everything the engine's fault machinery reports at the current cycle (numbers only). */
export function readState(x) {
  const s = {};
  for (const [k, i] of Object.entries(STATE)) s[k] = x.fm1_fault_state(i);
  s.powerCut = s.powerCut === 1; s.chipOff = s.chipOff === 1; s.armed = s.armed === 1; s.scheduled = s.scheduled === 1; s.journaling = s.journaling === 1; s.record = s.record === 1;
  s.cycles = x.fm1_cycles();
  s.halted = x.fm1_halted() === 1;
  return s;
}

/**
 * The audit record of the last cut, or null. Cycles are SoC cycles (state.cycles is the same clock): `requestedCutCycle` is the deadline that was asked for (accept + offset),
 * `actualCutCycle` the cycle at which the engine fired the cut; `before`/`ifCompleted` (with their unknown masks) are INPUTS for an outcome policy, never outcomes.
 */
export function readRecord(x) {
  const r = (k) => x.fm1_fault_record(REC[k]);
  if (r("cutAt") === -1) return null;
  const length = r("length"), n = r("ranges");
  const ranges = [];
  for (let i = 0; i < n; i++) ranges.push([x.fm1_fault_record_range(i, 0) >>> 0, x.fm1_fault_record_range(i, 1) >>> 0]);
  const img = (w) => (length ? new Uint8Array(x.memory.buffer, x.fm1_fault_bytes(w), length).slice() : new Uint8Array(0));
  return {
    source: r("source") === 1 ? "harness" : "scheduled",
    op: OP_NAMES[r("op")],
    ordinal: r("ordinal"),
    nth: r("nth") === -1 ? null : r("nth"),
    acceptedAtCycle: r("startedAt"),
    requestedCutCycle: r("cutAt"),
    actualCutCycle: r("detectedAt"),
    endWouldBeAtCycle: r("endWouldBeAt"),
    ranges,
    before: img(0), unknownBefore: img(1), ifCompleted: img(2), unknownIfCompleted: img(3),
  };
}

/** The record in the shape faultpolicy.mjs consumes (`materialize`). cutAt is in SoC cycles here (the policy module only echoes it). */
export function policyRecord(record, { profile, timing }) {
  return {
    fired: true, op: record.op, cutAt: record.requestedCutCycle, profile, timing, ranges: record.ranges.map(([l, h]) => [l, h]),
    before: record.before, unknownBefore: record.unknownBefore, ifCompleted: record.ifCompleted, unknownIfCompleted: record.unknownIfCompleted,
  };
}
