# Recovery scenarios (Component 6)

Last updated: 2026-11-14. Code: `ci/machine/recovery.mjs` (verdicts and runners), `recoverycatalogue.mjs` (the scenarios), `recoveryfixture.mjs` + `fixtures/recovery-survey-rows.json` (committed survey subset), `recoverytests.mjs` (tests).

**Everything here is an emulator observation under a named input. Nothing is a statement about a physical FM-1.** An interrupted flash write is **not** a failed firmware update: USB, the update loader, package transfer and the boot area (sector 0, key sector) are not emulated (survey D-4, D5, Component 7). Failed-update emulation is deferred.

## Verdict definitions

| Label | Meaning |
|---|---|
| `self-recovery` | The **damaged** flash, rebooted as it is, runs (`watch()` verdict `booted`: no CPU halt, no power cut, no lost display) and shows a **non-blank** screen (at least 2 LCD colours). It means *the firmware started from the damaged flash*. It does **not** mean the flash repaired itself: every report also carries `damageRepaired` (the firmware wrote the package's own bytes back into every damaged sector; false in all scenarios) and `flashStillDamaged`. |
| `no-self-recovery` | The damaged flash halts the CPU (`crashed`), never draws (`blank`) or loses its display (`display-lost`). A halt after a screen was drawn (Elixir) is still `crashed`. |
| `reinstall-recovery` | A **fresh** machine booted from the **intact** package (no damage, no carried flash, no outcome) boots with a non-blank screen. It says the package is good and the emulator can run it again. It is not the update loader and not an installation. |
| `no-reinstall-recovery` | The fresh boot did not boot (never expected for these packages). |

A verdict is a statement about a **window** of emulated time; each scenario fixes its windows (e.g. Felucca halts at 786 ms, so a 0.3 s window reads `booted`: a test pins that).

## Scenarios

**Corrupted flash, shipped engine (no chip engine needed).** Same firmware and damage as the fault survey's ordinary-fault controls (FAULT-SURVEY.md F6, run there on the chip-profile engine); the survey fixture's control verdicts are compared with the shipped-engine expectations (all 10 agree).

| Scenario | Damage | Damaged flash (window) | Reinstall (window) | Tier |
|---|---|---|---|---|
| felucca-code-sector-erased | `erase:0x20000` | no-self-recovery: `crashed`, halt 786 ms (1.0 s) | booted, 17 colours (0.3 s) | quick |
| quadro-fm1-code-sector-erased | `erase:0x20000` | **self-recovery**: `booted`, 17 colours (0.5 s); sector still erased | booted, 31 (0.3 s) | quick |
| coqui-boot-sector-zeroed | `zero:0x4000` | no-self-recovery: `crashed`, halt 1 ms (0.3 s) | booted, 7 (0.3 s) | quick |
| chipbox-code-sector-erased | `erase:0x20000` | `crashed`, halt 356 ms | booted, 5 | full |
| elixir-code-sector-erased | `erase:0x20000` | `crashed`, halt 316 ms (36 colours drawn first) | booted, 36 | full |
| melodee-code-sector-erased | `erase:0x20000` | `blank` | booted, 92 (1.0 s) | full |
| cord-code-sector-erased | `erase:0x20000` | `blank` | booted, 70 (1.0 s) | full |
| aurora-boot-sector-zeroed | `zero:0x4000` | `crashed`, halt 1 ms | booted, 534 (0.5 s) | full |
| melodee-boot-sector-zeroed | `zero:0x4000` | **self-recovery**: `booted`, 92 | booted, 92 | full |
| cord-boot-sector-zeroed | `zero:0x4000` | **self-recovery**: `booted`, 70 | booted, 70 | full |

Not used on the shipped engine: all-zero flash and `zero:0x4000` on `frasil`/`modelar` (the shipped engine still has defect D-1 and aborts: pinned by the existing D-1 tests), and `zero:0x4000` on firmware that run blank (about 10 s of host time each).

**Idle reset (quick).** A healthy quadro-fm1 power-cycled while running (no write in flight) boots again with the same flash, no damage, the same screen colours and the same picture (a deterministic reset of a healthy machine). It does not involve any write; `powerCycle()` and writes are the next section.

**Reset control (quick).** A machine halted by the damaged flash (Coqui, `zero:0x4000`) is power-cycled with no corruption: it carries the same damaged flash and halts again at the same instant. A reset is not a recovery.

**Interrupted cycles, chip-profile engine (full tier; SKIPPED without the engine).** Each is one row of `docs/dev/fault-survey.json` (Puya, typical timing, 3 s reboot watch with the survey's input script), replayed exactly: the report's `reportSha256` must equal the committed row's. The outcome policy is an **explicit synthetic input**; the datasheets do not say what an interrupted cycle leaves in the array. `old` rows are controls (the cut had no effect), not physical outcomes. Each also checks reinstall recovery: a fresh Puya machine from the intact package, no unknown bytes, boots in 1.0 s.

| Scenario | Row | Reboot |
|---|---|---|
| quadro-settings-program-cut-new | quadro-fm1 firmware program (2nd cycle, 208 B), 50 %, `new` | self-recovery, 180 colours |
| quadro-settings-erase-cut-ff | quadro-fm1 firmware 4 KiB erase (1st cycle), 50 %, `ff` | self-recovery, 180 |
| coqui-install-erase-cut-zero | coqui firmware 4 KiB erase (1st), 50 %, `zero` | self-recovery, 7 (screen differs from the `old` bound; range not erased again) |
| cord-erase64k-cut-old | cord harness 64 KiB erase, accept, `old` (control) | self-recovery, 12 |
| cord-erase64k-cut-ff | same cut, `ff` | no-self-recovery: `blank` |
| felucca-erase32k-cut-zero | felucca harness 32 KiB erase (0x70000-0x77FFF), 50 %, `zero` | no-self-recovery: `blank` |
| felucca-erase32k-cut-bitmix | same, `bit-mix` seed 1 | no-self-recovery: `display-lost` |
| quadro-chip-erase-cut-ff | quadro-fm1 chip erase, accept, `ff` | no-self-recovery: `crashed`, halt 0 ms (nothing left to run) |
| quadro-chip-erase-cut-old | same cut, `old` (control) | self-recovery, 180 |

## `powerCycle()` and "reset during write" (finding)

`Fm1Machine.powerCycle()` cannot interrupt a write: a program/erase still running at the reset is treated as **completing**, and the engine changes the array at accept (D33), so the rebooted flash holds the completed result with **no** unknown bytes and no outcome. A live test pins this (a 4 KiB erase accepted, WIP true, `powerCycle()`: sector erased, `indeterminateRanges()` empty, `faultOutcome` null). The valid way to interrupt a write is a **power cut** (`armFault`/`cutPower`, Component 5): a cut records the range as indeterminate. So "reset during write" is covered only as the interrupted-cycle scenarios above, never as a `powerCycle()` scenario, and a plain reset during a write is not modelled as an interruption.

## Tiers

| Tier | Runs | Needs |
|---|---|---|
| Quick (`npm test`, 30 s hard limit) | catalogue checks, verdict truth table, damage-state logic, fixture = survey subset and agrees with the catalogue, 3 corrupted-flash scenarios, idle reset, reset control (10 tests, about 4 s) | shipped engine only |
| Full | the other 7 corrupted-flash scenarios, determinism, window dependence | shipped engine only |
| Full, chip engine | 9 interrupted-cycle scenarios + the `powerCycle()` limitation (10 tests) | the built chip-profile engine; **SKIPPED, never passed, without it** |

## Not covered

A failed firmware update, USB, the update loader and real bricking (the boot area now has an emulator-defined diagnostic, `BOOT-AREA.md`, but no recovery model and no claim about hardware); the physical chip's behaviour after an interruption; recovery paths in the firmware that need a user action the 8 s input script does not perform; firmware other than the 8 used; chips other than Puya for the interrupted-cycle scenarios (the survey shows the two profiles alike, F4); anything on macOS or Linux.
