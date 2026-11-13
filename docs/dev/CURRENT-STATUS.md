# Current status

Last updated: 2026-11-13. Read this first; details live in the other files in this folder.

## Where we are
- Fork `HEATWAVS/fm1-emulator` (origin) of `briksquared/fm1-emulator` (upstream) cloned; full history.
- Baseline: original emulator v1.1.3 at commit `01853da` installs (`npm install`) and launches (`npm start`) on Windows 11. Node 24.19.0, npm 12.2.0, electron 45.2.3, electron-builder 26.18.1.
- **Component 1 (headless machine harness): done**, commit `5791302`. Files in `ci/machine/`.
- Docs and `CLAUDE.md`: commit `980b10c`. Both commits are local only (not pushed).
- **Component 2 (selectable flash ID): implemented and tested, not yet committed.** `ci/machine/flashid.mjs` (new), small additions to `engine.mjs`, `machine.mjs`, `cli.mjs`, `selftest.mjs`, README, and these docs. Self-test 30/30 (16 from Component 1 unchanged + 14 new). `fm1_web.wasm` unchanged (sha256 `cdf039104a74...0278`).

## How to use Component 2
`node ci/machine/cli.mjs --fw quadro-fm1 --flash-id new` or `Fm1Machine.boot(engine, pkg, { flashId: "uc25hq80" })`. Without the option nothing changes. ID selection only (see PROJECT-PLAN).

## Not started
Components 3-8 in PROJECT-PLAN.md. Nothing beyond Component 2 is approved.

## Open questions (need the user)
1. Where does the user's `make test` come from? Neither this repo nor upstream has a Makefile; the harness README has a sample snippet only.
2. May `ci/verify.mjs` be edited to run the harness self-test in `npm test` (Component 3)? It takes ~90 s now.
3. Push to origin? Not done; only on request.
4. UC25HQ80 (`B36014`): no datasheet found. Needs vendor datasheet or probing a real unit.
5. Is "both revisions use the AC791N" true for the newer unit? Unverified.
6. The CLI `--save-flash` / `--flash` round trip is still untested (listed in TESTING.md).

## Known risks
- The fork's compiled engine is not a build of the public upstream source (ARCHITECTURE.md). Source for its extras is not public.
- The flash-ID patch works only on the exact engine build validated (hash in `engine.mjs`); any other build is refused. A rebuilt `fm1_web.wasm` needs its layout re-validated before the hash is added.
- Boot ROM/loader are not emulated, so true bricking cannot be reproduced (TESTING.md known limitations).

## Housekeeping
- Setup notes outside the repo: `FM1\SETUP-NOTES.md`.
- Scratch (not in repo): upstream source copy and probes under the session scratchpad; disposable.
