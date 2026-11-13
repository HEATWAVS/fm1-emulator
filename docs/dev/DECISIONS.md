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
