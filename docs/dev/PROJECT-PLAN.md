# Project plan

Goal: use this emulator for **firmware development and testing**: run firmware against both FM-1
hardware revisions (flash JEDEC `0x856014` Puya, documented reference part P25Q80H, and `0xB36014` UC25HQ80), test flash
identification and chip behaviour, and simulate failures, corrupted flash, failed updates,
bricking and recovery, with automated tests, before risking real hardware.

Rules: one component at a time; each needs user approval; the original emulator keeps working;
never modify `fm1_web.wasm` or licence/notice files without explicit approval; evidence before claims.

**Order revised 2026-11-13** (selectable flash IDs moved up: a validated runtime patch of the existing
engine made the Rust build unnecessary for a first version). **Revised again** when Component 4 was staged: the isolated Rust
engine build is now Stage 4B, fault injection is Component 5, scenario tests 6, boot area 7. **Revised 2026-11-13 (Stage C approved in steps C0-C4):** the Rust port and the harness integration (old 4C and 4D) became Stage C, steps C0-C4.

| # | Component | Status | Needs |
|---|---|---|---|
| 1 | Headless machine harness (`ci/machine/`) | **Done**, commit `5791302` | |
| 2 | **Selectable flash ID** (old `85 60 14` / new `B3 60 14`) by validated runtime patch, harness only | **Done**, commit `9f6c78f` | |
| 3 | **Machine self-test in the test workflow:** quick tier in `npm test` (20 s hard limit), full tier as `npm run test:machine` | **Done**, commit `69afefa` | Full tier in CI deferred until validated on macOS/Linux (see below) |
| 4 | **Realistic flash-chip behaviour** (busy/timing, WEL, page-program rules, erases, status registers, protection, Puya vs UC25HQ80). Staged: | | |
| 4A | JS **reference model + conformance tests** from the two datasheets (`chipspec.mjs`, `chipmodel.mjs`, `chiptests.mjs`, `FLASH-CHIPS.md`); typical timing default, maximum as stress profile, caller-supplied clock; refuses to guess | **Done**, commit `be69973` | |
| 4B | Isolated build of the upstream Rust engine (v0.3.0, commit `631b790`) beside `fm1_web.wasm`, parity-checked against it | **Done** (scratch, outside the repo): the build is now reproducible by `ci/engine/build.mjs`; parity result in TESTING.md | |
| C0 | Read-only clock investigation: can the chip's WIP timing use the SoC cycle counter? | **Done**: yes (ARCHITECTURE.md, "Chip-profile engine") | |
| C1 | Port the chip model into the isolated engine (`spichip.rs`) behind a profile switch, default = original behaviour; oracle transcripts replayed by Rust host tests | **Done** (patch `ci/engine/chip-profiles.patch`) | |
| C2 | Integration: reproducible build script + pins, tables generated from `chipspec.mjs`, harness options `flashChip`/`flashTiming`, CLI `--flash-chip`/`--flash-timing`/`--engine`, tests, docs (this was old 4D) | **Done** (see `git log`) | |
| C3 | Live conformance and failure tests against the chip-profile engine for both profiles (WEL, page wrap, protection/SRP, all erases, WIP and timing, rejected writes, status and power-cycle persistence, legacy regression, oracle replay), plus the `4Bh` investigation | **Done** (see `git log`; 42 live tests, 24 mutation controls caught) | |
| C4 | Firmware behaviour tests under each profile (17 firmware survey, cost, attribution experiments, 4 pinned tests) | **Done** (see `git log`) | C3 |
| 5 | Flash fault injection: deterministic **power cut mid-operation** with explicit, labelled outcome policies (the datasheets do not specify the array after an interrupted cycle). **5A design approved with amendments; 5B (JS spec, reference model, policy functions) done 2026-11-13** (`FAULT-INJECTION.md`, section 8). Remaining stages: 5C Rust engine (journal, cut state, exports; **design approved 2026-11-13; 5C-1 chip state, 5C-2 SoC scheduling/terminal cut and 5C-3 exports/live tests, 5D harness integration and 5E firmware scenarios and sweeps done: Component 5 complete**; FAULT-INJECTION.md sections 9 and 10), 5D harness (`fault`, `runUntilCut`, `powerCut`, `powerRestore`), 5E firmware scenarios and sweeps | **5A-5E done** (D-1, found by 5E, fixed afterwards) | C3, C4; reuses `ops`, the cycle clock, `powerCycle`, seeded corruption |
| 6 | Scenario/recovery tests in `npm test`: **corrupted flash** (shipped engine; 3 scenarios in the quick tier, 10 in all), **interrupted flash cycles** (9 scenarios on the chip-profile engine, full tier, SKIPPED without it) and the `powerCycle()` finding (it cannot interrupt a write; `RECOVERY-SCENARIOS.md`). **Failed update / USB loader: deferred** (not emulated; an interrupted write is not a failed update) | **Done** (see `git log`) | 5 |
| 7 | Boot-area / brick emulation | Research only | Boot ROM + loader behaviour, probably not public |

**ID selection is not chip emulation.** Component 2 changes only the 3 bytes the flash chip returns
to a JEDEC read (`0x9F`). Everything else about the chip (timing, status bits, other commands,
protection) is unchanged in the **shipped** emulator and engine. Component 4 Stage A specifies it (a reference model) and Stage C brings it into a
separately built, never-committed test engine (`ci/engine/`), selected with `flashChip`; the shipped `fm1_web.wasm` is unchanged.

Follow-ups to Component 3 (not scheduled): run the full machine tier in CI (`release.yml`) once it has been
validated on macOS and Linux; a manifest-driven suite runner so a firmware project's `make test` can run
many scenarios with one command (the CLI in `ci/machine/cli.mjs` is the integration point today).

**The chip-profile engine is a test tool, not an emulator feature.** The shipped emulator behaves exactly as before. The chip model rests on the
datasheets (Stage A) and is replayed against by oracle transcripts (Stage C). The physical older chip variant is unresolved (FLASH-CHIPS.md).

Also open: "hung" detection needs a per-firmware stimulus/response check (not a verdict in v1);
an ID selector in the app UI is not part of any component yet.
