# Component 5: flash fault injection (design; Stage 5B, the JavaScript model and policies, implemented)

Status: **5A design approved with amendments; Stage 5B (JavaScript only) implemented 2026-11-13; 5C-5E not approved.** Written at commit `174bc80`. The amendments are in the next section and override anything below they contradict. Stage 5B changed JavaScript only (section 8); Rust, the engine patch, the pin, the built engine and the shipped WASM are unchanged.
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
| 5C | Rust engine: pre-image journal, arm/fire/PoweredOff, indeterminate range list, exports, host tests, oracle transcripts extended with cut lines; patch, pin, build | 5B | `spichip.rs`, `spiflash.rs`, `fm1-web`, `ci/engine` |
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
