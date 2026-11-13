# Current status

Last updated: 2026-11-13. Read this first; details live in the other files in this folder.

## Where we are
- Fork `HEATWAVS/fm1-emulator` (origin) of `briksquared/fm1-emulator` (upstream) cloned; full history.
- Baseline: original emulator v1.1.3 at commit `01853da` installs (`npm install`) and launches (`npm start`) on Windows 11. Node 24.19.0, npm 12.2.0, electron 45.2.3, electron-builder 26.18.1.
- **Component 1 (headless machine harness): done**, commit `5791302`. Files in `ci/machine/`.
- Docs and `CLAUDE.md`: commit `980b10c`.
- **Component 2 (selectable flash ID): done**, commit `9f6c78fceb96de86c2086c8ff1d46946daa6827e`. ID selection only, not chip emulation; patches only a validated engine build (`fm1_web.wasm` sha256 `cdf039104a74...0278`).
- **Component 3 (machine self-test in the test workflow): done**, commit `69afefa2ebf35c785a61cfb5893a648bfa9557fd`. `npm test` runs the machine quick tier with a 20 s hard limit; `npm run test:machine:quick` and `npm run test:machine` run the tiers.
- **Component 4 Stage A (flash-chip reference model and conformance tests): implemented, reviewed and verified, not yet committed.** A final review found one defect (Puya chip erase misread as conflicting; it is unambiguous), fixed and re-verified (DECISIONS D29). JavaScript only: `ci/machine/chipspec.mjs` (datasheet data + page-level citations), `chipmodel.mjs` (the model), `chiptests.mjs` (75 tests), plus `docs/dev/FLASH-CHIPS.md`. A specification and test oracle for the Puya P25Q80H (reference profile) and the UC25HQ80; **not wired into the running emulator**, whose engine is unchanged.
- All commits are local only (not pushed).

## How to run
`npm test` (existing suite + machine quick tier, ~13 s) | `npm run test:machine:quick` (94 tests, ~5 s) | `npm run test:machine` (full, 105 tests = 30 harness + 75 chip-model, ~90 s) | `node ci/machine/chiptests.mjs` (the 75 chip-model tests alone, ~0.3 s) | `node ci/machine/cli.mjs --fw quadro-fm1 --flash-id new` (see `ci/machine/README.md`).

## Not started
Component 4 Stages B-D (isolated engine build, Rust port of the chip model, harness integration) and Components 5-7 in PROJECT-PLAN.md. Nothing beyond Stage A is approved.

## Open questions (need the user)
1. **Which physical chip is in the older FM-1 is UNRESOLVED.** `P25Q80H` is only the documented reference profile (its ID table matches `85 60 14`); other Puya variants may share the ID and differ in detail. Needs the chip marking or status/SFDP reads from a real older unit (see FLASH-CHIPS.md).
2. Where does the user's `make test` come from? Neither this repo nor upstream has a Makefile; the harness README has a sample snippet only. The separate FM1 Firmware project has not been accessed.
3. When to add the full machine tier to CI (`.github/workflows/release.yml`)? Deferred until validated on macOS and Linux. The quick tier already runs in CI through `npm test` (release tags and manual dispatch only; Node 20; Windows, macOS, Linux).
4. Stage B approvals: install the Rust `wasm32-unknown-unknown` target? Vendor/pin the upstream MIT source, or keep it outside the repo? Ask the fork's author for the engine source first?
5. The model refuses (throws) where the datasheets are silent or contradictory, e.g. UC25HQ80 chip erase at 14 of the 64 BP/CMP combinations (Puya's chip-erase rule is unambiguous and fully decided), WEL after rejected commands (list in FLASH-CHIPS.md). Should any be settled by probing a real unit?
6. Push to origin? Not done; only on request.
7. Is "both revisions use the AC791N" true for the newer unit? Unverified.
8. The CLI `--save-flash` / `--flash` round trip is still untested (listed in TESTING.md).

## Known risks
- The fork's compiled engine is not a build of the public upstream source (ARCHITECTURE.md). Source for its extras is not public. Every chip behaviour beyond the ID (timing, status/protection, page wrap) needs an engine we can rebuild; none can change in the shipped `fm1_web.wasm`.
- The flash-ID patch works only on the exact engine build validated; a rebuilt `fm1_web.wasm` must be re-validated first.
- Machine and chip-model tests have been verified on Windows only (Node 24.19.0 and Node 20.20.2). macOS and Linux are unverified; the quick tier gates releases through `npm test`. Slow CI machines could approach the quick tier's 20 s limit (about 5 s here).
- The chip model rests on two datasheets (Puya V1.7, UC25HQ80 v1.2); other revisions may differ. Typical timings are "not 100% tested"; no minimum timing exists in either document.
- Boot ROM/loader are not emulated, so true bricking cannot be reproduced (TESTING.md known limitations).

## Housekeeping
- Setup notes outside the repo: `FM1\SETUP-NOTES.md`. Verified datasheet findings also saved to project memory (`flash-chip-datasheet-findings.md`).
- Scratch (not in repo, disposable): upstream source copy, probes, backups and a temporary Node 20.20.2 under the session scratchpad. The installed Node was not changed.
