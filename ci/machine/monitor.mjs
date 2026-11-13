// Watches a running Fm1Machine and says what happened to it.
//
// Verdicts (what the machine can show from the outside):
//   booted        still running at the end, and the screen shows real content (>= minColours)
//   crashed       the emulated CPU halted: it hit something it cannot execute (a firmware fault)
//   blank         running, but the screen never showed content
//   display-lost  the screen showed content, then went blank
//
// Not a verdict on purpose: "hung". A firmware sitting on a static screen waiting for a key is
// healthy, and from the outside it looks the same as one stuck in a loop. Telling them apart
// needs a stimulus (press something, expect a change) and a firmware-specific expectation.
// `activity` reports what moved so a test can make that call for its own firmware.
export const VERDICTS = ["booted", "crashed", "blank", "display-lost"];

/**
 * Run `machine` for `seconds` of emulated time, sampling every `sampleMs`, and judge it.
 * Options: seconds (default 3), sampleMs (100), minColours (2).
 */
export function watch(machine, { seconds = 3, sampleMs = 100, minColours = 2 } = {}) {
  const start = machine.observe();          // before the first instruction: the baseline for activity
  const samples = [];
  const steps = Math.ceil((seconds * 1000) / sampleMs);
  for (let i = 0; i < steps; i++) {
    machine.run(sampleMs);
    samples.push(machine.observe());
    if (machine.halted) break;
  }
  const last = samples[samples.length - 1];
  const crashedAt = samples.find((s) => s.halted);
  const maxColours = Math.max(...samples.map((s) => s.lcdColours));
  let verdict = "booted";
  if (crashedAt) verdict = "crashed";
  else if (maxColours < minColours) verdict = "blank";
  else if (last.lcdColours < minColours) verdict = "display-lost";

  return {
    verdict,
    haltedAtMs: crashedAt ? crashedAt.emulatedMs : null,
    emulatedMs: last.emulatedMs,
    final: last,
    activity: {
      screenChanges: new Set(samples.map((s) => s.lcdHash)).size - 1,   // distinct pictures after the first
      audioPeak: Math.max(...samples.map((s) => s.audioPeak)),
      audioActive: samples.some((s) => s.audioPeak > 1e-4),
      flashChanges: last.flashRevision - start.flashRevision,   // erases/programs the firmware did
      flashRevision: last.flashRevision,
      idleShare: last.emulatedMs ? +(last.idleMs / last.emulatedMs).toFixed(3) : 0,
    },
    samples,
  };
}
