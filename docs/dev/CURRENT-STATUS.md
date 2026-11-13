# Current status

Last updated: 2026-11-13. Read this first; details live in the other files in this folder.

## Where we are
- Fork `HEATWAVS/fm1-emulator` (origin) of `briksquared/fm1-emulator` (upstream) cloned; full history.
- Baseline: original emulator v1.1.3 at commit `01853da` installs (`npm install`) and launches (`npm start`) on Windows 11. Node 24.19.0, npm 12.2.0, electron 45.2.3, electron-builder 26.18.1.
- **Component 1 (headless machine harness): done and committed**, `5791302`, local only (not pushed). Files in `ci/machine/`. Self-test 16/16, `npm test` passes, `fm1_web.wasm` unchanged.

## Not started
Everything in PROJECT-PLAN.md after Component 1. Nothing beyond Component 1 is approved.

## Open questions (need the user)
1. Where does the user's `make test` come from? Neither this repo nor upstream has a Makefile; the harness README has a sample snippet only.
2. May `ci/verify.mjs` (existing file) be edited to run `ci/machine/selftest.mjs` in `npm test`? Not done; needs approval.
3. Push to origin? Not done; only on request.
4. UC25HQ80 (JEDEC `B36014`): no datasheet found. Needs vendor datasheet or probing a real unit.
5. Is the user's claim "both revisions use the AC791N" confirmed for the newer unit? Unverified.

## Known risks
- The fork's compiled engine is not a build of the public upstream source (see ARCHITECTURE.md). Source for the fork's extras is not public.
- Boot ROM/loader are not emulated, so true bricking cannot be reproduced (see TESTING.md known limitations).

## Housekeeping
- Setup notes outside the repo: `FM1\SETUP-NOTES.md`.
- Scratch (not in repo): upstream source copy and probe under the session scratchpad; disposable.
