# Project plan

Goal: use this emulator for **firmware development and testing**: run firmware against both FM-1
hardware revisions (flash JEDEC `0x856014` Puya P25Q80 and `0xB36014` UC25HQ80), test flash
identification and chip behaviour, and simulate failures, corrupted flash, failed updates,
bricking and recovery, with automated tests, before risking real hardware.

Rules: one component at a time; each needs user approval; the original emulator keeps working;
never modify `fm1_web.wasm` or licence/notice files without explicit approval; evidence before claims.

**Order revised 2026-11-13** (selectable flash IDs moved up: a validated runtime patch of the existing
engine made the Rust build unnecessary for a first version; the Rust build moved to Component 5).

| # | Component | Status | Needs |
|---|---|---|---|
| 1 | Headless machine harness (`ci/machine/`) | **Done**, commit `5791302` | |
| 2 | **Selectable flash ID** (old `85 60 14` / new `B3 60 14`) by validated runtime patch, harness only | **Done**, commit `9f6c78f` | |
| 3 | **Machine self-test in the test workflow:** quick tier in `npm test` (20 s hard limit), full tier as `npm run test:machine` | **Done, awaiting commit** | Full tier in CI deferred until validated on macOS/Linux (see below) |
| 4 | UC25HQ80 behaviour research (beyond its ID) | Proposed | Datasheet, or probing a real unit (ID, status regs, SFDP, unique ID) |
| 5 | Isolated build of upstream Rust engine, compared with the fork's wasm; native flash-ID export | Proposed | Approval to install the Rust `wasm32-unknown-unknown` target; vendoring decision (DECISIONS D2) |
| 6 | Flash fault injection (power cut at op N, failed write, bit flips, stuck busy) and realistic flash timing/commands | Proposed | Components 4-5; upstream `spiflash.rs` power-cut code is the starting point |
| 7 | Scenario/recovery tests (failed update, corrupted flash, reset recovery) in `npm test` | Proposed | 3, 6 |
| 8 | Boot-area / brick emulation | Research only | Boot ROM + loader behaviour, probably not public |

**ID selection is not chip emulation.** Component 2 changes only the 3 bytes the flash chip returns
to a JEDEC read (`0x9F`). Everything else about the chip (timing, status bits, other commands,
protection) is unchanged and belongs to Components 4 and 6.

Follow-ups to Component 3 (not scheduled): run the full machine tier in CI (`release.yml`) once it has been
validated on macOS and Linux; a manifest-driven suite runner so a firmware project's `make test` can run
many scenarios with one command (the CLI in `ci/machine/cli.mjs` is the integration point today).

Also open: "hung" detection needs a per-firmware stimulus/response check (not a verdict in v1);
an ID selector in the app UI is not part of any component yet.
