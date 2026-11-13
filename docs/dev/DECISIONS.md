# Decisions

| ID | Date | Decision | Why |
|---|---|---|---|
| D1 | 2026-11-13 | Fork cloned to `FM1\fm1-emulator`; `origin` = HEATWAVS fork, `upstream` = briksquared | User request |
| D2 | 2026-11-13 | Do **not** replace or merge the upstream engine. Build it separately if needed and compare | The fork's wasm has exports upstream lacks and is not a known build of public source |
| D3 | 2026-11-13 | Harness is new files only under `ci/machine/`; no existing file edited | Keep the original emulator working; easy to review/revert |
| D4 | 2026-11-13 | Interpreter (no JIT) is the harness default | JIT is opt-in in the app (can stall audio); determinism verified only for the interpreter |
| D5 | 2026-11-13 | Verdicts: `booted`, `crashed`, `blank`, `display-lost`. No `hung` verdict | A static screen waiting for input looks the same as a stuck loop; needs a stimulus per firmware |
| D6 | 2026-11-13 | Engine capabilities are detected from exports; unsupported features throw instead of passing | Never claim a test passed by silently skipping it |
| D7 | 2026-11-13 | Missing-feature behaviour is locked in by `KNOWN LIMITATION` tests | If an engine starts modelling boot/key areas, tests fail and flag new test options |
| D8 | 2026-11-13 | Commits stay local; push only on request | User instruction |
| D9 | 2026-11-13 | Project docs live in `docs/dev/`, separate from user-facing docs in `docs/` | Avoid touching existing documentation |
| D10 | 2026-11-13 | Flash ID is selected by a **runtime patch** of the live chip structure in engine memory, not a Rust rebuild; `fm1_web.wasm` is never modified | Cheapest verified route; the engine binary stays byte-identical; the native export moves to Component 5 |
| D11 | 2026-11-13 | Component 2 is **ID selection only**: no timing, extra commands, fault injection or recovery | User scope. Only the bytes of the JEDEC read (`0x9F`) change; chip emulation fidelity is Components 4 and 6 |
| D12 | 2026-11-13 | Patch only an engine whose sha256 is in `FLASH_ID_LAYOUTS`; anything else is refused | The memory layout is build-specific |
| D13 | 2026-11-13 | The live copy is **proven** (engine's own `fm1_flash_revision` echoes a sentinel) and only it is patched; exactly the validated number of copies and exactly one live copy, else refuse and leave memory untouched | User condition 3-4; blind patching of all copies is not justified by evidence alone |
| D14 | 2026-11-13 | Selectable IDs: `puya` (`85 60 14`) and `uc25hq80` (`B3 60 14`) only; FM-1 board only (not the SMK-37's `EB 60 14`); only at boot | Scope; arbitrary IDs would also defeat the locator's known-ID check |
| D15 | 2026-11-13 | Plan order revised: selectable ID is Component 2; `npm test` hook is Component 3; Rust build Component 5 | Evidence from the runtime-patch investigation |
| D16 | 2026-11-13 | Machine self-test has two tiers: **quick** (19 tests, ~5 s, tagged `test.quick`) runs inside `npm test`; **full** (all 30, ~90 s) is `npm run test:machine`. The full tier runs every test, so quick is a subset by construction | Keep `npm test` fast (8 s -> ~13 s) so it keeps being run; keep the slow firmware-behaviour checks one command away |
| D17 | 2026-11-13 | `npm test` runs the quick tier with a hard 20 s timeout (`MACHINE_QUICK_LIMIT_MS` in `ci/verify.mjs`) and fails with a distinct "exceeded its 20-second limit" message | A stuck emulation must never hang `npm test` or a release build |
| D18 | 2026-11-13 | The full machine suite stays at the original **30 tests**. The Component 2 test "default is untouched" is a single quick test whose function receives `{ full }`: its fast memory-identity check runs in both tiers, its slower whole-run comparison only in the full tier | User requirement (keep 30); the default-preservation guard is in the quick tier and no assertion is lost. (An earlier draft split it into two tests, making 31; reverted.) |
| D19 | 2026-11-13 | Real Felucca boot stays in the quick tier as the smoke test | User decision |
| D20 | 2026-11-13 | Full machine tier NOT added to CI yet | Only Windows is validated (Node 24 and Node 20.20.2); macOS/Linux first. The quick tier reaches CI via `npm test` regardless |
