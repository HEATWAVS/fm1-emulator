// A deterministic fault-injection scenario for the headless harness (Component 5, Stages 5D and 5E): configure a power cut, run the firmware to it, inspect what the engine recorded,
// optionally reboot with an EXPLICIT synthetic outcome and watch what the firmware does, and return one JSON-serialisable report.
//
// Determinism: the same engine, package, chip, timing, trigger, outcome policy (with its seed) and durations give a byte-identical report (no timestamps, no randomness: the
// only random fills are seeded by the caller). `reportSha256` is the hash of the rest of the report, so two runs can be compared by one string.
//
// Two origins of the interrupted cycle (Stage 5E):
//   firmware   the firmware's own program/erase (the trigger counts the cycles the firmware accepts after arming). The CPU runs during the cycle, so a firmware that erases the very
//              code it executes sees the engine's array-at-accept simplification (D33): it can crash before the cut.
//   harness    `inject`: after a warm-up the HARNESS issues one command over the SoC's SPI0 registers (the test bus), at an address the caller names, then moves the chip clock to the
//              trigger point WITHOUT running the CPU, and the cut fires. The firmware is idle during the cycle, so interrupting an erase of the executable area is observable. The data a
//              harness program writes is a labelled test input (0x00), never a claim about what a firmware writes.
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
import { LiveChip } from "./chiplive.mjs";
import { PROFILES } from "./chipspec.mjs";
import { INPUTS } from "./firmware-survey.mjs";

export const SCENARIO_VERSION = 2;
const sha = (u8) => createHash("sha256").update(u8).digest("hex").slice(0, 16);
const hex = (u8) => Buffer.from(u8).toString("hex");
const a3 = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];

/** The harness-issued commands (`inject.kind`): the opcode, the unit it puts at risk and the duration key of the chip's timing table. */
export const INJECT_KINDS = {
  program: { op: 0x02, key: "pp", size: 16 },        // a 16-byte program of 0x00 at `address` (a labelled test input)
  erase4k: { op: 0x20, key: "se", size: 4096 },
  erase32k: { op: 0x52, key: "be32", size: 32768 },
  erase64k: { op: 0xd8, key: "be64", size: 65536 },
  "chip-erase": { op: 0x60, key: "ce", size: 1 << 20 },
};

/**
 * Normalise a scenario configuration (everything the result depends on, defaults filled in). Bad input throws before anything boots.
 *   chip, timing   the flash chip profile ("puya" | "uc25hq80"); a scenario needs one
 *   fault          { op, nth, at } (fault.mjs) or null (a control run: nothing is armed)
 *   maxMs          audio time to run before giving up on the trigger (firmware-issued cycles)
 *   policy         the explicit synthetic outcome applied to the interrupted range if the scenario reboots (faultpolicy.mjs); never defaulted
 *   rebootMs       audio time to watch the firmware after the reboot (0 = do not reboot)
 *   inputs         apply the firmware survey's fixed input script (keys, MIDI, encoder, pot) to every run, before the cut and again after the reboot
 *   inject         null (the firmware's own cycle is interrupted) or { kind, address, warmupMs }: the harness issues one command (see INJECT_KINDS) after `warmupMs` and the fault's
 *                  `op` must be that kind; the chip clock then moves to the trigger point with the CPU stopped
 */
export function normalizeScenario({ chip = "puya", timing = "typical", fault = null, maxMs = 3000, policy = null, rebootMs = 0, mhz = 100, jit = false, flashUid = null, inputs = false, inject = null } = {}) {
  if (parseFlashChip(chip) === "legacy") throw new FaultHarnessError("needs-chip", "a fault scenario needs a chip profile (puya or uc25hq80)");
  const resolved = resolveFlashChipOptions({ flashChip: chip, flashTiming: timing });
  const canonicalFault = fault === null ? null : parseFaultSpec(fault).canonical;
  if (!(maxMs > 0) || !(rebootMs >= 0) || !(mhz > 0)) throw new RangeError("maxMs and mhz must be positive and rebootMs not negative");
  const canonicalPolicy = policy === null ? null : validatePolicy(policy);
  if (rebootMs > 0 && canonicalPolicy === null) throw new FaultHarnessError("outcome-required", "a scenario that reboots needs an explicit outcome policy for the interrupted range (there is no default fill)");
  let canonicalInject = null;
  if (inject !== null) {
    const kind = inject.kind;
    if (!(kind in INJECT_KINDS)) throw new FaultHarnessError("bad-inject", `inject.kind must be one of ${Object.keys(INJECT_KINDS).join(", ")}`);
    if (canonicalFault === null || canonicalFault.op !== kind) throw new FaultHarnessError("bad-inject", "an injected command needs a fault whose op is the same kind (the trigger interrupts that cycle)");
    const { address = 0x74000, warmupMs = 1500 } = inject;
    if (!Number.isInteger(address) || address < 0 || address >= 1 << 20) throw new FaultHarnessError("bad-inject", "inject.address must be an address inside the 1 MiB flash");
    if (!(warmupMs >= 0)) throw new FaultHarnessError("bad-inject", "inject.warmupMs must not be negative");
    const at = canonicalFault.at;
    // The chip clock of a harness-issued cycle moves in whole microseconds (the test hook's unit), so a cycle-exact trigger must be a whole number of them: refused, never rounded.
    if ("afterCycles" in at && at.afterCycles % mhz !== 0) throw new FaultHarnessError("bad-inject", `a harness-issued cycle moves the chip clock in whole microseconds: afterCycles must be a multiple of ${mhz} (cycles per microsecond)`);
    canonicalInject = { kind, address, warmupMs };
  }
  return { chip: resolved.chip, timing: resolved.timing, fault: canonicalFault, maxMs, policy: canonicalPolicy, rebootMs, mhz, jit: !!jit, flashUid: flashUid ?? null, inputs: !!inputs, inject: canonicalInject };
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

/** Run the machine until the chip-select line is released and no cycle is running (a harness command must not interleave with the firmware's own transaction). */
function settleChip(machine) {
  for (let i = 0; i < 400; i++) {
    if (machine.x.fm1_flash_busy() === 0 && machine.x.fm1_flash_wip() === 0) return;
    machine.run(3);
  }
  throw new FaultHarnessError("chip-busy", "the firmware kept the flash chip busy: the harness cannot issue its command");
}

/**
 * Issue one harness command, arm the trigger for it and move the chip clock to the trigger point with the CPU stopped. Returns once the cut has fired (or not: the caller reports it).
 * The trigger is armed AFTER the warm-up so only this cycle counts. `fraction`, `afterUs` and `afterCycles` are converted to whole microseconds of chip time exactly as the engine
 * converts them (floor(fraction * duration) microseconds; 100 cycles per microsecond at the harness's 100 MHz), so the cut lands on its requested cycle.
 */
function issue(machine, cfg) {
  const { kind, address } = cfg.inject, spec = INJECT_KINDS[kind];
  settleChip(machine);
  const live = new LiveChip(machine);
  machine.armFault(cfg.fault);
  live.wren();
  const base = kind === "chip-erase" ? [] : a3(address);
  live.tx([spec.op, ...base, ...(kind === "program" ? new Array(spec.size).fill(0x00) : [])]);
  const at = cfg.fault.at, durUs = PROFILES[cfg.chip].timingUs[cfg.timing][spec.key];
  let us = 0;
  if ("fraction" in at) us = Math.floor(at.fraction * durUs);
  else if ("afterUs" in at) us = at.afterUs;
  else if ("afterCycles" in at) us = at.afterCycles / cfg.mhz;                  // a whole number of microseconds (normalizeScenario refuses the rest)
  if (us > 0 && !("atAccept" in at)) live.advance(us);
}

/**
 * Run one scenario. `engine` must be a fault-injection chip-profile engine. Returns the report (see the header). Throws FaultHarnessError for unusable input; a cut that never
 * fires is a result (`outcome: "not-triggered"`), not an error.
 */
export function runFaultScenario(engine, pkg, config = {}) {
  const cfg = normalizeScenario(config);
  const inputs = cfg.inputs ? INPUTS : [];
  const inject = cfg.inject !== null;
  const machine = Fm1Machine.boot(engine, pkg, { mhz: cfg.mhz, jit: cfg.jit, usb: false, flashChip: cfg.chip, flashTiming: cfg.timing, flashUid: cfg.flashUid, fault: inject ? null : cfg.fault });
  let run;
  if (inject) {
    machine.run(cfg.inject.warmupMs);
    if (machine.halted) run = { outcome: "halted", ranMs: cfg.inject.warmupMs, record: null };
    else {
      issue(machine, cfg);
      run = { outcome: machine.powerCut ? "power-cut" : "not-triggered", ranMs: cfg.inject.warmupMs, record: null };
      if (machine.powerCut) run.record = machine.faultState().record;
    }
  } else if (cfg.fault) run = machine.runUntilCut(cfg.maxMs, { inputs });
  else {
    const pending = [...inputs];
    const step = 20;
    for (let t = 0; t < cfg.maxMs && !machine.halted; t += step) {
      while (pending.length && pending[0][0] <= t) pending.shift()[1](machine);
      machine.run(step);
    }
    run = { outcome: machine.halted ? "halted" : "ran", ranMs: cfg.maxMs, record: null };
  }
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
    origin: inject ? "harness" : "firmware",
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
    const described = { op: outcome.provenance.op, bytes: outcome.bytes.length, unknown: outcome.unknown.reduce((n, u) => n + u, 0), hash: sha(outcome.bytes), provenance: { synthetic: outcome.provenance.synthetic, disclaimer: outcome.provenance.disclaimer } };
    let w;
    try { w = watch(next, { seconds: cfg.rebootMs / 1000, inputs }); } catch (e) {
      // The ENGINE trapped (a Rust panic in the emulator, not a CPU halt of the emulated firmware). D-1 (an all-zero flash or a word access at a RAM region's edge aborting the emulator) is fixed in the
      // chip-profile engine, so nothing known traps there now; the verdict stays, so any future engine abort is never reported as a firmware result or a CPU halt (docs/dev/FAULT-INJECTION.md section 14).
      // The instance is dead, so nothing is read from it afterwards.
      if (!(e instanceof WebAssembly.RuntimeError)) throw e;
      report.reboot = { policy: cfg.policy, synthetic: true, outcome: described, verdict: "engine-trap", trap: String(e.message).slice(0, 60), haltedAtMs: null, powerCutAtMs: null, emulatedMs: null, flashChangesByFirmware: null,
        lcdHash: null, lcdColours: null, indeterminateCarriedIn: ranges, indeterminateAtEnd: null, indeterminateReads: null, flashHash: null, state: null };
    }
    if (w) {
    const after = next.faultState();
    const flash2 = next.flash();
    report.reboot = {
      policy: cfg.policy,
      synthetic: true,
      outcome: described,
      verdict: w.verdict, haltedAtMs: w.haltedAtMs, powerCutAtMs: w.powerCutAtMs ?? null, emulatedMs: w.emulatedMs,
      flashChangesByFirmware: w.activity.flashChanges,
      lcdHash: w.final.lcdHash, lcdColours: w.final.lcdColours,
      indeterminateCarriedIn: ranges, indeterminateAtEnd: after.indeterminate, indeterminateReads: after.reads,
      flashHash: sha(flash2),
      state: describeState(after),
    };
    }
  }
  const { reportSha256: _ignored, ...body } = report;
  return { ...body, reportSha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}
