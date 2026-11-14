// Outcome policies for an interrupted flash cycle (Component 5, Stage 5B).
//
// READ THIS FIRST. Neither datasheet says what the array holds after power is lost during a program or erase (docs/dev/FAULT-INJECTION.md, section 2). What the physical chip
// would hold is UNKNOWN. This module does not know it either. Everything here is a SYNTHETIC FILL: a deterministic, named TEST INPUT that gives the CPU some bytes to read, chosen
// by the caller. A fill is not a prediction of the physical chip, and a finite set of fills does not exhaust the possible physical outcomes. Every result carries that statement.
//
// Kept apart from chipmodel.mjs on purpose: the reference model records only the interruption, the affected range and the indeterminate state; it never takes a policy and never
// states post-interruption contents. This module never touches a ChipModel. It consumes a fault RECORD (the model's `faultState().last`) and produces bytes plus an `unknown` mask.
//
// Determinism: the same record, policy and seed give byte-identical results (the PRNG is specified below and tested against an independent implementation).
// Unknown stays unknown: where a policy's output depends on a byte the record marks unknown, that output byte is marked unknown too (never guessed).

/** The statement every report built from these outcomes must carry. */
export const DISCLAIMER = "Synthetic test input, not a prediction of the physical chip: the datasheets do not specify the array after an interrupted cycle, and a finite set of fills does not exhaust the possible physical outcomes.";

export class FaultPolicyError extends Error {
  constructor(id, message) { super(`${message} [fault policy: ${id}]`); this.name = "FaultPolicyError"; this.id = id; }
}

/** Fill kinds. `old` and `new` are the two bounds (no effect / completed); `new` is the control and equals a normal completion. */
export const FILLS = ["old", "new", "ff", "zero", "random", "bit-mix", "prefix"];
const NEEDS_SEED = new Set(["random", "bit-mix"]);

/**
 * mulberry32 (public-domain algorithm), the specified PRNG: state is a 32-bit integer, each call returns an unsigned 32-bit value. The byte drawn for a position is the TOP byte
 * (value >>> 24). One draw per byte of the record, in record order (ranges in order, bytes in address order), whether or not the byte is unknown, so results never depend on
 * which bytes happen to be unknown.
 */
export function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** Validate a policy object. There is NO default: a missing or unknown policy is an error. Returns a normalised copy. */
export function validatePolicy(policy) {
  if (policy === undefined || policy === null || typeof policy !== "object" || Array.isArray(policy)) throw new FaultPolicyError("fault.policy-required", "an explicit outcome policy is required: there is no default fill");
  const { kind } = policy;
  if (!FILLS.includes(kind)) throw new FaultPolicyError("fault.bad-policy", `unknown fill ${JSON.stringify(kind)}; use one of ${FILLS.join(", ")}`);
  if (NEEDS_SEED.has(kind) && !(Number.isInteger(policy.seed) && policy.seed >= 0 && policy.seed <= 0xffffffff)) throw new FaultPolicyError("fault.seed-required", `${kind} needs an explicit integer seed in [0, 2^32): there is no default seed`);
  if (!NEEDS_SEED.has(kind) && "seed" in policy) throw new FaultPolicyError("fault.bad-policy", `${kind} takes no seed`);
  if (kind === "prefix" && !(typeof policy.fraction === "number" && policy.fraction >= 0 && policy.fraction <= 1)) throw new FaultPolicyError("fault.bad-policy", "prefix needs a fraction in [0, 1]");
  if (kind !== "prefix" && "fraction" in policy) throw new FaultPolicyError("fault.bad-policy", `${kind} takes no fraction`);
  const extra = Object.keys(policy).filter((k) => !["kind", "seed", "fraction"].includes(k));
  if (extra.length) throw new FaultPolicyError("fault.bad-policy", `unknown policy field(s): ${extra.join(", ")}`);
  return { ...policy };
}

function checkRecord(r) {
  if (!r || r.fired !== true || !r.before || !r.ifCompleted || !r.unknownBefore || !r.unknownIfCompleted) throw new FaultPolicyError("fault.bad-record", "a fired fault record from ChipModel.faultState().last is required");
  const n = r.ranges.reduce((s, [lo, hi]) => s + hi - lo + 1, 0);
  if (![r.before, r.ifCompleted, r.unknownBefore, r.unknownIfCompleted].every((a) => a.length === n)) throw new FaultPolicyError("fault.bad-record", "record images do not match its ranges");
  return n;
}

/**
 * Turn a fault record into SYNTHETIC bytes for its ranges under an explicit policy.
 * Returns { bytes, unknown, ranges, provenance } where bytes/unknown cover the record's ranges back to back in order; unknown[i] = 1 where the byte depends on an unknown input
 * (bytes[i] is then a 0 placeholder). `provenance.synthetic` is always true and `provenance.disclaimer` always present.
 *   old        the range as it was before (the cycle had no effect)
 *   new        what a normal completion would have produced (the CONTROL: identical to a normal success)
 *   ff, zero   every byte 0xFF / 0x00
 *   random     seeded pseudo-random bytes
 *   bit-mix    seeded, each bit independently its `old` or its `new` value (bounded by both; for a program this keeps the byte between old AND data and old)
 *   prefix     the first floor(fraction * length) bytes `new`, the rest `old` (the upstream FM1_FLASH_CUT "half applied" convention, as a named synthetic fill)
 */
export function materialize(record, policy) {
  const p = validatePolicy(policy);
  const n = checkRecord(record);
  const bytes = new Uint8Array(n), unknown = new Uint8Array(n);
  const { before, ifCompleted, unknownBefore: ub, unknownIfCompleted: un } = record;
  const rng = NEEDS_SEED.has(p.kind) ? mulberry32(p.seed) : null;
  const k = p.kind === "prefix" ? Math.floor(p.fraction * n) : 0;
  for (let i = 0; i < n; i++) {
    const draw = rng ? rng() >>> 24 : 0;                          // one draw per byte, always, for determinism
    switch (p.kind) {
      case "old": bytes[i] = before[i]; unknown[i] = ub[i]; break;
      case "new": bytes[i] = ifCompleted[i]; unknown[i] = un[i]; break;
      case "ff": bytes[i] = 0xff; break;
      case "zero": bytes[i] = 0x00; break;
      case "random": bytes[i] = draw; break;
      case "bit-mix": bytes[i] = (before[i] & ~draw & 0xff) | (ifCompleted[i] & draw); unknown[i] = ub[i] | un[i]; break;
      case "prefix": if (i < k) { bytes[i] = ifCompleted[i]; unknown[i] = un[i]; } else { bytes[i] = before[i]; unknown[i] = ub[i]; } break;
    }
    if (unknown[i]) bytes[i] = 0;
  }
  return {
    bytes, unknown, ranges: record.ranges.map(([lo, hi]) => [lo, hi]),
    provenance: { synthetic: true, policy: p, op: record.op, cutAt: record.cutAt, profile: record.profile, timing: record.timing, disclaimer: DISCLAIMER },
  };
}

/**
 * Apply an outcome to a COPY of a full flash image (a test helper: it never touches a model). Returns { image, unknown } where unknown marks bytes still indeterminate
 * (the given `unknownBase`, if any, plus unknown bytes of the outcome). The caller's image is not modified.
 */
export function applyToImage(image, outcome, unknownBase = null) {
  const out = Uint8Array.from(image), unk = unknownBase ? Uint8Array.from(unknownBase) : new Uint8Array(image.length);
  let i = 0;
  for (const [lo, hi] of outcome.ranges) for (let a = lo; a <= hi; a++, i++) { out[a] = outcome.bytes[i]; unk[a] = outcome.unknown[i]; }
  return { image: out, unknown: unk };
}

/**
 * A deterministic list of policies for a sweep: the two bounds, the constant fills, and `seeds` seeded random and bit-mix fills, plus prefix(0.5). The list is a TEST SET, not a
 * claim of coverage: `exhaustive` is always false and the disclaimer travels with it.
 */
export function standardSweep({ seeds = [1, 2, 3] } = {}) {
  const policies = [{ kind: "old" }, { kind: "new" }, { kind: "ff" }, { kind: "zero" }, { kind: "prefix", fraction: 0.5 }];
  for (const seed of seeds) { policies.push({ kind: "random", seed }, { kind: "bit-mix", seed }); }
  return { policies, exhaustive: false, disclaimer: DISCLAIMER };
}

/** One line for a report; always ends with the standing statement. */
export function describeOutcome(outcome) {
  const p = outcome.provenance;
  const n = outcome.bytes.length, u = outcome.unknown.reduce((s, x) => s + x, 0);
  const label = p.policy.kind === "random" || p.policy.kind === "bit-mix" ? `${p.policy.kind}(seed ${p.policy.seed})` : p.policy.kind === "prefix" ? `prefix(${p.policy.fraction})` : p.policy.kind;
  return `SYNTHETIC fill ${label} on ${p.op} (${p.profile}, ${p.timing}), ${n} bytes, ${u} still unknown. ${p.disclaimer}`;
}
