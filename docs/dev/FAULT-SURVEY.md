# Fault survey (Component 5, Stage 5E)

What the **emulator** does when its flash chip loses power in the middle of a program or erase and the unit is rebooted. Data: `docs/dev/fault-survey.json` (3,365 scenarios, every row re-runnable, engine `28dacdb4...764e`);
tool: `ci/machine/faultsurvey.mjs` (reuses the firmware survey's 17 firmware, packages and input script); design and engine: FAULT-INJECTION.md.

> **Engine.** These results were produced by the chip-profile engine **after the D-1 fix** (artifact `28dacdb4...764e`, below). The first 5E run, on the engine before it (`70796e01...b785`), differed from this one in exactly 72 rows: the 68
> chip-erase scenarios under `zero` and `random` seed 2 and the 4 `zero:0x4000` controls of `frasil` and `modelar`, which trapped the emulator then (D-1) and are ordinary results now; the other 3,297 scenarios and every other control were identical.

> **Read this first.** The datasheets do not say what an interrupted program or erase leaves in the array (FAULT-INJECTION.md section 2), so nothing here is a statement about a physical chip. Every
> scenario reboots with one **named synthetic outcome** (a test input): `old` (the cycle had no effect), `new` (it completed), `ff`, `zero`, `prefix`, seeded `random` and `bit-mix`. A firmware that boots
> under an outcome is **not** shown to recover on hardware, and one that fails under an outcome is **not** shown to fail on hardware. The matrix below is fixed and finite; it is **not exhaustive** and a
> finite set of outcomes cannot exhaust the physical possibilities. What is observed is the emulator: the verdict of the run after the reboot, the screen, the flash, and the engine's own record.

## Coverage (the fixed matrix; also recorded in the results file)

| Dimension | Covered | Not covered |
|---|---|---|
| Firmware | the 17 bundled packages of the firmware survey (`firmware-survey.mjs` `DEFAULT_SET`) | anything else; user-triggered saves the 8 s script does not cause |
| Chip profile | Puya P25Q80H (reference) and UC25HQ80, **typical** timing | maximum timing; the legacy model (it has no cycle to interrupt) |
| Run before the cut | the firmware survey's fixed 8 s input script (keys, MIDI, encoder, pot), 100 MHz, interpreter, USB off | other inputs, other durations, the JIT |
| Interrupted cycles | **firmware-issued** (the firmware's own cycles; 11 of the 34 units issue any: 7 firmware on Puya, 4 on UC25HQ80) and **harness-issued** (the harness issues the command after a 1.5 s warm-up, then moves the chip clock to the cut with the CPU stopped; all 34 units) | block and chip erase issued by a firmware (none issued one in the window) |
| Cycle kinds | page program, 4 KiB sector erase (firmware- and harness-issued), 32 KiB and 64 KiB block erase and chip erase (**harness-issued only**) | page erase 81h, write-status, suspend/resume, reset during a cycle, brown-out (out of scope, section 0 of FAULT-INJECTION.md) |
| Interruption points | firmware-issued: at the accept, 25 %, 50 %, 75 %, 99.9 % of the cycle; harness-issued: at the accept, 50 %, 99.9 % | the points in between; interruptions during the status polling are not distinguished |
| Which cycle | firmware-issued: for each kind the firmware issues, its first and its last probed cycle (probes at its 1st, 2nd, 3rd, 4th, 6th, 10th, 20th, 50th, 100th, 300th, 1000th cycle); harness-issued: the sector the firmware first wrote, else 0x74000 | the other cycles of a firmware that issues many (coqui issues 1,212 in the window) |
| Outcome policies | all of them: `old`, `new`, `ff` at every point; `zero`, `prefix(0.5)`, `random` and `bit-mix` with two seeds each at the middle point (firmware-issued: first cycle of each kind; harness-issued: every kind); `random` seed 1 at every harness point | every other seed; fills that are not in the policy module |
| After the reboot | watch 3 s with the same input script; verdict, screen vs a fresh boot and vs the `old` bound, flash vs the `old` bound, reads of unknown bytes, whether the unknown range was erased again, firmware flash writes | longer behaviour; user-visible correctness beyond "the screen is the same" |
| Controls | per unit: no fault (8 s), a fresh reboot (3 s, the baseline), two ordinary flash faults that are **not** power cuts (`erase:0x20000`, `zero:0x4000`) | |
| Determinism | 190 rows (one per origin/kind/policy plus every 25th) re-run in fresh processes: **190 of 190 identical report hashes** | the other 3,175 rows were run once |

Scenario counts: 645 firmware-issued and 2,720 harness-issued (34 units x 5 kinds x 16 = 80 each). **Every one of the 3,365 triggers fired** (no cut was missed, none was preceded by a CPU halt) and in every one the
cut fired **exactly** at its requested cycle (requested = actual); the bytes at risk were exactly the unit: 16 (program), 4,096, 32,768, 65,536 or 1,048,576.

## Results (emulator observations)

Columns: `booted`/`crashed`/`blank`/`display-lost` = the watch verdict after the reboot (`crashed` = the emulated CPU halted); `engine-trap` = the **emulator itself trapped** (a Rust panic, not a CPU halt; **0 rows now**, see D-1 in the Findings);
`screenMatchesFreshBoot` = the final screen equals a fresh boot of the package's flash; `comparedWithOld`/`sameScreenAsOld`/`sameFlashAsOld` = against the same scenario under the `old` bound (the cut left the flash as
it was), which separates "the outcome mattered" from "the firmware does that anyway"; `readUnknownBytes` = rows in which the firmware read bytes the cut left unknown (the engine counts them); `rangeErasedAgain` = the
unknown range was erased again by the firmware before the end of the window; `firmwareWroteAfterReboot` = the firmware wrote flash after the reboot.

### By chip profile

| group | scenarios | cutFired | notTriggered | haltedBeforeCut | booted | crashed | blank | display-lost | engine-trap | screenMatchesFreshBoot | comparedWithOld | sameScreenAsOld | sameFlashAsOld | readUnknownBytes | rangeErasedAgain | firmwareWroteAfterReboot |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| puya | 1768 | 1768 | 0 | 0 | 1516 | 221 | 29 | 2 | 0 | 1188 | 1403 | 888 | 379 | 638 | 482 | 641 |
| uc25hq80 | 1597 | 1597 | 0 | 0 | 1345 | 221 | 29 | 2 | 0 | 1037 | 1277 | 817 | 177 | 326 | 277 | 435 |

### By chip profile, origin and interrupted cycle kind

| group | scenarios | cutFired | notTriggered | haltedBeforeCut | booted | crashed | blank | display-lost | engine-trap | screenMatchesFreshBoot | comparedWithOld | sameScreenAsOld | sameFlashAsOld | readUnknownBytes | rangeErasedAgain | firmwareWroteAfterReboot |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| puya / firmware / erase4k | 156 | 156 | 0 | 0 | 156 | 0 | 0 | 0 | 0 | 138 | 116 | 113 | 110 | 120 | 132 | 135 |
| puya / firmware / program | 252 | 252 | 0 | 0 | 252 | 0 | 0 | 0 | 0 | 191 | 182 | 172 | 134 | 96 | 129 | 181 |
| puya / harness / chip-erase | 272 | 272 | 0 | 0 | 51 | 221 | 0 | 0 | 0 | 42 | 221 | 0 | 0 | 51 | 6 | 6 |
| puya / harness / erase32k | 272 | 272 | 0 | 0 | 269 | 0 | 2 | 1 | 0 | 209 | 221 | 158 | 23 | 96 | 52 | 78 |
| puya / harness / erase4k | 272 | 272 | 0 | 0 | 272 | 0 | 0 | 0 | 0 | 212 | 221 | 157 | 54 | 96 | 55 | 84 |
| puya / harness / erase64k | 272 | 272 | 0 | 0 | 244 | 0 | 27 | 1 | 0 | 185 | 221 | 132 | 16 | 83 | 53 | 73 |
| puya / harness / program | 272 | 272 | 0 | 0 | 272 | 0 | 0 | 0 | 0 | 211 | 221 | 156 | 42 | 96 | 55 | 84 |
| uc25hq80 / firmware / erase4k | 93 | 93 | 0 | 0 | 93 | 0 | 0 | 0 | 0 | 75 | 68 | 65 | 65 | 57 | 90 | 93 |
| uc25hq80 / firmware / program | 144 | 144 | 0 | 0 | 144 | 0 | 0 | 0 | 0 | 93 | 104 | 104 | 72 | 51 | 67 | 119 |
| uc25hq80 / harness / chip-erase | 272 | 272 | 0 | 0 | 51 | 221 | 0 | 0 | 0 | 45 | 221 | 0 | 0 | 39 | 6 | 6 |
| uc25hq80 / harness / erase32k | 272 | 272 | 0 | 0 | 269 | 0 | 2 | 1 | 0 | 213 | 221 | 170 | 7 | 48 | 28 | 54 |
| uc25hq80 / harness / erase4k | 272 | 272 | 0 | 0 | 272 | 0 | 0 | 0 | 0 | 215 | 221 | 170 | 20 | 48 | 29 | 58 |
| uc25hq80 / harness / erase64k | 272 | 272 | 0 | 0 | 244 | 0 | 27 | 1 | 0 | 182 | 221 | 139 | 0 | 35 | 28 | 47 |
| uc25hq80 / harness / program | 272 | 272 | 0 | 0 | 272 | 0 | 0 | 0 | 0 | 214 | 221 | 169 | 13 | 48 | 29 | 58 |

### By synthetic outcome policy

| group | scenarios | cutFired | notTriggered | haltedBeforeCut | booted | crashed | blank | display-lost | engine-trap | screenMatchesFreshBoot | comparedWithOld | sameScreenAsOld | sameFlashAsOld | readUnknownBytes | rangeErasedAgain | firmwareWroteAfterReboot |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| bit-mix#1 | 190 | 190 | 0 | 0 | 148 | 34 | 4 | 4 | 0 | 118 | 190 | 116 | 28 | 43 | 38 | 56 |
| bit-mix#2 | 20 | 20 | 0 | 0 | 20 | 0 | 0 | 0 | 0 | 18 | 20 | 20 | 15 | 9 | 14 | 18 |
| ff | 685 | 685 | 0 | 0 | 571 | 102 | 12 | 0 | 0 | 432 | 685 | 460 | 229 | 192 | 192 | 264 |
| new | 685 | 685 | 0 | 0 | 571 | 102 | 12 | 0 | 0 | 422 | 685 | 450 | 176 | 192 | 172 | 234 |
| old | 685 | 685 | 0 | 0 | 685 | 0 | 0 | 0 | 0 | 570 | 0 | 0 | 0 | 288 | 156 | 210 |
| prefix@0.5 | 190 | 190 | 0 | 0 | 154 | 34 | 2 | 0 | 0 | 115 | 190 | 123 | 32 | 43 | 31 | 47 |
| random#1 | 530 | 530 | 0 | 0 | 416 | 102 | 12 | 0 | 0 | 316 | 530 | 306 | 36 | 111 | 84 | 138 |
| random#2 | 190 | 190 | 0 | 0 | 152 | 34 | 4 | 0 | 0 | 116 | 190 | 114 | 20 | 43 | 36 | 55 |
| zero | 190 | 190 | 0 | 0 | 144 | 34 | 12 | 0 | 0 | 118 | 190 | 116 | 20 | 43 | 36 | 54 |

### By interruption point

| group | scenarios | cutFired | notTriggered | haltedBeforeCut | booted | crashed | blank | display-lost | engine-trap | screenMatchesFreshBoot | comparedWithOld | sameScreenAsOld | sameFlashAsOld | readUnknownBytes | rangeErasedAgain | firmwareWroteAfterReboot |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| firmware / accept | 105 | 105 | 0 | 0 | 105 | 0 | 0 | 0 | 0 | 79 | 70 | 68 | 60 | 54 | 68 | 84 |
| firmware / f0.25 | 105 | 105 | 0 | 0 | 105 | 0 | 0 | 0 | 0 | 79 | 70 | 68 | 60 | 54 | 68 | 84 |
| firmware / f0.5 | 225 | 225 | 0 | 0 | 225 | 0 | 0 | 0 | 0 | 181 | 190 | 182 | 141 | 108 | 146 | 192 |
| firmware / f0.75 | 105 | 105 | 0 | 0 | 105 | 0 | 0 | 0 | 0 | 79 | 70 | 68 | 60 | 54 | 68 | 84 |
| firmware / f0.999 | 105 | 105 | 0 | 0 | 105 | 0 | 0 | 0 | 0 | 79 | 70 | 68 | 60 | 54 | 68 | 84 |
| harness / accept | 680 | 680 | 0 | 0 | 566 | 102 | 12 | 0 | 0 | 443 | 510 | 286 | 43 | 168 | 84 | 136 |
| harness / f0.5 | 1360 | 1360 | 0 | 0 | 1084 | 238 | 34 | 4 | 0 | 842 | 1190 | 679 | 89 | 304 | 173 | 276 |
| harness / f0.999 | 680 | 680 | 0 | 0 | 566 | 102 | 12 | 0 | 0 | 443 | 510 | 286 | 43 | 168 | 84 | 136 |

### By firmware

| group | scenarios | cutFired | notTriggered | haltedBeforeCut | booted | crashed | blank | display-lost | engine-trap | screenMatchesFreshBoot | comparedWithOld | sameScreenAsOld | sameFlashAsOld | readUnknownBytes | rangeErasedAgain | firmwareWroteAfterReboot |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| aurora | 160 | 160 | 0 | 0 | 134 | 26 | 0 | 0 | 0 | 134 | 130 | 104 | 0 | 6 | 0 | 0 |
| beetle | 160 | 160 | 0 | 0 | 134 | 26 | 0 | 0 | 0 | 134 | 130 | 104 | 0 | 6 | 0 | 0 |
| bytemania | 160 | 160 | 0 | 0 | 134 | 26 | 0 | 0 | 0 | 134 | 130 | 104 | 0 | 6 | 0 | 0 |
| chipbox | 304 | 304 | 0 | 0 | 278 | 26 | 0 | 0 | 0 | 184 | 234 | 108 | 104 | 206 | 278 | 278 |
| coqui | 304 | 304 | 0 | 0 | 278 | 26 | 0 | 0 | 0 | 66 | 234 | 202 | 66 | 6 | 72 | 248 |
| cord | 232 | 232 | 0 | 0 | 180 | 26 | 26 | 0 | 0 | 180 | 182 | 130 | 48 | 180 | 0 | 128 |
| crepuscular-homunculus | 160 | 160 | 0 | 0 | 134 | 26 | 0 | 0 | 0 | 134 | 130 | 104 | 0 | 6 | 0 | 0 |
| elixir | 160 | 160 | 0 | 0 | 134 | 26 | 0 | 0 | 0 | 110 | 130 | 80 | 0 | 6 | 0 | 0 |
| felucca | 160 | 160 | 0 | 0 | 126 | 26 | 4 | 4 | 0 | 30 | 130 | 0 | 0 | 6 | 0 | 12 |
| fm1-field | 217 | 217 | 0 | 0 | 191 | 26 | 0 | 0 | 0 | 185 | 172 | 140 | 84 | 103 | 102 | 102 |
| frasil | 160 | 160 | 0 | 0 | 134 | 26 | 0 | 0 | 0 | 134 | 130 | 104 | 0 | 6 | 0 | 0 |
| guru600 | 160 | 160 | 0 | 0 | 108 | 26 | 26 | 0 | 0 | 32 | 130 | 2 | 0 | 6 | 0 | 0 |
| jan3000-m-wave-firmware | 160 | 160 | 0 | 0 | 132 | 26 | 2 | 0 | 0 | 30 | 130 | 0 | 0 | 3 | 0 | 1 |
| melodee | 274 | 274 | 0 | 0 | 248 | 26 | 0 | 0 | 0 | 248 | 214 | 188 | 136 | 206 | 204 | 204 |
| modelar | 160 | 160 | 0 | 0 | 134 | 26 | 0 | 0 | 0 | 134 | 130 | 104 | 0 | 3 | 0 | 0 |
| quadro-fm1 | 217 | 217 | 0 | 0 | 191 | 26 | 0 | 0 | 0 | 170 | 172 | 90 | 84 | 103 | 103 | 103 |
| scintilla | 217 | 217 | 0 | 0 | 191 | 26 | 0 | 0 | 0 | 186 | 172 | 141 | 34 | 106 | 0 | 0 |

## Findings (what the emulator showed; the sections are separate from anything about hardware)

**F1. Firmware-issued cycles: the 7 firmware that write (11 firmware x chip units) rebooted into a running firmware in all 645 scenarios, under every outcome policy and at every interruption point
(0 crashes, 0 blanks).** The interrupted cycle was the firmware's own settings or data write, and the firmware either ignores that data on the next boot or writes it again. This is emulator behaviour under
named inputs, not evidence of recovery on hardware. Differences from the `old` bound (the cut had no effect) are few and specific:
- `quadro-fm1` (Puya) and `scintilla` (Puya): the screen differs from the `old` bound only under outcome `new` for their **third** cycle (a page program), at every point; the other policies look like `old`.
- `coqui` (both chips): the screen differs only for its **first** cycle (a 4 KiB erase) under `zero`, `random` seed 1 and seed 2 at the middle point (3 of 52 non-`old` rows per chip).
- `chipbox`, `cord`, `melodee`, `fm1-field`: the final screen was the same as under `old` in every scenario.
**F2. The firmware's reaction to the unknown bytes differs, and the engine's counters show it.** The list of unknown bytes outlives every outcome (a fill does not make them known; even `old` keeps them listed), so
the engine counts a firmware's reads of them under every policy. Rows in which the firmware read unknown bytes after the reboot (all firmware-issued rows of the firmware): `cord` 72 of 72, `chipbox` 72 of 144, `melodee` 72 of 114,
`quadro-fm1`, `scintilla` and `fm1-field` 36 of 57 each, and **`coqui` 0 of 144**. Whether the unknown range was erased again within the 3 s window (non-`old` rows): `chipbox` 52 of 52, `melodee`, `quadro-fm1` and
`fm1-field` 37 of 42, `coqui` 23 of 52, **`cord` and `scintilla` never** (their unknown bytes were still unknown at the end of the window). The flash at the end of the window equalled the `old` run's in all non-`old` rows of
`chipbox`, `fm1-field`, `melodee` and `quadro-fm1`, in 33 of 52 of `coqui`, 23 of 42 of `scintilla` and 10 of 26 of `cord`.
**F3. Harness-issued cycles, by kind** (the harness issues the command at the sector the firmware used, else 0x74000, with the CPU stopped during the cycle):
- *program (16 bytes of the labelled test input 0x00) and 4 KiB erase:* every one of the 17 firmware rebooted into a running state under every outcome. The screen differed from the `old` bound for `chipbox`, `felucca`,
  `guru600`, `jan3000-m-wave-firmware` and `quadro-fm1` (the firmware that read that area on boot) and was identical for the other twelve.
- *32 KiB erase:* the same, except `felucca` and `guru600` showed a **blank screen** under `zero` and `felucca` **lost its display** under `bit-mix` seed 1.
- *64 KiB erase:* as the 4 KiB case plus `elixir` (screen differs), except `cord` and `guru600` showed a **blank screen** under `ff`, `new`, `random` (both seeds) and `bit-mix` seed 1 (under `prefix(0.5)` only `cord`), `zero`
  blanked `cord`, `felucca`, `guru600` and `jan3000-m-wave-firmware`, and `felucca` **lost its display** under `bit-mix` seed 1.
- *chip erase:* **all 17 firmware halted (`crashed`) under every outcome except `old`**: `new`, `ff`, `random` (both seeds), `prefix(0.5)`, `bit-mix` seed 1 and `zero` (the last two policies, `zero` and `random` seed 2, trapped the emulator in the first 5E run: D-1, now fixed); only `old`
  (the flash is as it was) booted. Nothing is left to run when the whole flash is `ff`, zero or noise: this says what the emulator does with such a flash, not what a physical chip holds after an interrupted chip erase.
**F4. The two chip profiles behave alike.** Verdict counts per chip: Puya 1,516 booted / 221 crashed / 29 blank / 2 display-lost / 0 engine traps; UC25HQ80 1,345 / 221 / 29 / 2 / 0 (UC25HQ80 has fewer scenarios because
`quadro-fm1`, `scintilla` and `fm1-field` do not write flash on its JEDEC ID, FLASH-CHIPS.md). Differences between the profiles are in which firmware issue cycles, not in what a cut does.
**F5. The interruption point barely matters for these firmware.** Firmware-issued: the screen differed from the `old` bound in 2 of 70 rows at each of the accept, 25 %, 75 % and 99.9 % points and in 8 of 190 at 50 %
(the point that carries the extra policies). Harness-issued: the accept and 99.9 % points differ in exactly the same 224 of 510 comparable rows, and the 50 % point adds only the extra policies' rows (443 of 1,122): what
moves the outcome is the unit and the policy, not when in the cycle the power fails. (The engine's array-at-accept simplification D33, section 11 of FAULT-INJECTION.md, means the CPU sees the finished cycle's data between
the accept and the cut for firmware-issued cycles; that is a model simplification, not a finding.)
**F6. Controls.** No-fault runs: all 34 units booted and none reported a power cut. A fresh reboot of the package: booted in all 34. Ordinary flash faults (not power cuts) on the 17 firmware: `erase:0x20000` halts 5
(`felucca`, `chipbox`, `elixir`, `fm1-field`, `jan3000-m-wave-firmware`), blanks `melodee` and `cord` and leaves the other 10 booted; `zero:0x4000` halts `aurora`, `coqui`, `beetle`, `crepuscular-homunculus` and `frasil`, blanks 10
firmware (`felucca`, `quadro-fm1`, `chipbox`, `scintilla`, `elixir`, `bytemania`, `fm1-field`, `guru600`, `jan3000-m-wave-firmware`, `modelar`) and leaves `melodee` and `cord` booted (`frasil` and `modelar` trapped the emulator in the first run: D-1). In no control is the state a power cut.

## Defects and limits found (the harness or engine, not the firmware)

**D-1 (pre-existing emulator defect, found by this stage, FIXED afterwards in the chip-profile engine; the shipped engine still has it).** In the first 5E run the emulator aborted (a Rust panic, a WebAssembly `unreachable`) instead of letting the
emulated CPU fault or run on: with an all-zero flash, with `random` seed 2 over the whole flash, and in the ordinary-fault control `zero:0x4000` on `frasil` and `modelar`. It had **two causes in the SoC bus's 32-bit access, neither about flash contents** (the
suspected `Ram::read32` was only the place where the second one surfaced): (1) the fast-path bound `o + 4 <= len` wraps on wasm32 (where `usize` is 32 bits) for the four addresses just below RAM (`0x01bffffc`..`0x01bfffff`, offset `0xFFFFFFFC`..)
and just below the XIP window, and the access then indexed far outside the storage (this was `frasil`/`modelar`: a wild load); (2) a 32-bit access that *starts* in the last three bytes of RAM, the overlay or SRAM2 indexed past the end of the storage (this was the
all-zero flash: the CPU runs zeros through the unmapped space and its 8-byte fetch window crosses the end of the overlay at `0x407fffe`). **Correction** (in `chip-profiles.patch`, `fm1-soc` `lib.rs`): the bounds are written `o < len - 3` (no wrap), and a word that runs
off the end reads the missing bytes as 0 and a write keeps the bytes inside and drops the rest: the same as the XIP window and unmapped addresses already do. Nothing else changed (aligned accesses, flash chip behaviour and the outcome policies are untouched);
what real hardware does at those addresses is not known and was not invented. **Effect on the survey:** the 72 rows that trapped became ordinary results (`crashed` for the 68 chip-erase rows, `crashed`/`blank` for the 4 controls), and the other 3,297 rows and all other controls
are identical to the first run. The harness keeps the verdict `engine-trap` (a future engine abort must never be reported as a firmware result or a CPU halt) and a test shows a halt and a trap stay distinct.
**D-2 (harness baseline):** `screenMatchesFreshBoot` compares with a fresh boot of the package, so a firmware that saves settings before the cut (quadro-fm1, coqui, chipbox, ...) differs even when the cut had no effect; the
`old`-bound comparison (`sameScreenAsOld`) is the meaningful one and was added for that reason.
**D-3 (coverage):** firmware that never issue a block or chip erase can only be tested with those through the harness-issued path (CPU stopped during the cycle); and only the 8 s script is run, so a firmware that
writes flash on a user action the script does not perform (saving a patch, an update) is not exercised.
**D-4 (model, not a defect of this stage):** the boot area (sector 0 and the key sector) is still not emulated, so no result here can reproduce a real brick; USB and the update loader are not emulated, so a
failed update is not covered.

## Reproduce

```bash
node ci/machine/faultsurvey.mjs all --jobs 11 --out docs/dev/fault-survey.json      # about 65 minutes on 12 cores (the results are byte-identical run to run)
node ci/machine/faultsurvey.mjs summary --in docs/dev/fault-survey.json             # the tables above
node ci/machine/faultsurvey.mjs unit --fw quadro-fm1 --chip puya --out unit.json      # one unit (about 6 minutes)
```
A single scenario: `runFaultScenario(engine, pkg, row.cfg)` with a row's `cfg` reproduces its `reportSha256`.
