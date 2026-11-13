# Project plan

Goal: use this emulator for **firmware development and testing**: run firmware against both FM-1
hardware revisions (flash JEDEC `0x856014` Puya P25Q80 and `0xB36014` UC25HQ80), test flash
identification and chip behaviour, and simulate failures, corrupted flash, failed updates,
bricking and recovery, with automated tests, before risking real hardware.

Rules: one component at a time; each needs user approval; the original emulator keeps working;
never modify `fm1_web.wasm` or licence/notice files without explicit approval; evidence before claims.

| # | Component | Status | Needs |
|---|---|---|---|
| 1 | Headless machine harness (`ci/machine/`) | **Done**, commit `5791302` | |
| 2 | Run harness self-test from `npm test` | Proposed | Approval to edit `ci/verify.mjs` |
| 3 | Isolated build of upstream Rust engine, compared with the fork's wasm | Proposed | Approval to install the Rust `wasm32-unknown-unknown` target; decision on vendoring (see DECISIONS.md D2) |
| 4 | Selectable flash JEDEC ID in an engine build + export | Proposed | Component 3 |
| 5 | UC25HQ80 behaviour research | Proposed | Datasheet or real-unit probe (ID, status regs, SFDP, unique ID) |
| 6 | Flash fault injection API (power cut at op N, failed write, bit flips, stuck busy) | Proposed | Components 3-4; upstream `spiflash.rs` power-cut code is the starting point |
| 7 | Scenario/recovery tests (failed update, corrupted flash, reset recovery) in `npm test` | Proposed | 2, 6 |
| 8 | Boot-area / brick emulation | Research only | Boot ROM + loader behaviour, probably not public |

Also open: "hung" detection needs a per-firmware stimulus/response check (not a verdict in v1).
