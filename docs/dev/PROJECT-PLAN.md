# Project plan

Goal: use this emulator for **firmware development and testing**: run firmware against both FM-1
hardware revisions (flash JEDEC `0x856014` Puya, documented reference part P25Q80H, and `0xB36014` UC25HQ80), test flash
identification and chip behaviour, and simulate failures, corrupted flash, failed updates,
bricking and recovery, with automated tests, before risking real hardware.

Rules: one component at a time; each needs user approval; the original emulator keeps working;
never modify `fm1_web.wasm` or licence/notice files without explicit approval; evidence before claims.

**Order revised 2026-11-13** (selectable flash IDs moved up: a validated runtime patch of the existing
engine made the Rust build unnecessary for a first version). **Revised again** when Component 4 was staged: the isolated Rust
engine build is now Stage 4B, fault injection is Component 5, scenario tests 6, boot area 7.

| # | Component | Status | Needs |
|---|---|---|---|
| 1 | Headless machine harness (`ci/machine/`) | **Done**, commit `5791302` | |
| 2 | **Selectable flash ID** (old `85 60 14` / new `B3 60 14`) by validated runtime patch, harness only | **Done**, commit `9f6c78f` | |
| 3 | **Machine self-test in the test workflow:** quick tier in `npm test` (20 s hard limit), full tier as `npm run test:machine` | **Done**, commit `69afefa` | Full tier in CI deferred until validated on macOS/Linux (see below) |
| 4 | **Realistic flash-chip behaviour** (busy/timing, WEL, page-program rules, erases, status registers, protection, Puya vs UC25HQ80). Staged: | | |
| 4A | JS **reference model + conformance tests** from the two datasheets (`chipspec.mjs`, `chipmodel.mjs`, `chiptests.mjs`, `FLASH-CHIPS.md`); typical timing default, maximum as stress profile, caller-supplied clock; refuses to guess | **Done, awaiting commit** | |
| 4B | Isolated build of the upstream Rust engine beside `fm1_web.wasm`, parity-checked against it | Proposed | Approval to install the Rust `wasm32-unknown-unknown` target; vendoring decision (DECISIONS D2); or the fork author's engine source |
| 4C | Port the chip model into the isolated engine's `spiflash.rs` behind a profile switch (default = today's instant behaviour); native flash-ID export; checked differentially against 4A; needs a clock hook in `lib.rs`/`periph.rs` for WIP timing | Proposed | 4B |
| 4D | Harness integration: adapter capability, `--flash-chip` CLI option; the Component 2 runtime patch stays for the shipped engine | Proposed | 4C |
| 5 | Flash fault injection (power cut at op N, failed write, bit flips, stuck busy) | Proposed | 4C; upstream `spiflash.rs` power-cut code is the starting point |
| 6 | Scenario/recovery tests (failed update, corrupted flash, reset recovery) in `npm test` | Proposed | 5 |
| 7 | Boot-area / brick emulation | Research only | Boot ROM + loader behaviour, probably not public |

**ID selection is not chip emulation.** Component 2 changes only the 3 bytes the flash chip returns
to a JEDEC read (`0x9F`). Everything else about the chip (timing, status bits, other commands,
protection) is unchanged in the running emulator; Component 4 Stage A specifies it (as a reference model, not yet in
the engine) and Stages B-D would bring it into an engine we can rebuild.

Follow-ups to Component 3 (not scheduled): run the full machine tier in CI (`release.yml`) once it has been
validated on macOS and Linux; a manifest-driven suite runner so a firmware project's `make test` can run
many scenarios with one command (the CLI in `ci/machine/cli.mjs` is the integration point today).

**Stage A is a specification, not an emulator feature.** The reference model is tested against the datasheets only; the
running emulator behaves exactly as before. The physical older chip variant is unresolved (FLASH-CHIPS.md).

Also open: "hung" detection needs a per-firmware stimulus/response check (not a verdict in v1);
an ID selector in the app UI is not part of any component yet.
