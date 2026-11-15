// The curated recovery scenario catalogue (Component 6). Pure data: no engine, no I/O.
//
// Two kinds of scenario, both EMULATOR observations under named inputs (never a claim about a physical FM-1; see recovery.mjs for the verdict definitions):
//
//   CORRUPTION_SCENARIOS  damaged flash on the SHIPPED engine (no chip engine needed): the damage is applied while the machine is "off", the damaged flash is booted (self-recovery
//                         or not) and a fresh machine is booted from the intact package (reinstall recovery). `tier: "quick"` runs in `npm test`, the rest in the full tier. Every window is part of
//                         the scenario: a verdict is a statement about that window of emulated time. The firmware and the specs are the ones of the fault survey's ordinary-fault controls
//                         (docs/dev/FAULT-SURVEY.md F6, run there on the chip-profile engine), so `surveyControl` names the survey's own answer for the same input and the tests compare the two.
//   POWER_CUT_SCENARIOS   an interrupted flash cycle on the CHIP-PROFILE engine (full tier only, SKIPPED without that engine): each is one row of docs/dev/fault-survey.json (`row`), replayed
//                         exactly and compared with the committed row (ci/machine/fixtures/recovery-survey-rows.json). The outcome policy is an EXPLICIT synthetic input, never a
//                         prediction of the chip: the datasheets do not say what an interrupted cycle leaves in the array.
//
// Not in this catalogue, on purpose: a failed firmware update (USB, the update loader and the boot area are not emulated, so an interrupted flash write is NOT a failed update), anything about the physical chip.

/** Expected recovery labels: "self-recovery" | "no-self-recovery" (the damaged/interrupted flash rebooted as it is) and, for the corruption scenarios, a reinstall that always boots. */
export const CORRUPTION_SCENARIOS = [
  {
    id: "felucca-code-sector-erased", tier: "quick", firmware: "felucca", corrupt: ["erase:0x20000"], damagedSeconds: 1.0, reinstallSeconds: 0.3,
    surveyControl: { unit: "felucca/puya", key: "erase:0x20000" },
    expect: { self: "no-self-recovery", verdict: "crashed", haltedAtMs: 786, lcdColours: 1, reinstall: { verdict: "booted", lcdColours: 17 } },
    why: "A 4 KiB sector of Felucca's code, erased to 0xFF: the emulated CPU executes erased flash and halts at 786 ms (emulator engine clock). The damaged flash does not self-recover; a fresh machine from the intact package boots.",
  },
  {
    id: "quadro-fm1-code-sector-erased", tier: "quick", firmware: "quadro-fm1", corrupt: ["erase:0x20000"], damagedSeconds: 0.5, reinstallSeconds: 0.3,
    surveyControl: { unit: "quadro-fm1/puya", key: "erase:0x20000" },
    expect: { self: "self-recovery", verdict: "booted", haltedAtMs: null, lcdColours: 17, reinstall: { verdict: "booted", lcdColours: 31 } },
    why: "The same damage on quadro-fm1: the firmware never reads that sector in the window, so the damaged flash boots with a non-blank screen (self-recovery). The sector is still erased afterwards: nothing was repaired.",
  },
  {
    id: "coqui-boot-sector-zeroed", tier: "quick", firmware: "coqui", corrupt: ["zero:0x4000"], damagedSeconds: 0.3, reinstallSeconds: 0.3,
    surveyControl: { unit: "coqui/puya", key: "zero:0x4000" },
    expect: { self: "no-self-recovery", verdict: "crashed", haltedAtMs: 1, lcdColours: 1, reinstall: { verdict: "booted", lcdColours: 7 } },
    why: "The first 4 KiB of the firmware area (0x4000) zeroed: the CPU halts at 1 ms, before any frame. A reboot of the same damaged flash does not help either (see the reset test).",
  },
  {
    id: "chipbox-code-sector-erased", tier: "full", firmware: "chipbox", corrupt: ["erase:0x20000"], damagedSeconds: 1.0, reinstallSeconds: 0.3,
    surveyControl: { unit: "chipbox/puya", key: "erase:0x20000" },
    expect: { self: "no-self-recovery", verdict: "crashed", haltedAtMs: 356, lcdColours: 1, reinstall: { verdict: "booted", lcdColours: 5 } },
    why: "Chipbox, the same erase: the CPU halts at 356 ms.",
  },
  {
    id: "elixir-code-sector-erased", tier: "full", firmware: "elixir", corrupt: ["erase:0x20000"], damagedSeconds: 1.0, reinstallSeconds: 0.3,
    surveyControl: { unit: "elixir/puya", key: "erase:0x20000" },
    expect: { self: "no-self-recovery", verdict: "crashed", haltedAtMs: 316, lcdColours: 36, reinstall: { verdict: "booted", lcdColours: 36 } },
    why: "Elixir had drawn its screen (36 colours) when the CPU halted at 316 ms: a halt after content is still 'crashed', never self-recovery.",
  },
  {
    id: "melodee-code-sector-erased", tier: "full", firmware: "melodee", corrupt: ["erase:0x20000"], damagedSeconds: 1.0, reinstallSeconds: 1.0,
    surveyControl: { unit: "melodee/puya", key: "erase:0x20000" },
    expect: { self: "no-self-recovery", verdict: "blank", haltedAtMs: null, lcdColours: 1, reinstall: { verdict: "booted", lcdColours: 92 } },
    why: "Melodee keeps running but never draws: 'blank' (no halt). A running CPU with a blank screen is not a recovery.",
  },
  {
    id: "cord-code-sector-erased", tier: "full", firmware: "cord", corrupt: ["erase:0x20000"], damagedSeconds: 1.0, reinstallSeconds: 1.0,
    surveyControl: { unit: "cord/puya", key: "erase:0x20000" },
    expect: { self: "no-self-recovery", verdict: "blank", haltedAtMs: null, lcdColours: 1, reinstall: { verdict: "booted", lcdColours: 70 } },
    why: "Cord: the same as Melodee ('blank'). Cord needs about a second to draw its first screen, so its reinstall window is 1.0 s.",
  },
  {
    id: "aurora-boot-sector-zeroed", tier: "full", firmware: "aurora", corrupt: ["zero:0x4000"], damagedSeconds: 0.3, reinstallSeconds: 0.5,
    surveyControl: { unit: "aurora/puya", key: "zero:0x4000" },
    expect: { self: "no-self-recovery", verdict: "crashed", haltedAtMs: 1, lcdColours: 1, reinstall: { verdict: "booted", lcdColours: 534 } },
    why: "Aurora with the first 4 KiB of its firmware area (0x4000) zeroed halts at 1 ms, before any frame; the intact package boots (534 colours, the richest screen of the set).",
  },
  {
    id: "melodee-boot-sector-zeroed", tier: "full", firmware: "melodee", corrupt: ["zero:0x4000"], damagedSeconds: 1.0, reinstallSeconds: 1.0,
    surveyControl: { unit: "melodee/puya", key: "zero:0x4000" },
    expect: { self: "self-recovery", verdict: "booted", haltedAtMs: null, lcdColours: 92, reinstall: { verdict: "booted", lcdColours: 92 } },
    why: "Melodee boots with 0x4000 zeroed (the survey shows the same): self-recovery means the damaged flash booted, not that it was repaired (the sector stays zeroed).",
  },
  {
    id: "cord-boot-sector-zeroed", tier: "full", firmware: "cord", corrupt: ["zero:0x4000"], damagedSeconds: 1.0, reinstallSeconds: 1.0,
    surveyControl: { unit: "cord/puya", key: "zero:0x4000" },
    expect: { self: "self-recovery", verdict: "booted", haltedAtMs: null, lcdColours: 70, reinstall: { verdict: "booted", lcdColours: 70 } },
    why: "Cord boots with 0x4000 zeroed, as in the survey; again a boot of the damaged flash, not a repair.",
  },
];

/**
 * Interrupted-cycle scenarios: one committed survey row each (replayed in the full tier on the chip-profile engine, Puya, typical timing). `expect` repeats the row's readable result so the
 * catalogue stays authoritative if the survey is regenerated; `reinstall` is the fresh boot of the intact package on the same chip profile.
 */
export const POWER_CUT_SCENARIOS = [
  {
    id: "quadro-settings-program-cut-new", row: "quadro-fm1/puya/fw/program@2/f0.5/new", firmware: "quadro-fm1", policy: { kind: "new" },
    expect: { op: "program", bytesAtRisk: 208, label: "self-recovery", verdict: "booted", haltedAtMs: null, lcdColours: 180 },
    why: "The firmware's own settings write (its 2nd cycle, a 208-byte page program) cut at 50 %, the range filled as if it had completed ('new', a synthetic bound): quadro-fm1 reboots into its normal screen and writes the range again.",
  },
  {
    id: "quadro-settings-erase-cut-ff", row: "quadro-fm1/puya/fw/erase4k@1/f0.5/ff", firmware: "quadro-fm1", policy: { kind: "ff" },
    expect: { op: "erase4k", bytesAtRisk: 4096, label: "self-recovery", verdict: "booted", haltedAtMs: null, lcdColours: 180 },
    why: "The firmware's own 4 KiB erase (its 1st cycle) cut at 50 % and filled with 0xFF: it reads 2 of the unknown bytes and still boots normally.",
  },
  {
    id: "coqui-install-erase-cut-zero", row: "coqui/puya/fw/erase4k@1/f0.5/zero", firmware: "coqui", policy: { kind: "zero" },
    expect: { op: "erase4k", bytesAtRisk: 4096, label: "self-recovery", verdict: "booted", haltedAtMs: null, lcdColours: 7 },
    why: "Coqui's first 4 KiB erase cut at 50 % and zero-filled: it boots (7 colours) but its screen differs from the no-effect bound and the range is not erased again in the window (survey F1, F2).",
  },
  {
    id: "cord-erase64k-cut-old", row: "cord/puya/hx/erase64k/accept/old", firmware: "cord", policy: { kind: "old" },
    expect: { op: "erase64k", bytesAtRisk: 65536, label: "self-recovery", verdict: "booted", haltedAtMs: null, lcdColours: 12 },
    why: "CONTROL: the harness-issued 64 KiB erase at the accept, outcome 'old' (the cut had no effect on the array): Cord boots, reading 164 of the unknown bytes. This is the bound the other rows differ from, not a physical outcome.",
  },
  {
    id: "cord-erase64k-cut-ff", row: "cord/puya/hx/erase64k/accept/ff", firmware: "cord", policy: { kind: "ff" },
    expect: { op: "erase64k", bytesAtRisk: 65536, label: "no-self-recovery", verdict: "blank", haltedAtMs: null, lcdColours: 1 },
    why: "The same cut with the 64 KiB filled 0xFF: Cord keeps running but never draws ('blank'). The reinstall of the intact package boots.",
  },
  {
    id: "felucca-erase32k-cut-zero", row: "felucca/puya/hx/erase32k/f0.5/zero", firmware: "felucca", policy: { kind: "zero" },
    expect: { op: "erase32k", bytesAtRisk: 32768, label: "no-self-recovery", verdict: "blank", haltedAtMs: null, lcdColours: 1 },
    why: "A harness-issued 32 KiB erase (0x70000-0x77FFF, a block Felucca uses) cut at 50 % and zero-filled: blank screen after the reboot.",
  },
  {
    id: "felucca-erase32k-cut-bitmix", row: "felucca/puya/hx/erase32k/f0.5/bit-mix#1", firmware: "felucca", policy: { kind: "bit-mix", seed: 1 },
    expect: { op: "erase32k", bytesAtRisk: 32768, label: "no-self-recovery", verdict: "display-lost", haltedAtMs: null, lcdColours: 1 },
    why: "The same cut with each bit independently old or new (seed 1): Felucca drew something, then lost its display ('display-lost').",
  },
  {
    id: "quadro-chip-erase-cut-ff", row: "quadro-fm1/puya/hx/chip-erase/accept/ff", firmware: "quadro-fm1", policy: { kind: "ff" },
    expect: { op: "chip-erase", bytesAtRisk: 1048576, label: "no-self-recovery", verdict: "crashed", haltedAtMs: 0, lcdColours: 1 },
    why: "A chip erase cut at the accept with the whole flash 0xFF: nothing is left to run, the CPU halts at 0 ms. A statement about what the emulator does with an all-0xFF flash, not about a chip.",
  },
  {
    id: "quadro-chip-erase-cut-old", row: "quadro-fm1/puya/hx/chip-erase/accept/old", firmware: "quadro-fm1", policy: { kind: "old" },
    expect: { op: "chip-erase", bytesAtRisk: 1048576, label: "self-recovery", verdict: "booted", haltedAtMs: null, lcdColours: 180 },
    why: "CONTROL: the same cut with outcome 'old': the flash is as it was and quadro-fm1 boots.",
  },
];

/** Every survey row id the catalogue relies on, plus the units whose ordinary-fault controls it compares with. */
export const catalogueRowIds = () => POWER_CUT_SCENARIOS.map((s) => s.row);
export const catalogueUnits = () => [...new Set(CORRUPTION_SCENARIOS.map((s) => s.surveyControl.unit))];
