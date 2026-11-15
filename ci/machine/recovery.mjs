// Recovery scenarios for the headless harness (Component 6): what the EMULATOR shows when a firmware's flash is damaged or interrupted, and what a fresh install does.
//
// Two different things are measured and never conflated:
//
//   self-recovery       the DAMAGED flash, rebooted as it is, runs and shows a non-blank screen (watch() verdict "booted" with at least two LCD colours). It says only that the firmware
//                       started from the damaged flash. It does NOT say the firmware repaired anything: `damageRepaired` is reported separately and is false unless the firmware itself
//                       wrote the package's own bytes back into every damaged sector.
//   reinstall recovery  a FRESH machine booted from the INTACT package (no damage, no carried flash) runs and shows a non-blank screen. It says the package is good and the emulator
//                       can run it again; it is not the update loader, USB or any real installation path (docs/dev/RECOVERY-SCENARIOS.md, survey D-4).
//
// Both are statements about the emulator under named inputs, never about a physical FM-1: an interrupted flash write is also NOT a failed firmware update (no USB, no loader, no
// package transfer is modelled).
import { Fm1Machine, corruptedSectors } from "./machine.mjs";
import { watch } from "./monitor.mjs";

export const RECOVERY_VERSION = 1;
export const SELF_RECOVERY_MIN_COLOURS = 2;      // the same threshold watch() uses for "the screen shows content"

/** The verdict definitions, in the words the reports and the documentation use. */
export const RECOVERY_DEFINITIONS = {
  "self-recovery": "the damaged flash, rebooted as it is, runs (watch verdict 'booted': no CPU halt, no power cut, no lost display) and shows a non-blank screen (at least 2 LCD colours). Not a repair: see damageRepaired.",
  "no-self-recovery": "the damaged flash, rebooted as it is, halts the CPU ('crashed'), never shows content ('blank') or loses its display ('display-lost').",
  "reinstall-recovery": "a fresh machine booted from the intact package runs and shows a non-blank screen. Not the update loader, USB or a real installation.",
  "no-reinstall-recovery": "a fresh machine booted from the intact package did not boot (reported, never expected for a package that boots normally).",
};
export const RECOVERY_DISCLAIMER = "Emulator observation under a named input, not a prediction of a physical FM-1. 'Self-recovery' means the damaged flash booted, not that it repaired itself. 'Reinstall recovery' is a fresh boot of the intact package, not a firmware update: USB, the update loader and the boot area are not emulated.";

/** Self-recovery from a watch() report: booted AND a non-blank screen. Pure. */
export function isSelfRecovery(w) {
  return w.verdict === "booted" && !w.final.halted && w.final.lcdColours >= SELF_RECOVERY_MIN_COLOURS;
}

const sameBytes = (a, b, lo, hi) => { for (let i = lo; i < hi; i++) if (a[i] !== b[i]) return false; return true; };

/**
 * What became of the damage after the firmware ran. `sectors` are the damaged sector addresses, `base` the intact package flash, `after` the flash now. Pure.
 *   repaired       the firmware wrote the package's own bytes back into EVERY damaged sector (false when nothing was damaged)
 *   stillDamaged   at least one damaged sector still differs from the package
 */
export function damageState(sectors, base, after, size = 4096) {
  const same = (at) => sameBytes(after, base, at, at + size);
  return { repaired: sectors.length > 0 && sectors.every(same), stillDamaged: sectors.some((at) => !same(at)) };
}

/** What a watch() report says about a boot, reduced to what the recovery reports carry. */
function describeBoot(w) {
  return { verdict: w.verdict, haltedAtMs: w.haltedAtMs, lcdColours: w.final.lcdColours, emulatedMs: w.emulatedMs };
}

/**
 * Boot the package with the damage already in its flash (the corruption specs of flash.mjs), watch it for `seconds`, and say what the emulator showed. The damage is applied while
 * the machine is "off": the CPU never ran before it. Returns the boot report plus the evidence that the damage was real and whether the firmware repaired it.
 */
export function damagedBoot(engine, pkg, { corrupt, seconds, options = {} }) {
  const boot = { usb: false, ...options };
  const sectors = corruptedSectors(engine, pkg, corrupt, boot);
  const m = Fm1Machine.boot(engine, pkg, { ...boot, sectors });
  const base = m.baseFlash(), damaged = m.flash();
  const affected = sectors.filter((s) => !sameBytes(damaged, base, s.at, s.at + s.data.length));       // sectors whose bytes really differ from the package
  const w = watch(m, { seconds });
  const after = m.flash();
  // unchanged damage is the normal case: the firmware does not put the package's bytes back
  const state = damageState(affected.map((s) => s.at), base, after);
  return { machine: m, watch: w, damage: { sectors: affected.map((s) => s.at), applied: affected.length > 0 }, damageRepaired: state.repaired, flashStillDamaged: state.stillDamaged };
}

/** A fresh machine from the intact package: no sectors, no carried flash. The flash must equal the package's own at the start. */
export function reinstallBoot(engine, pkg, { seconds, options = {} }) {
  const m = Fm1Machine.boot(engine, pkg, { usb: false, ...options });
  const startsIntact = Buffer.compare(Buffer.from(m.flash()), Buffer.from(m.baseFlash())) === 0;
  const w = watch(m, { seconds });
  return { machine: m, watch: w, startsIntact };
}

/**
 * One corrupted-flash recovery scenario: damaged boot, then (always) a reinstall boot of the intact package. `damagedSeconds` and `reinstallSeconds` are part of the scenario
 * (a verdict is a statement about that window), never defaulted.
 */
export function runCorruptionRecovery(engine, pkg, { corrupt, damagedSeconds, reinstallSeconds, options = {} }) {
  if (!Array.isArray(corrupt) || corrupt.length === 0) throw new RangeError("a corruption scenario needs at least one corruption spec");
  if (!(damagedSeconds > 0) || !(reinstallSeconds > 0)) throw new RangeError("damagedSeconds and reinstallSeconds must be positive");
  const d = damagedBoot(engine, pkg, { corrupt, seconds: damagedSeconds, options });
  const r = reinstallBoot(engine, pkg, { seconds: reinstallSeconds, options });
  const self = isSelfRecovery(d.watch), fresh = isSelfRecovery(r.watch) && r.startsIntact;
  return {
    version: RECOVERY_VERSION,
    corrupt,
    damage: d.damage,
    selfRecovery: { recovered: self, label: self ? "self-recovery" : "no-self-recovery", ...describeBoot(d.watch), windowSeconds: damagedSeconds, damageRepaired: d.damageRepaired, flashStillDamaged: d.flashStillDamaged },
    reinstallRecovery: { recovered: fresh, label: fresh ? "reinstall-recovery" : "no-reinstall-recovery", ...describeBoot(r.watch), windowSeconds: reinstallSeconds, startsIntact: r.startsIntact },
    disclaimer: RECOVERY_DISCLAIMER,
  };
}

/** The same classification for a power-cut survey row's reboot (the chip-profile engine): booted with a non-blank screen after the cut and the explicit synthetic outcome. */
export function classifyRebootReport(reboot) {
  if (!reboot) throw new RangeError("no reboot report");
  const recovered = reboot.verdict === "booted" && reboot.lcdColours >= SELF_RECOVERY_MIN_COLOURS;
  return { recovered, label: recovered ? "self-recovery" : "no-self-recovery", verdict: reboot.verdict, lcdColours: reboot.lcdColours, haltedAtMs: reboot.haltedAtMs ?? null };
}
