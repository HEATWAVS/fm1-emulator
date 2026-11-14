# Component 5: flash fault injection (design; Stage 5B, the JavaScript model and policies, implemented)

Status: **5A design approved with amendments; Stage 5B (JavaScript only) implemented and committed (`63614ad`); Stage 5C designed 2026-11-13 (section 9, approved); **5C-1 (Rust chip state) implemented 2026-11-13 (section 10)**; 5C-2, 5C-3, 5D, 5E not approved.** Written at commit `174bc80`. The amendments are in the next section and override anything below they contradict. Stage 5B changed JavaScript only (section 8); Rust, the engine patch, the pin, the built engine and the shipped WASM are unchanged.
Evidence levels as everywhere: **V** verified (the datasheet states it), **I** interpretation (a labelled reading), **X** unspecified (the datasheets are silent), **U** unknown
(not obtainable from them). Page numbers are PDF pages = printed pages. Puya = P25Q80H V1.7 ("P"), UC = UC25HQ80 v1.2 ("U").

**Purpose.** Discover how FM-1 firmware behaves when its flash is hit by an interrupted program, an interrupted erase, a power loss or a corrupted array, in the emulator, before
any risky experiment on hardware. **What this can and cannot tell us:** the datasheets do not say what an interrupted cycle leaves in the array (section 2). Every result of this
component is therefore a statement about *the firmware's sensitivity to a defined set of possible outcomes*, never a prediction of what a physical chip would hold.

## 0. Amendments approved with 5B (these override the sections below)

1. **Cut timing takes precedence over normal completion.** A scheduled cut must fire before an operation can complete normally, even if nothing touches the chip until after the cut
   time. Lazy detection at the next SPI access is **not** accepted on its own. The reference model enforces precedence at its single choke point: every entry point (`transact`, `peek`,
   `peekKnown`, `busyUntil`, `powerCycle`, `powerCut`) goes through `#settle()`, which checks the scheduled cut **before** it checks completion. For the engine (Stage 5C) the
   requirement is a proof obligation: either (a) fold the cut deadline into the SoC's next-event computation so it fires at its cycle whether or not the CPU touches the chip
   (**recommended**), or (b) route every observation path, including harness reads of the array through `fm1_flash()` (which cannot be intercepted), through a sync that applies a due cut
   first, and prove completion cannot be observed otherwise. 5C will not be approved without that proof; tests for this case exist at the model level now (`chiptests` "precedence").
2. **Physical uncertainty stays separate from synthetic outcomes.** The model records the interrupted range as **indeterminate** and never states its contents. Synthetic fills live in a
   separate module (`faultpolicy.mjs`), produce results labelled `synthetic`, and every report carries the statement that **a finite set of fills does not exhaust the possible physical
   outcomes**. Indeterminate/unknown bytes are tracked apart from known bytes (a range list beside the array, reads report them in the `unknown` mask).
3. **Determinism is mandatory:** identical initial flash, profile, timing, trigger, policy and seed give identical records, ranges and bytes (the PRNG is specified and tested).
4. **No silent default fill:** `materialize` throws without an explicit policy; the model takes no policy at all (`armFault` rejects one).
5. **Disabled means unchanged:** with no fault armed every existing behaviour, transcript and test is byte-identical (the oracle transcript hashes are pinned in a test).
6. **Scope narrowed to page program, sector erase, block erase (32 KiB and 64 KiB) and chip erase.** No WRSR interruption, suspend/resume, brown-out, reset interruption or **page erase
   (81h)**: cycles of those kinds are never matched by a trigger, and `powerCut()` on them is refused (`fault.out-of-scope`), never silently completed. Each needs its own proposal.
7. **Reference-model honesty:** the model represents interruption, affected range, indeterminate state and the post-cut power state only. It exposes the known *inputs* a policy needs
   (`before` and `ifCompleted` images, with their own unknown masks), never a post-interruption array.

## 1. What already exists (reused, not duplicated)

| Need | Existing capability | Where |
|---|---|---|
| Corrupt or modify flash | Sector records (`zero`, `erase`, `flip` with seeds) applied at boot (`sectors`), `powerCycle({ corrupt })` while "off", CLI `--corrupt`; direct writes to the live array through `fm1_flash()` (used by the live tests) | `ci/machine/flash.mjs`, `machine.mjs`, `chiplive.mjs` |
| Program/erase timing, WIP | Chip state machine with a deadline in SoC cycles (`Busy { end, kind }`), datasheet typical/maximum times, `fm1_flash_wip`, test clock hooks | `spichip.rs`, `fm1-web` exports (C0-C3) |
| Pending operation | `Busy` record inside the chip; **the array is already changed at accept (D33)**; `ops` counts accepted program/erase ops | `spichip.rs`, `spiflash.rs` |
| Power cycle | `Fm1Machine.powerCycle()` (new machine, flash carried as sector diffs, non-volatile status and the unique-ID fixture carried for the same chip, D40); `Chip::power_cycle`/`restore_nv` | `machine.mjs`, `spichip.rs` |
| A cycle running at power-off | **Treated as completing** (D40): the array already holds the final result, so today a power cut mid-cycle *silently becomes a successful operation*. This is the behaviour Component 5 must replace, explicitly | D33, D40 |
| Old upstream cut | `FM1_FLASH_CUT=N` (native only, environment variable): the Nth erase/program is half applied (first half of its bytes), later ones never reach the chip. Not available in wasm, **not honoured under a chip profile** | `spiflash.rs` (`cut_at`, `ops`) |
| Reference model | `powerCycle()` while busy throws `NotModeled("nm.power-loss")`; `peek()` during a cycle throws `UnspecifiedBehavior("array.during-cycle")` (the model already refuses to state array contents mid-cycle) | `chipmodel.mjs` |
| Halting | `Machine.halted` stops `fm1_render`; `fm1_halted` reports it; the harness verdict `crashed` is built on it | `fm1-web` |
| Reboot and recovery | `Fm1Machine.boot/powerCycle`, `watch()` verdicts, `firmware-survey.mjs`, firmware tests under each profile | C2-C4 |
| Determinism | Interpreter, cycle-count clock, repeated runs identical (verified C4), `fm1_test_*` hooks and `LiveChip` for scripted chip-level scenarios, seeded corruption | C1-C4 |
| Which firmware writes what | quadro-fm1 3 changes, melodee 6, cord 2, chipbox 52, coqui 1,229, fm1-field 3 (only with no unique ID), scintilla 3 (Puya only). The 17 surveyed firmware issued **no** suspend, reset or deep-power-down command (0 unmodelled-opcode events apart from 4Bh) | C4 |

Not present: any way to stop a machine at a chosen point of a flash cycle; a pre-operation image of the unit being changed; a record of "this range is indeterminate"; a power-loss
state distinct from `halted` (a CPU fault); a way to carry such a record across a reboot.

## 2. What the datasheets say about interruption (every page read)

Both documents were searched in full for power-loss, power-down, interrupt, abort, damage, corrupt, suspend, resume, reset and "in progress" statements (page lists in section 7).

| Question | Puya P25Q80H | UC25HQ80 | Level |
|---|---|---|---|
| **Power loss during page program, sector/block erase, chip erase: array contents afterwards** | not stated | not stated | **X** (no page in either document) |
| Power loss: what the chip does at the next power-up | "The state machine will be reset as standby mode automatically during power up" (p.15 §6) | same, "reset to standby mode" (p.10 §8) | **V**. That no interrupted cycle is resumed is the reading: **I** |
| Protection at power transitions | "designed to protect itself from these accidental write cycles" (p.15 §6): about *inadvertent* writes from false signals, not about a valid cycle that is cut | same (p.10 §8) | **V** as a statement; silent on cut cycles: **X** |
| Required power sequencing | CS# must follow VCC; ignoring the timing figures means "the device will not operate correctly" (p.13 §5.5); VCC must go below VPWD for at least tPWD to guarantee initialization (p.14) | Table-13 power-up timing (p.50; the extracted table layout is ambiguous, its numbers are not used) | **V** (exists). **U**: what a brown-out that does not reach VPWD leaves |
| WEL after power restore | cleared by power-up (p.22 §10.3, Stage A) | "automatically reset after Power-up" (p.15 §9.2) | **V**: WEL = 0 |
| SUS1/SUS2 after power restore | cleared by "a power-down, power-up cycle" (p.25) | same (p.10) | **V** |
| WIP after power restore | no statement | no statement | **X**; **I**: 0, since the state machine is reset to standby |
| Non-volatile status bits (BP, CMP, SRP, QE, LB) | retained (non-volatile) | retained; at power-up reset they are copied to a volatile copy (p.15 §9.3) | **V**. **X** if power is lost *during* a WRSR cycle (tW) |
| Reset (RSTEN 66h + RST 99h) during program/erase | "the operation will be disabled, the data under processing could be damaged or lost" (p.53 §10.40) | "the operation will be disabled and the data under processing could be damaged or lost" (p.43 §9.37) | **V** that damage or loss is possible; resulting contents **X**. Recovery time tReady 30 us (program/erase) and a WRSR figure (p.10 Table 5-3; the printed "12 8 ms" row is ambiguous); UC value not extracted |
| Suspend and resume | Program/erase suspend 75h/B0h, resume 7Ah/30h; while suspended the array is readable *except* the page/sector/block being operated on; after resume the operation "will continue until finished" (p.51-53 §10.36-38) | same (p.40-42 §9.33-35) | **V**. Power loss while suspended: **X**. Not modelled by the chip today (`nm.suspend-resume`) |
| Deep power-down | ignores all commands except release (p.15 §6); RDP/RES "no effect on the current cycle" (p.46) | ignores all commands until release (p.10 §8); a DP command during a cycle "is rejected without having any effects on the cycle" (p.34) | **V** (UC): deep power-down cannot interrupt a cycle. Puya's DP-during-cycle: **X** |
| Interrupted write-status register | not stated | not stated | **X** |
| Neighbouring pages or sectors disturbed by an interrupted cycle | not stated | not stated | **X** (modelled as unaffected only as an explicit labelled assumption) |
| Endurance and retention | numbers printed | 100K cycles, 20 years (p.1, p.4) | **V**, irrelevant here |

**Known unknowns (not obtainable from these sources):** array contents of an interrupted program, page, sector, block or chip erase; whether the unit reads as old data, erased,
partly programmed/erased, or varies from read to read; whether anything outside the unit changes; the post-power-up status after an interrupted WRSR; behaviour of a brown-out
shallower than VPWD; whether a second interruption during recovery behaves differently. General NOR-flash physics (a program only clears bits, an erase only sets them) is *not stated in
the datasheets for this purpose* and is used only inside an explicitly labelled synthetic policy, never as a claim about the parts.

## 3. Design: how tests request a failure

### 3.1 Concepts
- **`powerCycle()`** (exists): an *orderly* power-off between operations. A cycle still running is treated as completing (D40). Unchanged.
- **Power cut** (new): power is lost **while a program/erase/chip-erase/WRSR cycle is in flight**. The cycle does **not** complete. What the array holds afterwards is decided by an
  explicit **policy** (section 4), never silently. Restoring power afterwards is a separate step (`powerRestore()`).
- A cut that finds no cycle in flight is an error unless the test says it is a plain power-off (`powerCycle`).

### 3.2 Trigger (deterministic, in chip time = SoC cycles, not wall time or audio quanta)
```js
fault: {
  op:      "program" | "erase4k" | "erase32k" | "erase64k" | "erase-page" | "chip-erase" | "wrsr" | "erase" | "any",   // which accepted operations count
  nth:     3,                       // the 3rd matching operation accepted after arming (1-based; counts the engine's own ops counter)
  at:      { fraction: 0.5 }        // or { afterUs: 1200 } or { atAccept: true }; fraction must be in [0, 1) and afterUs below the cycle's duration
  policy:  { kind: "indeterminate", fill: "old" | "new" | "ff" | "zero" | "random", seed: 7 }   // required: there is NO default (section 4)
}
```
- `atAccept` = fraction 0: the cut lands the instant the command is accepted (CS# rise). `fraction >= 1` or `afterUs >= duration` is **refused** at arm time (it would be a normal completion).
- Durations are the profile's typical or maximum figures (`flashTiming`), so the same scenario means different absolute times on Puya and UC25HQ80 and for typical vs maximum.
- The firmware run is selected by package + options + input script; the engine is deterministic (verified), so the same fault request reproduces the same cut instant, range and result.
- Harness: `Fm1Machine.boot(engine, pkg, { flashChip: "puya", fault })`, `machine.runUntilCut(maxMs)` (returns the fault record or **throws `FaultNotTriggered`** if the budget ends first),
  `machine.faultState()`, `machine.powerCut()` (harness-initiated cut at the present chip time, for firmware that never touches the chip again), `machine.powerRestore({ ... })`
  (boots the next machine from the post-cut flash). CLI: `--fault op:nth:at:policy`.

### 3.3 How the cut is made exact without stopping the CPU mid-instruction
The CPU can change flash only through SPI0. So the cut can be **applied lazily at the first chip access at or after the cut time** (SPI/chip-select write, WIP/status read, or the
harness's own export call) and is equivalent for everything that survives a power loss: nothing the firmware does between the cut instant and its next chip access can reach the chip.
The engine records the exact cut cycle and the cycle at which it was detected; on detection the machine enters a **power-cut state** (renders stop, as for `halted`, but with a distinct
reason so it is never reported as a CPU `crashed`), the chip ignores everything, and the record is available to the harness. Alternative considered: a scheduled periph event for exact
CPU stop; rejected as unnecessary (it edits upstream timing code for no observable gain) but listed as option B in decisions.

### 3.4 Preventing a fault from silently becoming a successful operation
1. The engine keeps a **pre-image journal** of the unit being changed (at most 64 KiB; 1 MiB for chip erase; copied at accept). Today the array is already final at accept (D33); the
   journal is what makes "old" recoverable.
2. The cut is a distinct chip state (`PoweredOff`): the pending `Busy` record is **discarded without completing**, counted as `ops_interrupted`, never added to `ops_completed`.
3. The fault record exposes `fired`, `op`, `lo/hi`, `startedAt`, `cutAt`, `endWouldBeAt`, `wipAtCut`, `policy`, `detectedAt`. **Tests must assert `fired === true`, `cutAt < endWouldBeAt`,
   `wipAtCut === true`** and that the affected range equals the policy's expected image, not the normal-completion image (except for the control policy `new`).
4. `runUntilCut` throws if no fault fired; `powerRestore` refuses to run without a fired fault or an explicit `plain: true`; `run()` on a cut machine throws.
5. `powerCycle()` while a cycle is in flight is unchanged by default; an opt-in `strictPower: true` makes it throw, so a test cannot mistake it for a cut.
6. With no fault armed, nothing runs: byte-identical behaviour and exports unchanged for all existing flows (regression test, section 5).

## 4. Design: simulation policy

Three layers, never mixed in the reports:

| Layer | Content | Authority |
|---|---|---|
| **A. Datasheet-supported** | At power-up the state machine is in standby (no cycle resumes), WEL = 0, SUS = 0, non-volatile status bits retained; the unit being operated on is the only thing at risk (the commands' own ranges); a reset during an operation may damage or lose "the data under processing" | **V/I** (section 2) |
| **B. Required approximation** | The array contents of the affected unit are **indeterminate**. The engine marks the range indeterminate (a range list, carried across the reboot), counts firmware **reads that touch it** (`indeterminateReads`, with the first offset), and fills it with a **caller-chosen** fill so the CPU has bytes to read | **X**: no fill is claimed to be physical |
| **C. Optional synthetic scenarios** | Named fills for exploring recovery: `old` (the operation had no effect), `new` (completed: the *control*, equal to a normal success), `ff`, `zero`, `random(seed)`, and the bounded `bit-mix(seed)` (each bit independently old or new value, the only place NOR program/erase direction is used) and `prefix(f)` (first fraction of the range new, rest old: the upstream `FM1_FLASH_CUT` "half" convention) | **Synthetic, labelled as such in every result** |

Rules: **no default fill**: the API requires one, so nothing is chosen silently. The recommended *first* mode is `indeterminate` + a **sweep**: run the identical scenario under several fills
(`old`, `new`, `ff`, `zero`, a few seeded `random`/`bit-mix`); if the firmware's outcome (boots, halts, resulting flash, screen) is the same under all of them the firmware is **robust to
every outcome we can name**; if it differs, it is **sensitive**, and the report says which fills break it. Outside the affected unit nothing changes (a labelled assumption: **X**).
Interrupted WRSR: non-volatile bits `old` or `new` by explicit policy only (stage later). Legacy profile: not supported (no cycle duration exists; `atAccept` before/after op N could be added trivially if wanted).

## 5. Test plan

**Layers.** L1 reference model + pure policy functions (JS, milliseconds, mutation-tested); L2 Rust host tests (policy functions, journal, state machine; same transcripts); L3 live chip tests
over `LiveChip` (no firmware, controlled clock); L4 firmware scenarios with sweeps; L5 regression.

| Scenario | Variants | Assertions (all layers unless noted) |
|---|---|---|
| Program interruption | cut at accept, 25%, 50%, 99%; Puya and UC25HQ80; typical and maximum | fault fired; `cutAt < endWouldBeAt`; WIP was 1; range = the 256-byte page's written bytes; image equals the policy's expected image and **differs** from normal completion (except `new`); indeterminate range recorded; unit-outside bytes identical to pre-image |
| Sector erase (4 KiB), 32 KiB and 64 KiB block erase interruption | same grid | same, range = the whole unit; neighbours untouched |
| Chip erase interruption | same grid (chip level only; no surveyed firmware issues it) | range = whole array; journal 1 MiB |
| Page erase `81h` | same | as above |
| Interrupted WRSR (later stage) | `old`/`new` explicit | non-volatile bits per policy; status after restore |
| Power restoration and reboot | restore → boot the same package | WEL = 0, WIP = 0, SUS = 0, non-volatile bits kept (A-layer facts); flash image = post-cut image; unique-ID fixture and options carried |
| Old vs new chip | every case on both profiles | durations and therefore absolute cut times differ; outcomes compared |
| Repeated deterministic runs | each scenario twice (and across `random` seeds) | identical cut instant, range, image, firmware outcome |
| Firmware scenarios | quadro-fm1 (settings save, 3 ops), melodee (6), cord (2), chipbox (52), coqui (1,229 install ops, sampled cut points), fm1-field (no-ID path) | boot/halt verdict, screen, resulting flash, whether the firmware read indeterminate bytes (`indeterminateReads`), re-run determinism, sweep robust/sensitive classification; a second power cut during recovery (cut again at the n-th op of the next boot) |
| Regression, faults disabled | arm nothing | the whole existing suite unchanged; flash hashes of the C4 survey runs byte-identical; `fault` options absent from default JSON; engine exports additive; arming with `fraction >= 1` refused; `powerCycle()` mid-cycle behaves as before |
| Negative controls | mutation controls | e.g. cut applied after completion, journal not restored for `old`, range off by one unit, neighbour byte altered, `new` differing from normal completion, indeterminate read not counted, sweep missing a policy, cut silently ignored |

## 6. Stages and dependencies (each needs approval)

| Stage | Work | Depends on | Touches |
|---|---|---|---|
| 5A | This design | - | docs only |
| 5B | Spec and reference model: `fault.*` behaviours in `chipspec.mjs` (all **X** except the datasheet-supported layer), `ChipModel.powerCut(policy)` returning the affected range and an indeterminate flag (never an invented image), pure policy functions (`faultpolicy.mjs`: old/new/ff/zero/random/bit-mix/prefix, seeded PRNG) with literal tests and mutation controls | 5A | JS only |
| 5C | **(design in section 9, not approved)** Rust engine: pre-image journal, arm/fire/PoweredOff, indeterminate range list, exports, host tests, oracle transcripts extended with cut lines; patch, pin, build | 5B | `spichip.rs`, `spiflash.rs`, `fm1-web`, `ci/engine` |
| 5D | Harness: `fault` option, `runUntilCut`, `powerCut`, `powerRestore`, `faultState`, CLI, carrying the indeterminate list across the reboot, `FaultNotTriggered`, live chip tests | 5C | `ci/machine` |
| 5E | Firmware scenarios and the sweep tool (`fault-survey.mjs`), results and limits documented | 5D | `ci/machine`, docs |
| 6 (existing plan) | Scenario/recovery tests in `npm test` build on 5E | 5E | - |

## 7. Risks and unresolved design decisions

**Risks.** (1) The physical outcome is unknown, so results are exploratory (mitigated by labelling every result and by the sweep). (2) Indeterminate data can steer firmware arbitrarily; the
sweep reveals sensitivity but cannot bound it. (3) Lazy detection requires the firmware or the harness to touch the chip again; mitigated by `powerCut()`. (4) The journal adds engine state
and a small copy per operation (negligible; chip erase 1 MiB once). (5) The cut halting must be a new state, not `halted`, or a power cut would be reported as a firmware crash. (6) The
boot area (sector 0, key sector) is still not emulated (D5/Component 7): a cut there cannot reproduce a real brick. (7) Brown-outs shallower than VPWD, suspended operations and
reset-during-operation are datasheet-visible but out of the first stages. (8) Harness-level power cycling carries flash as sector diffs: the indeterminate list needs its own channel.

**Decisions for you.**
1. **Policy API:** require an explicit fill (recommended) versus a default such as `indeterminate`+`old`.
2. **Lazy cut detection** (recommended) versus an exact scheduled stop (option B).
3. **Scope of 5B-5D:** program and the erase kinds first, WRSR and reset-during-operation later (recommended), or all at once.
4. **Which synthetic fills** ship: the six listed in section 4 (recommended) or a smaller set.
5. **`prefix(f)`** reuses upstream's "half applied" convention: keep as a named synthetic fill (recommended) or drop.
6. **`powerCycle()` mid-cycle:** keep today's behaviour with an opt-in `strictPower` (recommended) or make it an error by default.
7. **Legacy profile:** unsupported (recommended) or add an op-boundary-only cut.
8. **Reference model:** extend `ChipModel` with `powerCut` returning only the range and an indeterminate flag (recommended), so the oracle never states an array image.

## Method and negative result
Every page of both PDFs was searched as text for: power loss/off/down/fail/supply, interrupt, abort, corrupt, damage, unexpected, suspend, resume, reset, VWI/VPWD, retention,
"in progress" and "rejected". The pages with hits were then read in full (Puya p.8-11, 13-15, 18-22, 24-28, 36-39, 45-46, 50-53; UC25HQ80 p.1, 4, 7-10, 12-18, 25-28, 34-35, 39-44, 50),
the suspend, reset and power-up pages as rendered text. **No sentence in either document states the array contents after an interrupted cycle.** The statements in section 2 are
the complete set relevant to interruption. Numeric power-sequencing values were not used (the UC25HQ80 table's extracted layout is ambiguous).

## 8. Stage 5B as implemented (JavaScript only, 2026-11-13)

**Files.** `ci/machine/chipmodel.mjs` (interruption support), `ci/machine/chipspec.mjs` (10 `fault.*` behaviours with page citations), `ci/machine/faultpolicy.mjs` (new: synthetic fills,
never touches a model), `ci/machine/faulttests.mjs` (new: 42 tests, registered by `chiptests.mjs`; one full-tier regression test registered by `selftest.mjs`).

**Model API (`ChipModel`).** `armFault({ op, nth, at })`: `op` one of `program`, `erase4k`, `erase32k`, `erase64k`, `erase` (any sector/block), `chip-erase`, `any`; `nth` the n-th matching
accepted cycle (1-based); `at` one of `{ atAccept: true }`, `{ fraction: f }` with 0 <= f < 1 (cut at `floor(f * duration)` after the cycle starts) or `{ afterUs: n }` with 0 <= n < the shortest duration.
A trigger carrying `policy`, `fill` or `seed` is refused. `disarmFault()`, `powerCut()` (immediate cut of the running in-scope cycle), `powerRestore()`, `faultState()` (settles first, then reports
armed/fired, op counters, powered-off flag, indeterminate ranges and the last record), `peekKnown(addr, len)` (bytes plus an unknown mask), and `peek` which **throws
`UnspecifiedBehavior("fault.cut-contents")`** over indeterminate bytes. While powered off `transact` throws `PoweredOff`.

**What a cut does.** The cycle's effect is discarded (its `apply` never runs); the affected range (latched byte runs of a page program, the whole unit of an erase, the whole array of a chip
erase) becomes **indeterminate**; WIP and WEL clear; the non-volatile status bits survive; the record holds `before` and `ifCompleted` as policy **inputs** (each with its own unknown mask) and
no post-interruption array. Reads of indeterminate bytes answer the unknown mask `0xFF` and are counted. A later complete erase over the range clears it; a page program over indeterminate
bytes leaves them indeterminate (`fault.program-over-indeterminate`, unspecified).

**Cut precedence (requirement 1).** A scheduled cut is stored with its cycle (`cutAt`). `#settle()` checks `now >= cutAt` **before** it checks completion and every entry point settles, so
a cut due before the cycle end fires even if the clock jumped past the end with no chip access; `faultState()` also settles. Tests: clock jumped far past completion with no access (all four kinds,
both profiles, typical and maximum timing, every trigger form); `cutAt = end - 1` observed at `end`; `cutAt = end` rejected as a trigger; control runs without a fault complete normally.
The engine proof obligation (section 0, item 1) stays open for 5C.

**Policies (`faultpolicy.mjs`).** `materialize(record, policy)` requires an explicit policy (no default; `random` and `bit-mix` also need an explicit seed). Fills: `old`, `new` (the control, equal
to a normal completion), `ff`, `zero`, `random(seed)`, `bit-mix(seed)`, `prefix(fraction)`. PRNG: mulberry32, one draw per record byte, top byte, independent of unknown bytes; frozen vectors were
computed with an independent implementation. Where an output depends on an unknown input byte it is marked unknown with a 0 placeholder. Every outcome carries `provenance.synthetic = true` and
the disclaimer; `standardSweep()` returns `exhaustive: false`. `applyToImage` works on a copy.

**Limitations (unchanged by 5B).** No engine support: nothing here changes what the emulator or a firmware run does (5C-5E not approved). The model's cut is the model's clock, not the SoC's.
Neighbouring-byte immunity is an assumption (`fault.neighbours`). WRSR, page erase 81h, suspend/resume, reset during a cycle and brown-out are out of scope (`fault.out-of-scope`, refused).
The synthetic fills are test inputs: none is a prediction of the physical chip and the set does not exhaust the physical possibilities.

## 9. Stage 5C investigation and design (Rust engine; approved; implemented stepwise: 5C-1 done, section 10)

Written 2026-11-13 at commit `63614ad`. Read-only investigation of the isolated source tree `ci/engine/out/src` (pinned upstream v0.3.0 plus `chip-profiles.patch`). No Rust, patch, pin, engine build,
WASM or firmware-project file was modified. Labels: **F** = fact read from the source (file and function named), **P** = proposal, **L** = limitation, **T** = test.

### 9.1 What the source shows

| # | Finding |
|---|---|
| F1 | The chip is **passive**. `Chip::settle()` (`spichip.rs`) compares `self.now` with `Busy.end`; `now` is set by `set_clock()` from `periph.cycles` immediately before each SPI0 / chip-select access (`lib.rs` `Region::Gpio` 0x500c0 and `Region::Spi0` write paths, and `SpiFlash::wip`). Nothing wakes the chip when its deadline passes. |
| F2 | **D33:** the array is changed at accept, inside `page_program`, `erase` and `chip_erase`, then `start()` records `Busy { end: now + cycles(us), kind, .. }`. `SpiFlash::set_cs` stores `changed` and bumps `revision`; `Soc::sync_xip()` (called right after those writes) copies the range into the XIP window. **No pre-image exists.** |
| F3 | `Chip::power_cycle()` with a cycle running logs `nm.power-loss` and does nothing; `nv_status()` treats a running WRSR as completing. Today a cut mid-cycle silently becomes a success (D40). |
| F4 | The clock (`periph.cycles`) advances at: `Periph::tick()` (+1 per instruction), `Soc::add_ticks()` (JIT and `run_fast`, bounded by `tick_room() = next_due - cycles - 1`), `Periph::advance()`, `Periph::idle()` (jumps to `next_event() - 1`), the loop skip (`machine.rs` `cycles += k*l`, bounded by `next_due`), `periph.rs` ~l.786 (bounded by `next_event()`), `Soc::advance(k)` for a core held by the other, and the test hook **`fm1_test_advance_us`, which adds to the counter and processes no event**. |
| F5 | Timed devices are exact because every deadline is an input of `Periph::next_event()`; `advance()` does work once `cycles >= next_due`; every skipping mechanism above is bounded by `next_due` / `next_event()`; `next_due = 0` forces a recompute (used by `usb_plug` and others). The existing host tests compare cycle counts with and without the loop skip and the JIT (`run_both*`). One caveat: `run_blocks` carries a due tick across calls (`pending_tick`), so at the **end** of a `fm1_render` call the clock can sit exactly at a deadline whose processing has not happened yet. |
| F6 | Flash content is observed by: (a) SPI0 reads through `Chip::transfer(&mem, ..)`; (b) the **XIP window** (`soc.xip`, used for instruction fetch and read through a raw pointer by the JIT), refreshed only by `sync_xip` from `flash.changed`; (c) `Region::XipFlash` data reads of `flash.mem`; (d) the harness: `fm1_flash()` returns a raw pointer; `machine.mjs flash()` copies it on demand, `chiplive.mjs mem()` is a live view. Harness reads can only happen **between** exports (single-threaded wasm, every export runs to completion). |
| F7 | `Chip::power_cycle`, `nv_status`, `restore_nv` and the harness `powerCycle()` (new machine, flash carried as sector diffs) exist; there is no state for "power is off", no list of unknown bytes, no stop distinct from `Machine.halted`. |
| F8 | `run_cpu1` runs core 1 after core 0's slice (`SLICE` = 1024 instructions) and **does not advance the clock: "time stands still while core 1 runs"** (comment in `run_cpu1`). So core 1 observes the state at the cycle where core 0's slice ended. |

### 9.2 Answers to the questions

**1. Cut precedence.** Yes, reachable without relying on lazy SPI access. A cut is a *scheduled event* in the SoC's existing event machinery (P1) and, as a second line of defence, the chip itself never lets completion win over a due cut (P2).

**2. Every observation path.** Lazy detection at SPI access covers only F6(a). It does **not** cover (b) the XIP window and the JIT's raw xip pointer, (c) XipFlash data reads, or (d) the harness: a firmware that programs a page, spins for longer than the cycle and then reads the data back through XIP (or the harness that reads `fm1_flash()` after a render) never touches the chip again and would see the *completed* result after the cut time. The scheduled event closes (b) and (c) at the exact cycle; the export-exit sync (P4) closes (d) including the pending-tick caveat of F5; the slice-boundary sync (P4) closes core 1 (F8). **`fm1_flash()` itself needs no interception: no code runs between the last export and the harness read, so an export that leaves the engine consistent leaves every later read consistent.** The earlier statement that this path "cannot be intercepted" was about a *held* pointer and is superseded by this argument; it holds only if **every** export that moves the clock syncs on return (enumerated in P4, enforced by a test that lists the exports).

**3. Can the existing clock and execution architecture guarantee it?** Yes. The deadline is added to `next_event()`; the fast path, JIT, idle skip and loop skip are already bounded by it. No new execution mechanism is needed. What is new is only (i) one more event source, (ii) the stop, (iii) the sync points.

### 9.3 Proposal

**P1. Scheduled cut event.** `periph.rs`: field `flash_cut_at: u64` (default `u64::MAX`), `next_event()` takes the minimum, `advance()` sets `Due.flash_cut` when `cycles >= flash_cut_at`. `lib.rs`: `Soc::advance()` handles `Due.flash_cut` like `usb_frame`; the glue after `flash.set_cs()` / `flash.write()` copies a newly scheduled `cut_at` into `periph.flash_cut_at` and sets `periph.next_due = 0`. With no cut armed the field stays `u64::MAX`: `next_event()` is unchanged.

**P2. Chip state and precedence** (`spichip.rs`, mirrors `chipmodel.mjs`). New state: `fault: Option<Arm>` (op selector, nth, trigger), `Journal` of the running cycle (op, ranges, `before`, `if_completed`, their unknown masks, ordinal, started_at, cut_at, end), `indet: Vec<(usize,usize)>` normalised exactly like `#addIndet/#clearIndet` (sorted, merged), `powered_off`, counters `accepted/completed/interrupted`, `indet_reads`. The journal is captured **after validation and before the array is mutated** in the three accept paths (`page_program`, `erase` for 20h/52h/D8h only, `chip_erase`); WRSR and 81h never match. A journal is taken only for a matching armed cycle, so the disabled path adds one `is_none()` test. `settle()` checks the due cut **before** completion and, because it has no `&mut mem`, leaves the cycle running and flags `cut_due`; the cut is *performed* by `fire_cut(&mut mem)`, called by the SoC. Completion can therefore never win, even from a caller that forgot to sync. The indeterminate list is cleared by a complete erase **at completion** (not at accept) so mid-cycle observation matches the model. A cut: discards the cycle, restores the pre-image into the range as an explicitly labelled **placeholder**, appends the range to `indet`, clears WIP/WEL, keeps the non-volatile bits, sets `powered_off`, stores the record.

**P3. Stop.** `machine.rs` `run_blocks`: after the due events at the top of the loop, `if soc.flash.cut_fired() { return Err(POWER_CUT) }` (propagated by the existing `?` through `run_dual`, which also skips core 1). `fm1-web` `Machine::run` maps that error to a new `power_cut` flag, **not** `halted`, so a cut is never reported as a CPU fault; `fm1_render` produces silence and runs no CPU while it is set. The power cut is terminal for that machine; 5D reboots and carries flash and the list.

**P4. Sync points (`Soc::sync_flash_cut()`, idempotent, fires only a due cut).** (1) every `SpiFlash` entry point (`set_clock`, `set_cs`, `write`, `wip`); (2) the return of every export that moves the clock: `fm1_render`, `fm1_test_advance_us`, `fm1_test_bus_*`; (3) `run_dual` after core 0's slice and before `run_cpu1` (F8). It touches only the flash, the XIP window and the flags, so calling it early cannot reorder other events.

**P5. Placeholder, outcome and unknown (requirement 5).** The raw bytes of an indeterminate range are *never* a claim. After a cut they hold the pre-image only so the array is defined; the **indeterminate list is the authority** and stays after any fill. The harness applies an explicit synthetic outcome (bytes produced by `faultpolicy.mjs` from the exported record) through `fm1_fault_apply`; the list is unchanged by it (a fill does not make bytes known). Firmware reads of listed bytes return the byte present and are **counted** (`indet_reads`, the engine analogue of the model's unknown mask `0xFF` and read counter, in the style of `uid_unknown_reads`, D50). The engine has no default fill and never chooses contents.

**P6. Engine interface (about 12 exports, 60 to about 72; names are a proposal).** `fm1_fault_arm(op, nth, at_kind, at_value: f64)`, `fm1_fault_disarm`, `fm1_fault_cut` (immediate), `fm1_fault_restore` (chip-level power-up for tests and oracle replay), `fm1_fault_state(which)`, `fm1_fault_record(which)` (pointer or length of `before`, `if_completed` and the two masks), `fm1_fault_range(i, which)`, `fm1_fault_apply(ptr, len)`, `fm1_fault_set_ranges(ptr, len)` (carry-in for 5D), `fm1_flash_events(4)` (indeterminate reads). `fraction` crosses as `f64` so `floor(f * duration_us)` is the same IEEE computation as in JavaScript; the duration comes from the same generated tables. Cut cycle = `now_at_accept + cycles(offset_us)` with the existing rounding-up `cycles()`; the trigger is refused unless `cut_at < end` (the model's rule). Unsupported: the legacy profile and no chip (arm returns an error).

**P7. Files** (all inside the existing patch mechanism; `pin.json` patch hash and workspace list change; generated tables do not): `spichip.rs` (state, journal, cut, list, unit tests), `spiflash.rs` (`fire_cut`, `sync`, schedule hand-off, apply), `lib.rs` (Soc glue, `sync_flash_cut`), `periph.rs` (event source: **new to the patch**), `machine.rs` (stop and slice sync: **new to the patch**), `fm1-web/src/lib.rs` (exports, `power_cut`), `tests/chip_oracle.rs` (fault replay). Estimate: 450 to 600 lines of Rust plus tests. The smallest implementation that keeps cut precedence for XIP, JIT and harness reads must touch `periph.rs` and `machine.rs`; lazy-only designs avoid them and are therefore not acceptable (9.2).

**Alternatives rejected.** (B) Lazy chip detection plus sync at export exits: leaves the firmware running past the cut with completed data visible through XIP, violating requirement 1. (C) Intercepting `fm1_flash()`: impossible and unnecessary (9.2). (D) Reusing `halted` for the cut: would report power loss as a CPU crash (design risk 5).

### 9.4 Preserving behaviour when fault injection is disabled

No journal, no scheduled event (`flash_cut_at = u64::MAX`, the added `min` is a no-op), `sync_flash_cut` returns at its first test, the `run_blocks` check reads one bool. Evidence required before 5C can be accepted: **T-D1** the three oracle transcript hashes unchanged and the existing Rust host tests (61 / 7 / 8 / 49 / 4) unchanged; **T-D2** the default-profile lockstep comparison against the shipped engine repeated with the new build (the 51-run protocol of Stage C: every observable at every checkpoint); **T-D3** an armed-then-disarmed and a never-matching trigger leave a full firmware run byte-identical (flash hash, LCD hash, audio hash, cycle count, halted); **T-D4** all existing live tests; **T-D5** a runtime cost check against the previous chip engine (target: within noise; the Stage C figure was at most about 10% for the profile itself).

### 9.5 Matching the JavaScript reference model

`ci/engine/gen-transcripts.mjs` gains **fault scenarios** (the oracle is the JS model): every in-scope kind x both profiles x typical and maximum x trigger forms (atAccept, fractions 0 / 0.25 / 0.5 / 0.99 / 1/3 / 0.999, afterUs 1 and duration-1) x then restore, reads of the range, a program over the range, an erase over it, status checks. Each scenario carries the expected record (op, ordinal, cut_at, range list, SHA-256 of `before` and `if_completed`, masks), the list after each step, counters, WIP/status and non-volatile status. **T-M1** the Rust host test replays them through `Chip` + `SpiFlash` + `Periph` on a cycle clock; **T-M2** the live replay does the same over the built wasm; **T-M3** the bytes `fm1_fault_apply` writes for every fill of `faultpolicy.mjs` equal `applyToImage` on the model's record (the engine never computes a fill). A powered-off access: the model throws `PoweredOff`; the engine answers `0xFF` and counts it (`powered_off_accesses`); the oracle maps one to the other explicitly.

### 9.6 Tests and mutation controls

**Precedence (the case the requirement names).** **T-P1** program a page, jump the clock far beyond the cycle end with `fm1_test_advance_us` and **no chip access**, then read `fm1_flash()`: it shows the cut state and the list, not the completion (every kind, both profiles, both timings, every trigger form). **T-P2** CPU-driven (Rust host test with a small code image): after the accept the program only spins; the cut fires at exactly `cut_at` with the loop skip on and off, the JIT on and off, idle skip, and a render boundary; instruction count and cycle at the stop are identical across configurations and equal the unskipped run; a following XIP read of the range sees the cut result. **T-P3** `cut_at = end - 1` observed at `end`; a trigger at or beyond `end` refused. **T-P4** a render call ending with the due tick still pending (F5). **T-P5** core 1 slice (F8). **T-P6** the export list test: every export that can move the clock is on the sync list. **T-P7** a power cut is reported as `power_cut`, never `halted`.
**Determinism.** Same flash, profile, timing, trigger and firmware give identical records and memory on repeat runs (full image hash), run in both tiers.
**Mutation controls** (engine; the build scripts the edit, runs the tests and restores byte for byte, as for 4Bh): event not folded into `next_event()`; completion checked before the cut; `settle()` ignores `cut_due`; sync missing in `fm1_test_advance_us`, at the `fm1_render` exit, at the slice boundary, in an `SpiFlash` entry point; cut one cycle late (`>` for `>=`); journal captured after the mutation; the whole page instead of the latched runs; erase not clearing the list at completion; list cleared at accept; list normalisation broken; non-volatile status lost on cut; WEL kept; cut reported as `halted`; arm leaking into a disabled run; counters; `f64` fraction rounded up; `apply` clearing the list. Target: all caught; any survivor analysed (equivalent mutant or missing test), as in 5B.

### 9.7 Limitations of the proposal

- **L1** The cut lands on the first instruction boundary with `cycles >= cut_at` (the SoC charges one cycle per instruction); the model's `cut_at` is exact in microseconds, the engine's in cycles with the existing round-up. The record carries the scheduled cycle, not the stop cycle.
- **L2** D33 stays: between accept and the cut the array and the XIP window already show the completed data (the model calls this unspecified: `peek` throws). Harness code must not read a busy range as meaningful; 5D's reader refuses it.
- **L3** Raw `fm1_flash()` bytes inside the list are placeholders or synthetic inputs and cannot be masked; consumers must use the list.
- **L4** Power loss is terminal for the SoC; the same-instance chip-level restore exists for tests only. A realistic reboot belongs to 5D.
- **L5** Core 1's execution relative to the cut is exact only because the clock stands still during its slice and the slice-boundary sync runs first (F8); this must be proved by T-P5 in the first sub-step, not assumed.
- **L6** The patch surface grows by two upstream files; the pin, the patch hash and the engine build change. The shipped `fm1_web.wasm` does not.
- **L7** Out of scope stays out: WRSR interruption, page erase, suspend/resume, reset during a cycle, brown-out, the boot area, the legacy profile.
- **L8** Physical outcomes remain unknown; fills are synthetic inputs and a finite set does not exhaust them (unchanged).

### 9.8 Staging inside 5C (each step reviewable; all need your approval to start)

1. **5C-1 chip state** (`spichip.rs` only, plus oracle transcript extension): arm, journal, cut, list, precedence at `settle()`, host tests on a standalone `Chip` with an explicit clock and memory; T-M1.
2. **5C-2 scheduling and stop** (`periph.rs`, `lib.rs`, `machine.rs`, `spiflash.rs`): event source, stop, sync points; the proof tests T-P2 to T-P6, **including the first investigation of core 1 (L5)**; T-D1.
3. **5C-3 exports and live tests** (`fm1-web`, harness-side live tests only; no `machine.mjs` option, that is 5D): `fm1_fault_*`, T-P1, T-P7, T-M2, T-M3, determinism, engine mutation controls, T-D2 to T-D5, pin/patch/build, documentation.

### 9.9 Decisions requested

1. **Scheduled cut event in `periph.rs` / `machine.rs`** (recommended; required by requirement 1) versus a lazy design (not acceptable, 9.2).
2. **Placeholder = pre-image**, with the list as the authority and no engine-side fill (recommended), versus the completed image.
3. **Power cut terminal for the machine** (recommended) with reboot in 5D.
4. **`f64` fraction and `afterUs` across the export boundary**, offsets rounded by the existing `cycles()` (recommended).
5. **Powered-off accesses answered `0xFF` and counted** (recommended) versus a trap.
6. **Core 1:** investigate in 5C-2 and stop for your review if the slice-boundary sync is not sufficient.

## 10. Stage 5C-1 as implemented (Rust chip state only, 2026-11-13)

Approved scope: the chip-state portion of the section 9 design. **Not implemented (5C-2 and 5C-3):** SoC scheduling (`periph.rs`, `machine.rs`, `lib.rs` glue), the stop/`power_cut` machine flag, the sync points, exports, harness options, live firmware scenarios. Nothing that the SoC, the CPU or a firmware run can reach has a new
observable behaviour: no export arms a cut, so with the engine as built only Rust host tests can.

**Files** (all inside the pinned patch mechanism): `crates/fm1-soc/src/spichip.rs` (state, journal, cut, list, 26 new unit tests), `crates/fm1-soc/tests/chip_oracle.rs` (replay of the fault transcript by the chip driver), `ci/engine/gen-transcripts.mjs` (`--with-fault`, opt-in), `ci/engine/build.mjs` (passes `--with-fault` to `--test`), `ci/engine/chip-profiles.patch` and `pin.json` (new patch hash and artifact hash).
**Unchanged:** `spiflash.rs`, the SoC `lib.rs`, `periph.rs`, `machine.rs`, `fm1-web` (the 60 exports are exactly the same), `chipspec.mjs` (so the generated tables hash is the same), the JavaScript reference model, the shipped `fm1_web.wasm`.

**Chip API** (`fm1_soc::spichip`): `FaultOp` (`Program`, `Erase4k`, `Erase32k`, `Erase64k`, `Erase`, `ChipErase`, `Any`: page erase 81h, write-status and everything else in section 0 item 6 cannot be named), `FaultAt` (`AtAccept`, `Fraction(f64)`, `AfterUs(u32)`), `FaultSpec`, `FaultRecord`, `FaultState`, `FaultError` (ids as in the model: `fault.bad-nth`, `fault.bad-at`, `fault.already-armed`, `fault.use-restore`, `fault.no-cycle`, `fault.already-off`, `fault.not-off`, `fault.out-of-scope`, plus the engine-only `fault.not-enabled`); `Chip::arm_fault`, `disarm_fault`, `set_fault_injection`, `power_cut`, `power_restore`, `sync_cut`, `fault_state`, `indeterminate`.

**Semantics mirrored from the model** (checked by the oracle replay, section 10.1): trigger validation and its order; matching (`erase` = 20h/52h/D8h, `any`, `nth` counts only matching in-scope cycles, 81h and WRSR never match); the cut offset (`floor(f * duration_us)` in the same IEEE arithmetic, `AfterUs`, accept), always before the end; **precedence at the chip's single choke point**: `settle()` tests a due cut before completion, so a cut that is due can never be overtaken by completion whatever the caller does; ranges (latched runs of a program including the page wrap, the unit of an erase, the whole array); pre-image and what a normal completion would have produced, each with its own unknown mask (a program over an already indeterminate byte is unknown); the indeterminate list (sorted, disjoint, adjacent ranges merged, a later complete erase clears its range **at completion**, a completed program does not); reads of listed bytes counted once per transaction; WEL/WIP clear and non-volatile status kept on restore; counters (`accepted` and the ordinal count every cycle, write-status and page erase included, as in the model); a harness cut returns the scheduled record if one was already due; single shot.

**Preserving the pre-image without inventing outcomes.** D33 changes the array at accept. When journaling is on, the chip captures `before` (known bytes, unknown mask) **before** the array is changed and `if_completed` right after, for the affected ranges only. A cut never computes a result: it discards the cycle, marks the ranges indeterminate and keeps the two images as **inputs** for an outcome policy. `sync_cut(&mut mem)` writes the pre-image back into the cut range as a labelled **placeholder** (known-before bytes only) so the array is defined; the list remains the authority and is untouched by it. There is **no fill, no random byte and no default** in the engine: a fill is an explicit harness policy (`faultpolicy.mjs`, never imported here).

**Deliberate differences from the model** (all tested): (1) times are SoC cycles; the cut is clamped to the cycle before the end, which only matters below 1 MHz (tested at 1 kHz); (2) while powered off every SPI byte is answered `0xFF` and counted (`powered_off_accesses`) instead of throwing `PoweredOff`; (3) `power_cut()` needs journaling to have been on when the cycle was accepted (`arm_fault` or `set_fault_injection(true)` turn it on); a cycle accepted earlier is refused with `fault.not-enabled`, never faked; (4) `power_cycle()` after a cut is ignored and counted (`power_cycle_refused`) instead of throwing; (5) reads of indeterminate bytes return the byte the array holds there and are counted (the model returns the unknown mask `0xFF`); (6) the model computes `before` at cut time, the chip at accept (equal, since nothing can change the array during a cycle).

**Not guaranteed yet (5C-2).** In 5C-1 the chip notices a due cut whenever it is next looked at (any entry point, or `fault_state()`), and it can never complete a due cycle instead. Nothing yet makes the SoC look at the chip at the cut time: the scheduled event, the stop and the sync points of section 9 are what make the cut visible through XIP, the JIT and harness reads at the right instant. Until then a host test must move the clock and look.

### 10.1 Tests and evidence
- **Unit tests** (`spichip::fault_tests`, 26 new; the 10 earlier chip tests pass unchanged): a due cut beats completion with the clock jumped past the end and **no chip access** (both profiles, typical and maximum, five kinds, nine trigger forms, with a no-fault control per case); the cut lands at exactly its cycle (one cycle before: not fired); a trigger at or beyond the end is refused; at-accept; a wrapped page program's runs and both images with literals computed by a separate script; a sector erase and a chip erase (hashes computed independently); the placeholder is the pre-image and the list stays; the list merges and splits like the model; a completed program leaves the list, a completed erase clears it at completion and not one cycle earlier; a program over indeterminate bytes keeps them unknown; reads counted once per transaction; powered-off behaviour (all bytes answered `FF` and counted, non-volatile status kept, WEL/WIP clear); restore never resumes the cycle; arming validated in the model's order; arming while off refused; `nth` and selectors; WRSR and 81h refused (`fault.out-of-scope`) and left to complete; a harness cut needs journaling; an already due scheduled cut is the one that happened; single shot; the clamp at 1 kHz; the `erase` selector does not match a chip erase; a harness cut carries no `nth` while a trigger is armed; the placeholder leaves unknown pre-image bytes alone (the last three were added after the first mutation run showed they were unguarded).
- **Normal-operation regression:** `disabled_fault_injection_changes_nothing` runs a 14-cycle script (programs and all four erase kinds including 81h, status reads, reads) four ways (never armed; journaling on; armed but never matching; armed then disarmed) on both profiles with identical array, status, reads, counters; **determinism:** identical runs give identical records, lists and memory (`PartialEq` on the whole state).
- **Oracle replay (the model is the oracle):** `gen-transcripts.mjs --with-fault` adds 296 interrupted-operation scenarios (both profiles, both timings, five kinds, nine trigger forms plus a boundary scenario, harness cuts at four offsets, refusals, `nth`/selector scenarios and cuts over cuts); the chip driver replays them with **3,220 fault steps and 0 mismatches** (arm, power cut, restore, state snapshots, full records with hashes of the four images, `OFF` answers, final known-byte hashes, array windows beside the range). The register driver skips them (it cannot arm a cut before 5C-2). The earlier 392 scenarios are replayed by both drivers as before; **the three default transcript hashes are byte-identical to the baseline** (pinned by a full-tier test), the new transcript is deterministic and pinned.
- **Mutation controls on the Rust chip:** **37 of 38 caught** (a script edits `spichip.rs`, runs the unit tests and, for any survivor, the oracle replay, then restores the file byte for byte; precedence broken or one cycle late, fraction rounded up, `afterUs`/`nth` off by one, selectors too wide (any kind; erase matching chip erase), pre-image taken after the change, whole page instead of latched runs, range one byte long, a neighbour marked, nothing marked, erase not clearing at completion, program clearing, reads uncounted or counted per byte, a powered-off chip answering, WEL kept or non-volatile status lost on restore, an interrupted cycle counted as completed, wrong `cut_at`, `fault_state` not settling, no placeholder or a placeholder over unknown bytes, out-of-scope cut allowed, 81h in scope, arming twice, fraction 1 and `afterUs` = duration accepted, program over unknown treated as known, unknown not marked in the pre-image, ordinal or accepted not counted, ranges not merged or not split, a harness cut reporting an `nth`, the low-clock clamp removed). The first run left four survivors; three were missing tests (added, now caught). **One survivor is an equivalent mutant:** keeping the finished cycle's journal after completion (it is never read without a running cycle and the next accept replaces it) has no observable effect, so no test can distinguish it.
- **Build and suites:** the patch regenerated from the edited tree reproduces it on a clean upstream export (the build re-applies it); artifact sha256 `0a08cd3b1fcfcb44a73317ac0045ada64fc599655fa836caae043c51836726da` (2,732,347 bytes; the previous engine was `2d4d3037...5c5c`, 2,722,805 bytes: only unit tests were added after the first 5C-1 build, so the artifact did not change again), 60 exports exactly as pinned; Rust host tests all pass (fm1-core 61, 7, fm1-soc lib 78 = 52 + 26 new, oracle replay 4, 8); the patch is 0 CR, no whitespace warnings; `npm test` and the JavaScript tiers: full tier with the rebuilt chip engine 232/232 (278 s) and the transcript-baseline test (re-run after pinning the fault transcript) pass; `npm test` PASS.
- **Not repeated in 5C-1:** the 51-run default-profile lockstep comparison against the shipped engine (T-D1/T-D2 of section 9.4): 5C-1 adds no SoC-reachable path other than counter increments, and that comparison is scheduled for 5C-3 when the engine first gains observable fault behaviour; the full tier's firmware tests (C4) and the live oracle replay did run on the rebuilt engine.
