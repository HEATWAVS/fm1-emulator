// A deterministic fault-injection scenario for the headless harness (Component 5, Stage 5D): configure a power cut, run the firmware to it, inspect what the engine recorded,
// optionally reboot with an EXPLICIT synthetic outcome and watch what the firmware does, and return one JSON-serialisable report.
//
// Determinism: the same engine, package, chip, timing, trigger, outcome policy (with its seed) and durations give a byte-identical report (no timestamps, no randomness: the
// only random fills are seeded by the caller). `reportSha256` is the hash of the rest of the report, so two runs can be compared by one string.
//
// Honesty: the report separates what the ENGINE knows (the cut, the cycles, the affected ranges, the indeterminate list, the images the cut left as policy INPUTS) from the
// SYNTHETIC outcome the caller chose for the reboot. The datasheets do not say what an interrupted cycle leaves in the array, so a scenario is a statement about the
// firmware's sensitivity to ONE named input, never a prediction of the physical chip, and a finite set of scenarios does not exhaust the physical outcomes.
import { createHash } from "node:crypto";
import { Fm1Machine, SAMPLE_RATE } from "./machine.mjs";
import { watch } from "./monitor.mjs";
import { parseFaultSpec, FaultHarnessError } from "./fault.mjs";
import { validatePolicy, DISCLAIMER } from "./faultpolicy.mjs";
import { resolveFlashChipOptions, parseFlashChip } from "./flashchip.mjs";

export const SCENARIO_VERSION = 1;
const sha = (u8) => createHash("sha256").update(u8).digest("hex").slice(0, 16);
const hex = (u8) => Buffer.from(u8).toString("hex");

/**
 * Normalise a scenario configuration (everything the result depends on, defaults filled in). Bad input throws before anything boots.
 *   chip, timing   the flash chip profile ("puya" | "uc25hq80"); a scenario needs one
 *   fault          { op, nth, at } (fault.mjs) or null (a control run: nothing is armed)
 *   maxMs          audio time to run before giving up on the trigger
 *   policy         the explicit synthetic outcome applied to the interrupted range if the scenario reboots (faultpolicy.mjs); never defaulted
 *   rebootMs       audio time to watch the firmware after the reboot (0 = do not reboot)
 */
export function normalizeScenario({ chip = "puya", timing = "typical", fault = null, maxMs = 3000, policy = null, rebootMs = 0, mhz = 100, jit = false, flashUid = null } = {}) {
  if (parseFlashChip(chip) === "legacy") throw new FaultHarnessError("needs-chip", "a fault scenario needs a chip profile (puya or uc25hq80)");
  const resolved = resolveFlashChipOptions({ flashChip: chip, flashTiming: timing });
  const canonicalFault = fault === null ? null : parseFaultSpec(fault).canonical;
  if (!(maxMs > 0) || !(rebootMs >= 0) || !(mhz > 0)) throw new RangeError("maxMs and mhz must be positive and rebootMs not negative");
  const canonicalPolicy = policy === null ? null : validatePolicy(policy);
  if (rebootMs > 0 && canonicalPolicy === null) throw new FaultHarnessError("outcome-required", "a scenario that reboots needs an explicit outcome policy for the interrupted range (there is no default fill)");
  return { chip: resolved.chip, timing: resolved.timing, fault: canonicalFault, maxMs, policy: canonicalPolicy, rebootMs, mhz, jit: !!jit, flashUid: flashUid ?? null };
}

/** The audit record without the raw images (hashes instead, and the bytes themselves when they are short). */
function describeRecord(record) {
  if (!record) return null;
  const short = record.before.length <= 256;
  return {
    source: record.source, op: record.op, ordinal: record.ordinal, nth: record.nth,
    acceptedAtCycle: record.acceptedAtCycle, requestedCutCycle: record.requestedCutCycle, actualCutCycle: record.actualCutCycle, endWouldBeAtCycle: record.endWouldBeAtCycle,
    ranges: record.ranges, bytesAtRisk: record.before.length,
    images: {
      before: sha(record.before), unknownBefore: sha(record.unknownBefore), ifCompleted: sha(record.ifCompleted), unknownIfCompleted: sha(record.unknownIfCompleted),
      ...(short ? { beforeHex: hex(record.before), ifCompletedHex: hex(record.ifCompleted) } : {}),
    },
  };
}

/** The state without the per-run extras: what the engine says, as plain data. */
function describeState(s) {
  const { record, ...rest } = s;
  return { ...rest, indeterminateBytes: rest.bytes };
}

/**
 * Run one scenario. `engine` must be a fault-injection chip-profile engine. Returns the report (see the header). Throws FaultHarnessError for unusable input; a cut that never
 * fires is a result (`outcome: "not-triggered"`), not an error.
 */
export function runFaultScenario(engine, pkg, config = {}) {
  const cfg = normalizeScenario(config);
  const machine = Fm1Machine.boot(engine, pkg, { mhz: cfg.mhz, jit: cfg.jit, usb: false, flashChip: cfg.chip, flashTiming: cfg.timing, flashUid: cfg.flashUid, fault: cfg.fault });
  const run = cfg.fault ? machine.runUntilCut(cfg.maxMs) : (machine.run(cfg.maxMs), { outcome: machine.halted ? "halted" : "ran", ranMs: cfg.maxMs, record: null });
  const state = machine.faultState();
  const flash = machine.flash();
  const base = machine.baseFlash();
  const ranges = state.indeterminate;
  const known = flash.slice();
  for (const [lo, hi] of ranges) known.fill(0, lo, hi + 1);
  const stop = {
    outcome: run.outcome, status: machine.status, ranMs: run.ranMs, audioMs: Math.round((machine.frames * 1000) / SAMPLE_RATE),
    powerCut: machine.powerCut, halted: machine.halted,
    cycles: state.cycles,
  };
  const report = {
    version: SCENARIO_VERSION,
    config: cfg,
    engine: { sha256: engine.wasmSha256 },
    stop,
    record: describeRecord(run.record),
    state: describeState(state),
    indeterminate: ranges,
    flash: { hashAtStop: sha(flash), knownHashAtStop: sha(known), changedSectorsAtStop: machine.changedSectors().length, baseHash: sha(base) },
    reboot: null,
    disclaimer: DISCLAIMER,
  };
  if (cfg.rebootMs > 0) {
    if (!machine.powerCut) throw new FaultHarnessError("no-cut-to-reboot", `the scenario asked for a reboot but no power cut happened (outcome ${run.outcome}): nothing to apply an outcome to`);
    const next = machine.powerCycle({ outcome: cfg.policy });
    const outcome = next.faultOutcome;
    const w = watch(next, { seconds: cfg.rebootMs / 1000 });
    const after = next.faultState();
    const flash2 = next.flash();
    report.reboot = {
      policy: cfg.policy,
      synthetic: true,
      outcome: { op: outcome.provenance.op, bytes: outcome.bytes.length, unknown: outcome.unknown.reduce((n, u) => n + u, 0), hash: sha(outcome.bytes), provenance: { synthetic: outcome.provenance.synthetic, disclaimer: outcome.provenance.disclaimer } },
      verdict: w.verdict, haltedAtMs: w.haltedAtMs, powerCutAtMs: w.powerCutAtMs ?? null, emulatedMs: w.emulatedMs,
      flashChangesByFirmware: w.activity.flashChanges,
      indeterminateCarriedIn: ranges, indeterminateAtEnd: after.indeterminate, indeterminateReads: after.reads,
      flashHash: sha(flash2),
      state: describeState(after),
    };
  }
  const { reportSha256: _ignored, ...body } = report;
  return { ...body, reportSha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}
