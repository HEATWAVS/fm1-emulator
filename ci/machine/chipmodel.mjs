// Reference model of the two FM-1 SPI NOR flash chips (Puya P25Q80H reference profile, UC25HQ80).
//
// WHAT THIS IS: an executable specification and test oracle built from the datasheets (chipspec.mjs cites every
// behaviour by page and section). It is NOT wired into the running emulator, which keeps its own simpler flash
// model inside the compiled engine. Pure JavaScript; no engine, no I/O.
//
// HOW IT IS USED: one chip-select transaction at a time, with time supplied by the caller:
//     const clock = new ManualClock(); const chip = new ChipModel({ profile: "uc25hq80", clock });
//     chip.transact([0x06]);                                   // WREN
//     chip.transact([0x02, 0x00, 0x10, 0x00, 0xAA]);           // page program; WIP is now 1
//     clock.advance(1500);                                     // typical tPP for this chip
//     chip.transact([0x05], { read: 1 }).out[0];               // status: WIP is 0 again
// Time never comes from the real clock, so every run is deterministic. `timing` is "typical" (default) or
// "maximum" (stress); the datasheets print no minimum and none is invented.
//
// THE MODEL REFUSES TO GUESS: where the datasheet is silent or contradicts itself it throws
// UnspecifiedBehavior (with the behaviour id from chipspec.mjs BEHAVIORS); outside its scope it throws
// NotModeled. Status bits whose value the datasheet leaves open are reported in `unknown` (a mask).
import { PROFILES, GEOMETRY, SR, protectionRows } from "./chipspec.mjs";

export class UnspecifiedBehavior extends Error {
  constructor(id, message) { super(`${message} [unspecified by the datasheet: ${id}]`); this.name = "UnspecifiedBehavior"; this.id = id; }
}
export class NotModeled extends Error {
  constructor(id, message) { super(`${message} [not modelled: ${id}]`); this.name = "NotModeled"; this.id = id; }
}
/** Misuse of the fault-injection interface (bad trigger, nothing to cut, wrong power state). Not a datasheet matter. */
export class FaultError extends Error {
  constructor(id, message) { super(`${message} [fault: ${id}]`); this.name = "FaultError"; this.id = id; }
}
/** The chip has lost power (a power cut fired) and has not been restored: it answers nothing. */
export class PoweredOff extends Error {
  constructor(message = "the chip lost power mid-cycle and has not been restored (powerRestore())") { super(message); this.name = "PoweredOff"; }
}

/** A deterministic clock the caller moves by hand (microseconds). Any object with now() works. */
export class ManualClock {
  #us;
  constructor(startUs = 0) { this.#us = startUs; }
  now() { return this.#us; }
  advance(us) { if (!(us >= 0)) throw new RangeError("a clock only moves forward"); this.#us += us; return this.#us; }
  set(us) { this.#us = us; }
}

const BYTES = GEOMETRY.bytes;
const BP = SR.BP0 | SR.BP1 | SR.BP2 | SR.BP3 | SR.BP4;
const LB = SR.LB1 | SR.LB2 | SR.LB3;
const LOW_WRITABLE = SR.SRP0 | BP;                                  // S7..S2 (S1 WEL and S0 WIP: no effect)
const HIGH_WRITABLE = SR.SRP1 | SR.QE | LB | SR.CMP;               // S8, S9, S11-S13, S14 (S10 SUS2, S15 SUS1: no effect)
const ONE_BYTE_CLEARS = SR.CMP | SR.QE | SR.SRP1;                  // Puya p26: cleared by a one-byte WRSR

const hex = (n) => `0x${n.toString(16).padStart(2, "0")}`;
const MODELED = new Set([0x06, 0x04, 0x05, 0x35, 0x01, 0x02, 0x81, 0x20, 0x52, 0xd8, 0x60, 0xc7, 0x9f, 0x03, 0x0b, 0x4b]);
const NOT_MODELED = new Map([
  [0x50, "nm.vwren"], [0x25, "nm.asi"],
  [0x75, "nm.suspend-resume"], [0xb0, "nm.suspend-resume"], [0x7a, "nm.suspend-resume"], [0x30, "nm.suspend-resume"],
  [0xb9, "nm.deep-power-down"], [0xab, "nm.deep-power-down"], [0x66, "nm.reset"], [0x99, "nm.reset"],
  [0x44, "nm.security"], [0x42, "nm.security"], [0x48, "nm.security"], [0x5a, "nm.unique-sfdp"],
  [0x3b, "nm.multi-io"], [0xbb, "nm.multi-io"], [0x6b, "nm.multi-io"], [0xeb, "nm.multi-io"], [0xa2, "nm.multi-io"], [0x32, "nm.multi-io"],
  [0x90, "nm.electronic-id"], [0x92, "nm.electronic-id"], [0x94, "nm.electronic-id"], [0x77, "nm.burst-wrap"], [0xff, "nm.burst-wrap"],
]);
const ERASE = { 0x81: ["pe", GEOMETRY.page], 0x20: ["se", GEOMETRY.sector], 0x52: ["be32", GEOMETRY.block32], 0xd8: ["be64", GEOMETRY.block64] };

// ---- fault injection (Component 5, Stage 5B): which cycles a trigger may match. Page erase (81h), WRSR, suspend/resume, reset and brown-out are out of scope.
export const FAULT_OPS = ["program", "erase4k", "erase32k", "erase64k", "erase", "chip-erase", "any"];
const FAULT_KEYS = { program: ["pp"], erase4k: ["se"], erase32k: ["be32"], erase64k: ["be64"], erase: ["se", "be32", "be64"], "chip-erase": ["ce"], any: ["pp", "se", "be32", "be64", "ce"] };
const OUT_OF_SCOPE_OPS = new Set(["wrsr", "erase-page", "page-erase", "81h", "suspend", "resume", "reset", "brown-out"]);
const matchesOp = (selector, op) => selector === op || selector === "any" || (selector === "erase" && (op === "erase4k" || op === "erase32k" || op === "erase64k"));

export class ChipModel {
  #p; #clock; #timing; #wp; #uid; #array; #sr; #unknown = 0; #busy = null; #last = -Infinity;
  // fault injection state; entirely idle (and invisible) unless armFault()/powerCut() is used
  #fault = null; #poweredOff = false; #indet = []; #lastFault = null; #faultCount = 0; #indetReads = 0;
  #stats = { accepted: 0, completed: 0, interrupted: 0 }; #ordinal = 0;

  /**
   * profile  "puya" | "uc25hq80" (or a profile object)
   * clock    object with now() in microseconds (required: the model never reads real time)
   * timing   "typical" (default) | "maximum"
   * wp       level of the WP# pin (default true = high). Only matters when SRP1:SRP0 = 0:1.
   * image    initial 1 MiB array (default: all 0xFF). A test fixture choice, not a datasheet claim.
   * status   initial non-volatile status bits (default 0). Defaults of BP are not stated in the datasheets
   *          that were read; this is a fixture choice.
   * uid      the chip's 128-bit unique ID as the 16 bytes 4Bh transmits (byte 0 first, bits 127-120). Per device and printed in neither
   *          datasheet: a test fixture, not a datasheet claim. Without it 4Bh reports its bytes as unknown (mask 0xFF).
   */
  constructor({ profile, clock, timing = "typical", wp = true, image = null, status = 0, uid = null } = {}) {
    this.#p = typeof profile === "string" ? PROFILES[profile] : profile;
    if (!this.#p) throw new TypeError(`unknown chip profile ${String(profile)}`);
    if (!clock || typeof clock.now !== "function") throw new TypeError("a clock with now() is required: the model never reads real time");
    if (!(timing in this.#p.timingUs)) throw new RangeError(`timing must be one of ${Object.keys(this.#p.timingUs).join(", ")}`);
    if (image && image.length !== BYTES) throw new RangeError("the image must be exactly 1 MiB");
    if (uid !== null && !(uid.length === 16 && Array.from(uid).every((b) => Number.isInteger(b) && b >= 0 && b <= 255))) throw new RangeError("uid must be 16 bytes");
    this.#uid = uid === null ? null : Uint8Array.from(uid);
    if (status & ~(LOW_WRITABLE | HIGH_WRITABLE)) throw new RangeError("initial status may only set writable non-volatile bits");
    this.#clock = clock; this.#timing = timing; this.#wp = !!wp; this.#sr = status;
    this.#array = image ? Uint8Array.from(image) : new Uint8Array(BYTES).fill(0xff);
  }

  get profile() { return this.#p; }
  get timing() { return this.#timing; }
  /** Microsecond at which the running cycle ends, or null when idle (a model introspection aid, not a chip feature). */
  busyUntil() { this.#settle(); return this.#busy ? this.#busy.end : null; }

  // ------------------------------------------------------------ the one entry point
  /**
   * One chip-select transaction: `tx` bytes clocked in (opcode first), then `read` bytes clocked out.
   * `partialBits` (0-7): extra clocks beyond the last whole byte before CS# rises (CS# not on a byte boundary).
   * Returns { outcome, out, unknown }: outcome names what happened ("executed", "rejected-boundary",
   * "ignored-no-wel", "ignored-protected", "ignored-hw-protected", "ignored-busy"); out is a Uint8Array of
   * `read` bytes (null when the chip does not answer); unknown masks the bits of `out` the datasheet leaves open.
   */
  transact(txIn, { read = 0, partialBits = 0 } = {}) {
    const tx = Uint8Array.from(txIn);
    if (!tx.length) throw new TypeError("a transaction starts with an opcode");
    if (!Number.isInteger(read) || read < 0) throw new RangeError("read must be a non-negative integer");
    if (!Number.isInteger(partialBits) || partialBits < 0 || partialBits > 7) throw new RangeError("partialBits must be 0..7");
    this.#settle();
    if (this.#poweredOff) throw new PoweredOff();
    const op = tx[0];
    if (!MODELED.has(op)) this.#notModeled(op);
    if (this.#busy) return this.#duringCycle(op, tx, read);
    switch (op) {
      case 0x06: return this.#wrenWrdi(true, tx, partialBits);
      case 0x04: return this.#wrenWrdi(false, tx, partialBits);
      case 0x05: case 0x35: return this.#rdsr(op, tx, read);
      case 0x9f: return this.#rdid(tx, read);
      case 0x4b: return this.#ruid(tx, read);
      case 0x03: case 0x0b: return this.#readArray(op, tx, read);
      case 0x01: return this.#wrsr(tx, partialBits);
      case 0x02: return this.#pageProgram(tx, partialBits);
      case 0x60: case 0xc7: return this.#chipErase(tx, partialBits);
      default: return this.#erase(op, tx, partialBits);   // 81h 20h 52h D8h
    }
  }

  /** Both status bytes as a 16-bit value, read at the current time: { value, unknown }. */
  readStatus() {
    const lo = this.transact([0x05], { read: 1 }), hi = this.transact([0x35], { read: 1 });
    return { value: lo.out[0] | (hi.out[0] << 8), unknown: lo.unknown[0] | (hi.unknown[0] << 8) };
  }

  /** Inspect the array (a test aid, not a chip command). Refused while a cycle runs: its contents are unspecified then. */
  peek(addr, len = 1) {
    this.#settle();
    if (this.#poweredOff) throw new PoweredOff();
    if (this.#busy) throw new UnspecifiedBehavior("array.during-cycle", "the array contents during a program/erase cycle");
    if (!Number.isInteger(addr) || addr < 0 || len < 0 || addr + len > BYTES) throw new RangeError("peek range outside the 1 MiB array");
    if (len > 0 && this.#overlapsIndet(addr, addr + len - 1)) throw new UnspecifiedBehavior("fault.cut-contents", "bytes of an interrupted program/erase: their contents are indeterminate (use peekKnown for the known/unknown split)");
    return this.#array.slice(addr, addr + len);
  }

  /**
   * Like peek, but never refuses for indeterminate bytes: returns { bytes, unknown } where unknown[i] is 1 for a byte whose contents are indeterminate
   * (its bytes[i] is a 0 placeholder, NOT a claim). Known bytes are the array's actual contents.
   */
  peekKnown(addr, len = 1) {
    this.#settle();
    if (this.#poweredOff) throw new PoweredOff();
    if (this.#busy) throw new UnspecifiedBehavior("array.during-cycle", "the array contents during a program/erase cycle");
    if (!Number.isInteger(addr) || addr < 0 || len < 0 || addr + len > BYTES) throw new RangeError("peek range outside the 1 MiB array");
    const bytes = this.#array.slice(addr, addr + len), unknown = new Uint8Array(len);
    for (let i = 0; i < len; i++) if (this.#isIndet(addr + i)) { unknown[i] = 1; bytes[i] = 0; }
    return { bytes, unknown };
  }

  // ------------------------------------------------------------ fault injection (Stage 5B): interruption, range and indeterminate state ONLY.
  // No outcome policy and no post-interruption array contents live here (faultpolicy.mjs holds synthetic fills, kept apart on purpose).
  /**
   * Arm one deterministic power cut. { op, nth = 1, at } with op one of FAULT_OPS, nth counting the matching cycles ACCEPTED after arming, and at exactly one of
   * { atAccept: true } | { fraction } (0 <= f < 1 of the cycle's duration, floored to a microsecond) | { afterUs } (integer below the shortest duration the selector can match).
   * A cut at or after the end of the cycle would be a normal completion and is refused. Single shot; a policy is refused (it belongs to faultpolicy.mjs).
   */
  armFault(spec = {}) {
    const bad = (id, m) => { throw new FaultError(id, m); };
    if (spec === null || typeof spec !== "object") bad("fault.bad-spec", "armFault takes { op, nth, at }");
    if ("policy" in spec || "fill" in spec || "seed" in spec) bad("fault.policy-not-here", "an outcome policy belongs to faultpolicy.mjs, never to the chip model: the model only records the interruption");
    const { op, nth = 1, at } = spec;
    if (OUT_OF_SCOPE_OPS.has(op)) bad("fault.out-of-scope", `${String(op)} interruption is out of scope for this stage (page program, sector/block erase and chip erase only)`);
    if (!FAULT_OPS.includes(op)) bad("fault.bad-op", `op must be one of ${FAULT_OPS.join(", ")}`);
    if (!Number.isInteger(nth) || nth < 1) bad("fault.bad-nth", "nth must be an integer >= 1");
    if (this.#fault) bad("fault.already-armed", "a fault is already armed (disarmFault() first)");
    if (this.#poweredOff) bad("fault.use-restore", "the chip is powered off: powerRestore() before arming");
    const forms = at && typeof at === "object" ? ["atAccept", "fraction", "afterUs"].filter((k) => k in at) : [];
    if (forms.length !== 1) bad("fault.bad-at", "at must be exactly one of { atAccept: true } | { fraction } | { afterUs }");
    const minDur = Math.min(...FAULT_KEYS[op].map((k) => this.#p.timingUs[this.#timing][k]));
    if (forms[0] === "atAccept" && at.atAccept !== true) bad("fault.bad-at", "atAccept must be true");
    if (forms[0] === "fraction" && !(typeof at.fraction === "number" && at.fraction >= 0 && at.fraction < 1)) bad("fault.bad-at", "fraction must be a number with 0 <= fraction < 1 (1 would be a normal completion)");
    if (forms[0] === "afterUs" && !(Number.isInteger(at.afterUs) && at.afterUs >= 0 && at.afterUs < minDur)) bad("fault.bad-at", `afterUs must be an integer in [0, ${minDur}): at or after the end of the shortest matching cycle is a normal completion`);
    this.#fault = { op, nth, at: { ...at }, seen: 0, scheduled: false };
  }
  disarmFault() { this.#fault = null; }

  /**
   * What the fault machinery knows AT THE CURRENT CHIP TIME. Like every entry point it settles first, so a cut that is due is reported as fired (never as a pending cycle)
   * and a cycle that has completed has already updated the indeterminate set. Fully inert (all zero/empty) unless it has been used.
   */
  faultState() {
    this.#settle();
    return {
      armed: this.#fault ? { op: this.#fault.op, nth: this.#fault.nth, at: { ...this.#fault.at }, seen: this.#fault.seen, scheduled: this.#fault.scheduled } : null,
      poweredOff: this.#poweredOff,
      firedCount: this.#faultCount,
      last: this.#lastFault,
      indeterminate: this.#indet.map(([lo, hi]) => [lo, hi]),
      indeterminateBytes: this.#indet.reduce((n, [lo, hi]) => n + hi - lo + 1, 0),
      indeterminateReads: this.#indetReads,
      ops: { ...this.#stats },
    };
  }

  /**
   * Cut power NOW (harness-initiated) while a program/erase/chip-erase cycle is in flight. If a scheduled cut was already due, that cut is the one that happened and its record
   * is returned. Refused (never silently completed) when no cycle is in flight or when the cycle is of an out-of-scope kind (WRSR, page erase).
   */
  powerCut() {
    const wasOff = this.#poweredOff;
    this.#settle();
    if (this.#poweredOff) { if (wasOff) throw new FaultError("fault.already-off", "the chip is already powered off"); return this.#lastFault; }
    if (!this.#busy) throw new FaultError("fault.no-cycle", "no program/erase cycle is in flight: nothing to interrupt (use powerCycle() for an orderly power-off)");
    if (!this.#busy.meta.scope) throw new NotModeled("fault.out-of-scope", `a ${this.#busy.meta.op} cycle cannot be interrupted at this stage`);
    return this.#fireCut(this.#now(), "harness");
  }

  /** Power returns after a cut: standby, WEL = 0, WIP = 0, non-volatile status bits retained, SRP 1:0 back to 0:0. Never resumes the interrupted cycle. */
  powerRestore() {
    this.#settle();
    if (!this.#poweredOff) throw new FaultError("fault.not-off", "the chip is not powered off (a power cut has not fired)");
    this.#poweredOff = false;
    this.#busy = null;
    this.#sr &= ~(SR.WEL | SR.WIP);
    this.#unknown &= ~SR.WEL;
    if (!(this.#unknown & (SR.SRP0 | SR.SRP1)) && (this.#sr & SR.SRP1) && !(this.#sr & SR.SRP0)) this.#sr &= ~SR.SRP1;
  }

  /** Power off and on. WEL clears; SRP1:SRP0 = 1:0 returns to 0:0 (datasheet note). Not allowed mid-cycle (fault injection). */
  powerCycle() {
    this.#settle();
    if (this.#poweredOff) throw new FaultError("fault.use-restore", "the chip lost power in a cut: use powerRestore(), not powerCycle()");
    if (this.#busy) throw new NotModeled("nm.power-loss", "power loss during a program/erase/write cycle is fault injection, out of scope");
    this.#sr &= ~(SR.WEL | SR.WIP);
    this.#unknown &= ~SR.WEL;
    if (!(this.#unknown & (SR.SRP0 | SR.SRP1)) && (this.#sr & SR.SRP1) && !(this.#sr & SR.SRP0)) this.#sr &= ~SR.SRP1;
  }

  // ------------------------------------------------------------ time and cycles
  #now() {
    const t = this.#clock.now();
    if (!Number.isFinite(t)) throw new TypeError("the clock must return a finite number of microseconds");
    if (t < this.#last) throw new RangeError("the clock went backwards");
    this.#last = t;
    return t;
  }
  #settle() {
    const now = this.#now();
    // CUT PRECEDENCE: a scheduled cut is checked BEFORE completion, so a cycle whose cut time has passed can never be observed as completed,
    // however late the chip is next touched (cutAt < end always holds: armFault refuses anything that would be a normal completion).
    if (this.#busy && this.#busy.cutAt !== undefined && now >= this.#busy.cutAt) { this.#fireCut(this.#busy.cutAt, "scheduled", now); return; }
    if (this.#busy && now >= this.#busy.end) {
      const b = this.#busy;
      this.#busy = null;
      b.apply();
      this.#stats.completed++;
      this.#sr &= ~(SR.WEL | SR.WIP);            // WEL is reset by completion (both datasheets)
      this.#unknown &= ~SR.WEL;
    }
  }
  #start(kind, key, apply, unknownBits = 0, meta = { scope: false, op: kind }) {
    const startedAt = this.#now(), dur = this.#p.timingUs[this.#timing][key];
    this.#stats.accepted++;
    this.#ordinal++;
    this.#busy = { kind, end: startedAt + dur, apply, unknownBits, meta, startedAt, ordinal: this.#ordinal };
    if (meta.scope && this.#fault && !this.#fault.scheduled && matchesOp(this.#fault.op, meta.op) && ++this.#fault.seen === this.#fault.nth) {
      const at = this.#fault.at, offset = at.atAccept ? 0 : "fraction" in at ? Math.floor(at.fraction * dur) : at.afterUs;
      this.#busy.cutAt = startedAt + offset;                       // always < end
      this.#fault.scheduled = true;
    }
    return this.#result("executed");
  }

  /** The cycle in flight is interrupted: it never completes; its range becomes indeterminate; the chip is off until powerRestore(). */
  #fireCut(cutAt, source, detectedAt = cutAt) {
    const b = this.#busy, ranges = b.meta.ranges, before = [], unknownBefore = [], ifCompleted = [], unknownIfCompleted = [];
    for (const [lo, hi] of ranges) for (let a = lo; a <= hi; a++) {
      const unk = this.#isIndet(a) ? 1 : 0, pre = this.#array[a];
      before.push(unk ? 0 : pre); unknownBefore.push(unk);
      const post = b.meta.post(a, pre);                              // null: depends on an unknown byte
      ifCompleted.push(post ?? 0); unknownIfCompleted.push(post === null ? 1 : 0);          // post is null exactly when a program would land on an indeterminate byte
    }
    const record = {
      fired: true, source, op: b.meta.op, kind: b.kind, ordinal: b.ordinal, nth: source === "scheduled" && this.#fault ? this.#fault.nth : null,
      startedAt: b.startedAt, cutAt, endWouldBeAt: b.end, detectedAt, wipAtCut: true,
      profile: this.#p.name, timing: this.#timing,
      ranges: ranges.map(([lo, hi]) => [lo, hi]),
      // INPUTS for an outcome policy, not outcomes: what the range held before, and what a normal completion would have produced
      before: Uint8Array.from(before), unknownBefore: Uint8Array.from(unknownBefore),
      ifCompleted: Uint8Array.from(ifCompleted), unknownIfCompleted: Uint8Array.from(unknownIfCompleted),
      indeterminate: true,
    };
    this.#busy = null;                                               // the cycle is discarded: apply() never runs
    this.#fault = null;
    this.#poweredOff = true;
    this.#stats.interrupted++;
    this.#faultCount++;
    for (const r of ranges) this.#addIndet(r[0], r[1]);
    this.#lastFault = record;
    return record;
  }

  // ---- the indeterminate set: sorted, disjoint [lo, hi] ranges, kept beside (never inside) the array
  #isIndet(a) { for (const [lo, hi] of this.#indet) { if (a < lo) return false; if (a <= hi) return true; } return false; }
  #overlapsIndet(lo, hi) { for (const [l, h] of this.#indet) { if (l > hi) return false; if (h >= lo) return true; } return false; }
  #addIndet(lo, hi) {
    const all = [...this.#indet, [lo, hi]].sort((a, b) => a[0] - b[0]), out = [];
    for (const r of all) { const last = out[out.length - 1]; if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else out.push([r[0], r[1]]); }
    this.#indet = out;
  }
  #clearIndet(lo, hi) {
    const out = [];
    for (const [l, h] of this.#indet) { if (h < lo || l > hi) { out.push([l, h]); continue; } if (l < lo) out.push([l, lo - 1]); if (h > hi) out.push([hi + 1, h]); }
    this.#indet = out;
  }
  #result(outcome, out = null, unknown = null) { return { outcome, out, unknown }; }

  // ------------------------------------------------------------ status helpers
  #statusNow() {
    let value = this.#sr & ~SR.WIP, unknown = this.#unknown;
    if (this.#busy) {
      value |= SR.WIP;
      unknown |= this.#busy.unknownBits;
      if (this.#p.name === "uc25hq80") unknown |= SR.WEL;      // UC: WEL resets 'at some unspecified time before completion'
    }
    return { value: value & 0xffff, unknown: unknown & 0xffff };
  }
  #known(bits, id, what) {
    if (this.#unknown & bits) throw new UnspecifiedBehavior(id, `${what} depends on status bits whose value the datasheet leaves open`);
  }
  #welSet() {
    this.#known(SR.WEL, "wel.after-rejected", "the write-enable latch");
    return !!(this.#sr & SR.WEL);
  }
  #address(tx) {
    const a = (tx[1] << 16) | (tx[2] << 8) | tx[3];
    if (a >= BYTES) throw new UnspecifiedBehavior("addr.range", `address 0x${a.toString(16)} is beyond the 1 MiB array`);
    return a;
  }
  #notModeled(op) {
    if (this.#p.name === "puya" && (op === 0x15 || op === 0x31)) throw new NotModeled("nm.puya-config-register", `Configure Register command ${hex(op)}`);
    throw new NotModeled(NOT_MODELED.get(op) ?? "cmd.unknown", `opcode ${hex(op)}`);
  }

  // ------------------------------------------------------------ commands
  #duringCycle(op, tx, read) {
    if (op === 0x05 || op === 0x35) return this.#rdsr(op, tx, read);
    if (op === 0x9f) {
      if (this.#busy.kind === "wrsr") throw new UnspecifiedBehavior("id.rdid-busy-wrsr", "RDID during a write-status-register cycle");
      return this.#result("ignored-busy");
    }
    if (op === 0x03 || op === 0x0b) return this.#result("ignored-busy");
    if (op === 0x4b) throw new UnspecifiedBehavior("ruid.busy", "Read Unique ID during a program/erase/write-status cycle");
    throw new UnspecifiedBehavior("cmd.busy", `opcode ${hex(op)} issued while WIP=1`);
  }

  #wrenWrdi(set, tx, partialBits) {
    if (tx.length !== 1) throw new UnspecifiedBehavior("cmd.extra-bytes", `${set ? "WREN" : "WRDI"} followed by extra bytes`);
    if (partialBits) return this.#result("rejected-boundary");     // interpretation: 'not executed' = no state change
    if (set) this.#sr |= SR.WEL; else this.#sr &= ~SR.WEL;
    this.#unknown &= ~SR.WEL;
    return this.#result("executed");
  }

  #rdsr(op, tx, read) {
    if (tx.length !== 1) throw new UnspecifiedBehavior("cmd.extra-bytes", "RDSR followed by extra bytes");
    const s = this.#statusNow(), shift = op === 0x05 ? 0 : 8;
    return this.#result("executed", new Uint8Array(read).fill((s.value >> shift) & 0xff), new Uint8Array(read).fill((s.unknown >> shift) & 0xff));
  }

  #rdid(tx, read) {
    if (tx.length !== 1) throw new UnspecifiedBehavior("cmd.extra-bytes", "RDID followed by extra bytes");
    if (read > 3) throw new UnspecifiedBehavior("id.rdid-extra-bytes", `reading ${read} bytes with 9Fh (the ID is 3 bytes)`);
    return this.#result("executed", Uint8Array.from(this.#p.jedec.slice(0, read)), new Uint8Array(read));
  }

  /** 4Bh: opcode, four dummy bytes, then the 128-bit unique ID, byte 0 (bits 127-120) first. A read: no cycle, no state change. */
  #ruid(tx, read) {
    if (tx.length !== 5) throw new UnspecifiedBehavior("ruid.malformed", `4Bh needs exactly four dummy bytes after the opcode, got ${tx.length - 1}`);
    if (this.#p.name === "uc25hq80" && (tx[1] | tx[2] | tx[3]) !== 0) throw new UnspecifiedBehavior("ruid.dummy-values", "UC25HQ80 Table-7 lists 00H for the first three dummy bytes of 4Bh");
    if (read > 16) throw new UnspecifiedBehavior("ruid.beyond-128-bits", `reading ${read} bytes with 4Bh (the ID is 16 bytes)`);
    if (this.#uid === null) return this.#result("executed", new Uint8Array(read), new Uint8Array(read).fill(0xff));   // the value is per device and unknown to the model
    return this.#result("executed", this.#uid.slice(0, read), new Uint8Array(read));
  }

  #readArray(op, tx, read) {
    if (tx.length !== (op === 0x03 ? 4 : 5)) throw new UnspecifiedBehavior("read.malformed", `${hex(op)} needs ${op === 0x03 ? "3 address bytes" : "3 address bytes and a dummy byte"}`);
    const start = this.#address(tx), out = new Uint8Array(read);
    const unknown = new Uint8Array(read);
    let touched = false;
    for (let i = 0; i < read; i++) {
      const a = (start + i) % BYTES;                                                   // rolls over to 0 after the last address
      if (this.#indet.length && this.#isIndet(a)) { unknown[i] = 0xff; touched = true; } else out[i] = this.#array[a];   // indeterminate: unknown, not a value
    }
    if (touched) this.#indetReads++;
    return this.#result("executed", out, unknown);
  }

  // after a rejected or ignored write command: WEL (which was 1) is now unknown unless a datasheet statement says otherwise
  #rejectedBoundary(name, partialBits) {
    if (!(this.#p.name === "uc25hq80" && name === "pp" && partialBits)) this.#unknown |= SR.WEL;   // UC p12: PP mid-byte leaves WEL as it was
    return this.#result("rejected-boundary");
  }
  #ignoredProtected(name) {
    if (this.#p.name === "puya" && name === "be32") this.#sr &= ~SR.WEL;         // Puya p37: 'the WEL bit will be reset'
    else this.#unknown |= SR.WEL;
    return this.#result("ignored-protected");
  }

  #protectedRange() {
    this.#known(BP | SR.CMP, "prot.table", "the protected area");
    const bp = [SR.BP4, SR.BP3, SR.BP2, SR.BP1, SR.BP0].map((b) => (this.#sr & b ? 1 : 0));
    const rows = protectionRows(this.#sr & SR.CMP ? this.#p.protection.cmp1 : this.#p.protection.cmp0, bp);
    if (rows.length !== 1) throw new Error(`protection table is not a function for BP=${bp.join("")}`);
    return rows[0].range;
  }
  #overlapsProtected(lo, hi) {
    const r = this.#protectedRange();
    return r !== null && lo <= r.hi && hi >= r.lo;
  }

  #pageProgram(tx, partialBits) {
    if (!this.#welSet()) return this.#result("ignored-no-wel");
    if (tx.length < 5) throw new UnspecifiedBehavior("pp.min-one-byte", "a page program needs 3 address bytes and at least one data byte");
    if (partialBits) return this.#rejectedBoundary("pp", partialBits);
    const addr = this.#address(tx), page = addr - (addr % GEOMETRY.page);
    if (this.#overlapsProtected(page, page + GEOMETRY.page - 1)) return this.#ignoredProtected("pp");
    // The 256-byte page buffer: byte i lands at (A7-A0 + i) mod 256; a later byte for the same position replaces an earlier one.
    const latch = new Uint8Array(GEOMETRY.page), used = new Uint8Array(GEOMETRY.page);
    for (let i = 4; i < tx.length; i++) { const o = ((addr & 0xff) + (i - 4)) & 0xff; latch[o] = tx[i]; used[o] = 1; }
    const runs = []; for (let o = 0; o < GEOMETRY.page; o++) if (used[o]) { const r = runs[runs.length - 1]; if (r && r[1] === page + o - 1) r[1] = page + o; else runs.push([page + o, page + o]); }
    // range = the bytes the command latches (a program over an indeterminate byte leaves it indeterminate: the model does not guess a result)
    return this.#start("program", "pp", () => { for (let o = 0; o < GEOMETRY.page; o++) if (used[o]) this.#array[page + o] &= latch[o]; }, 0,
      { scope: true, op: "program", ranges: runs, dependsOnOld: true, post: (a, pre) => (this.#isIndet(a) ? null : pre & latch[a - page]) });
  }

  #erase(op, tx, partialBits) {
    const [name, size] = ERASE[op];
    if (!this.#welSet()) return this.#result("ignored-no-wel");
    if (partialBits || tx.length !== 4) return this.#rejectedBoundary(name, partialBits);
    const addr = this.#address(tx), lo = addr - (addr % size), hi = lo + size - 1;
    if (this.#overlapsProtected(lo, hi)) return this.#ignoredProtected(name);
    const opName = { 0x20: "erase4k", 0x52: "erase32k", 0xd8: "erase64k" }[op];       // 81h (page erase) is out of scope: scope false, never matched, never cut
    return this.#start("erase", name, () => { this.#array.fill(0xff, lo, hi + 1); this.#clearIndet(lo, hi); }, 0,
      opName ? { scope: true, op: opName, ranges: [[lo, hi]], dependsOnOld: false, post: () => 0xff } : { scope: false, op: "erase-page" });
  }

  #chipErase(tx, partialBits) {
    if (!this.#welSet()) return this.#result("ignored-no-wel");
    if (partialBits || tx.length !== 1) return this.#rejectedBoundary("ce", partialBits);
    const nothingProtected = this.#protectedRange() === null;     // the BP/CMP table says NONE ('None protected')
    let run;
    if (this.#p.name === "puya") {
      // Puya p24 and p38: chip erase is executed only when the BP bits are set to 'None protected'. One rule, no conflicting sentence.
      run = nothingProtected;
    } else {
      // UC25HQ80: p9 says 'None protected' and p28 says 'ignored if one or more blocks are protected', but p28 also says
      // 'executed only if all BP bits are 0'. Act only where they agree; refuse where they do not (14 of the 64 combinations).
      const bpAllZero = (this.#sr & BP) === 0;
      if (bpAllZero !== nothingProtected) {
        throw new UnspecifiedBehavior("prot.chip-erase-conflict", `chip erase with BP bits ${bpAllZero ? "all 0" : "not all 0"} but ${nothingProtected ? "no" : "some"} block protected`);
      }
      run = bpAllZero;
    }
    if (!run) return this.#ignoredProtected("ce");
    return this.#start("erase", "ce", () => { this.#array.fill(0xff); this.#clearIndet(0, BYTES - 1); }, 0,
      { scope: true, op: "chip-erase", ranges: [[0, BYTES - 1]], dependsOnOld: false, post: () => 0xff });
  }

  #wrsr(tx, partialBits) {
    if (!this.#welSet()) return this.#result("ignored-no-wel");
    const dataBytes = tx.length - 1;
    if (partialBits || (dataBytes !== 1 && dataBytes !== 2)) return this.#rejectedBoundary("wrsr", partialBits);
    this.#known(SR.SRP0 | SR.SRP1, "wrsr.hw-protection", "whether the status register may be written");
    const srp = (this.#sr & SR.SRP1 ? 2 : 0) | (this.#sr & SR.SRP0 ? 1 : 0);
    if (srp === 3) throw new UnspecifiedBehavior("srp.otp", "SRP1:SRP0 = 1:1 (one-time-program protection, special order)");
    if (srp === 2 || (srp === 1 && !this.#wp)) { this.#unknown |= SR.WEL; return this.#result("ignored-hw-protected"); }

    const old = this.#sr;
    let next = (old & ~LOW_WRITABLE) | (tx[1] & LOW_WRITABLE);
    let unknownAfter = this.#unknown;
    if (dataBytes === 2) {
      const hi = (tx[2] << 8) & HIGH_WRITABLE;
      next = (next & ~HIGH_WRITABLE) | (hi & ~LB) | (old & LB) | (hi & LB);        // LB bits only ever go 0 -> 1 (OTP)
    } else if (this.#p.name === "puya") {
      next &= ~ONE_BYTE_CLEARS;                                                    // Puya p26
    } else {
      unknownAfter |= HIGH_WRITABLE;                                               // UC: not stated
    }
    const inFlux = ((old ^ next) & (LOW_WRITABLE | HIGH_WRITABLE)) | (unknownAfter & ~this.#unknown);
    return this.#start("wrsr", "wrsr", () => { this.#sr = next; this.#unknown = unknownAfter; }, inFlux, { scope: false, op: "wrsr" });
  }
}
