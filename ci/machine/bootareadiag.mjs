// READ-ONLY machine adapter for the boot-area diagnostic (Component 7, Stage 7B). It takes an Fm1Machine that already exists and reports what bootarea.mjs says about its flash.
//
// It reads exactly three things, all through established read-only interfaces, and nothing else:
//   machine.flash()               the flash as it is now (a copy)
//   machine.baseFlash()           the flash as the package installed it = the INTACT REFERENCE (a copy)
//   machine.indeterminateRanges() the bytes physically unknown after an interrupted cycle (chip-profile engine only; none on an engine without fault injection)
// It never writes flash, arms or triggers a fault, advances a cycle, runs firmware, resets the machine, observes it (observe() clears the audio accumulators) or changes any state. It is
// not a boot gate: Fm1Machine.boot is untouched and never consults it. The result is an emulator-defined diagnostic, never a statement about a physical FM-1 (bootarea.mjs).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { classify } from "./bootarea.mjs";

export const LAYOUT_FIXTURE_PATH = resolve(import.meta.dirname, "fixtures/bootarea-layout.json");
/** The only machine methods the adapter may call (a test proves it calls nothing else). */
export const READ_ONLY_INTERFACES = Object.freeze(["flash", "baseFlash", "indeterminateRanges"]);

const sha8 = (u8) => createHash("sha256").update(u8).digest("hex").slice(0, 8);

let layoutFixture = null;
/** The committed layout fixture (structure of the catalogue's boot heads and the SPL decode status of each body), read once. */
export function loadLayoutFixture() {
  layoutFixture ??= JSON.parse(readFileSync(LAYOUT_FIXTURE_PATH, "utf8"));
  return layoutFixture;
}

/** Diagnose a flash image the caller already holds: the same as `classify`, with the SPL decode status looked up in the committed fixture. */
export function diagnoseImage(image, reference, options = {}) {
  const splDecode = options.splDecode ?? loadLayoutFixture().splDecode;
  return classify(image, reference, { ...options, splDecode, hash8: sha8 });
}

/**
 * Diagnose a machine's flash against its own package's base flash. Options: `assume` (a HYPOTHETICAL recovery assumption), `reference` (a flash image to use instead of the machine's
 * base flash; null = none, which makes the bootability verdict not-evaluable).
 */
export function diagnoseMachine(machine, options = {}) {
  const caps = machine.engine.capabilities;
  const image = machine.flash();
  const reference = "reference" in options ? options.reference : caps.flashBase ? machine.baseFlash() : null;
  const hasList = !!(caps.faultInjection && machine.flashChipInfo);
  const indeterminate = hasList ? machine.indeterminateRanges() : [];
  const { reference: _r, ...rest } = options;
  const report = diagnoseImage(image, reference, { ...rest, indeterminate });
  report.source = {
    image: "the machine's flash now",
    reference: "reference" in options ? (reference === null ? "none" : "the caller's image") : caps.flashBase ? "the machine's base flash (the package as installed)" : "none (the engine has no base flash)",
    indeterminate: hasList ? "the chip-profile engine's list" : "none (no fault-injection chip profile on this machine)",
    engine: machine.engine.name,
  };
  return report;
}
