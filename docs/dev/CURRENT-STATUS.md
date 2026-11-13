# Current status

Last updated: 2026-11-13. Read this first; details live in the other files in this folder.

## Where we are
- Fork `HEATWAVS/fm1-emulator` (origin) of `briksquared/fm1-emulator` (upstream) cloned; full history.
- Baseline: original emulator v1.1.3 at commit `01853da` installs (`npm install`) and launches (`npm start`) on Windows 11. Node 24.19.0, npm 12.2.0, electron 45.2.3, electron-builder 26.18.1.
- **Component 1 (headless machine harness): done**, commit `5791302`. Files in `ci/machine/`.
- Docs and `CLAUDE.md`: commit `980b10c`.
- **Component 2 (selectable flash ID): done**, commit `9f6c78fceb96de86c2086c8ff1d46946daa6827e`. `ci/machine/flashid.mjs` plus small additions to the harness. ID selection only, not chip emulation; patches only a validated engine build (`fm1_web.wasm` sha256 `cdf039104a74...0278`).
- **Component 3 (machine self-test in the test workflow): implemented and verified, not yet committed.** `npm test` now also runs the quick tier; `npm run test:machine:quick` and `npm run test:machine` run the quick and full tiers. See TESTING.md.
- All commits are local only (not pushed).

## How to run
`npm test` (existing suite + machine quick tier, ~13 s) | `npm run test:machine:quick` (~5 s) | `npm run test:machine` (full, 30 tests, ~90 s) | `node ci/machine/cli.mjs --fw quadro-fm1 --flash-id new` (see `ci/machine/README.md`).

## Not started
Components 4-8 in PROJECT-PLAN.md. Nothing beyond Component 3 is approved.

## Open questions (need the user)
1. Where does the user's `make test` come from? Neither this repo nor upstream has a Makefile; the harness README has a sample snippet only. The separate FM1 Firmware project has not been accessed.
2. When to add the full machine tier to CI (`.github/workflows/release.yml`)? Deferred by decision until it is validated on macOS and Linux. The quick tier already runs in CI through `npm test` (release tags and manual dispatch only; Node 20; Windows, macOS, Linux).
3. Push to origin? Not done; only on request.
4. UC25HQ80 (`B36014`): no datasheet found. Needs vendor datasheet or probing a real unit.
5. Is "both revisions use the AC791N" true for the newer unit? Unverified.
6. The CLI `--save-flash` / `--flash` round trip is still untested (listed in TESTING.md).

## Known risks
- The fork's compiled engine is not a build of the public upstream source (ARCHITECTURE.md). Source for its extras is not public.
- The flash-ID patch works only on the exact engine build validated; a rebuilt `fm1_web.wasm` must be re-validated first.
- Machine tests have been verified on Windows only (Node 24.19.0 and Node 20.20.2). macOS and Linux are unverified, and the quick tier will gate releases there through `npm test`. Slow CI machines could approach the quick tier's 20 s limit (5 s here).
- Boot ROM/loader are not emulated, so true bricking cannot be reproduced (TESTING.md known limitations).

## Housekeeping
- Setup notes outside the repo: `FM1\SETUP-NOTES.md`.
- Scratch (not in repo, disposable): upstream source copy, probes, backups and a temporary Node 20.20.2 under the session scratchpad. The installed Node was not changed.
