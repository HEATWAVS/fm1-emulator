# Testing

## How to run
```bash
npm test                              # existing suite + machine quick tier (ci/verify.mjs), ~13 s
npm run test:machine:quick            # machine quick tier alone, 94 tests, ~5 s
npm run test:machine                  # machine full tier, 105 tests (30 harness + 75 chip-model), ~90 s (not run by npm test or CI)
node ci/machine/chiptests.mjs         # the 75 flash-chip reference-model tests alone, ~0.3 s
node ci/machine/cli.mjs --fw felucca --corrupt erase:0x20000 --expect crashed
```
**Tiers (Component 3).** A machine test is quick if declared `test.quick(...)` in `ci/machine/selftest.mjs`; the full tier runs every test, so quick is a subset by construction. Quick tests run no firmware longer than the Felucca boot smoke test. `npm test` runs the quick tier through `ci/verify.mjs` with a **20 s hard timeout**; a failing quick test, a timeout, or an empty selection fails `npm test`. Output ends with `PASS: N machine tests (quick|full)`.
`cli.mjs` exit codes: 0 verdict matched `--expect`, 1 mismatch, 2 usage error or package would not boot.

## Results on record (2026-11-13, Windows 11, Node 24.19.0)
- `npm test`: PASS, 277 firmware packages (hashes, identities, order, source manifest, resource loader).
- Harness self-test: **105/105 pass** (30 harness tests: 16 Component 1 + 14 flash-ID, unchanged; plus 75 chip-model tests from Component 4 Stage A). Felucca 1.8.2-beta, AURORA 0.9.1, Melodee 1.6.1 boot headless (3 s) and show a screen.
- Repeatability: two boots of Felucca give identical LCD hash, flash hash and engine clock (interpreter, no input).
- Corruption on Felucca: zero `0x4000` -> `blank`; erase `0x20000` -> `crashed` (CPU halt). Fixture-specific; other firmware may differ.
- Speed: about 1x real time at 100 MHz interpreter (3 s emulated ~ 3 s wall); stuck-loop runs can cost far more (one case ~14 s for 2 s of audio).

## Component 4 Stage A verification (2026-11-13, Windows 11)
- `node ci/machine/chiptests.mjs`: **75/75** in ~0.3 s, also on Node 20.20.2. Composition, counted from the test names: **36 Puya + 35 UC25HQ80 + 4 shared = 75**. The 4 shared tests are the profile-difference test, the chip-erase comparison of the profiles, the Component 2 ID-interop test and the traceability test. (Before the chip-erase fix it was 70 = 34 Puya + 33 UC25HQ80 + 3 shared; the earlier "35 behaviour tests per profile" wording was wrong.) Each of the 33 common behaviour tests runs for Puya and UC25HQ80 independently. Profile-specific: Puya has 3 (the page-program option "Q" note, the Configure Register refusal, the exhaustive chip-erase test) and the UC25HQ80 has 2 (15h/31h are not UC commands, the exhaustive chip-erase test with its 14 conflicts): 33 + 3 = 36 Puya, 33 + 2 = 35 UC25HQ80.
- After the fix: quick tier **94/94** in 5.1 s (Node 24) and 5.6 s (Node 20); `npm test` PASS in 13.4 s (Node 24) and `verify.mjs` PASS on Node 20; full suite **105/105 in 87.9 s** (Node 24.19.0). The full suite was not re-run on Node 20 (only pure-JS tests were added to the 30 that passed there before). Selectable flash ID re-checked end to end through the CLI: quadro-fm1 makes 3 flash changes on the old ID and none on the new one, unchanged.
- Traceability: a test fails if any behaviour in the registry lacks a page-level citation, a valid level, or a test, for either profile.
- Mutation controls (temporary edits, restored byte-identical): changing Puya's typical page-program time, corrupting a UC block-protect row, removing page wrap, removing the UC "WEL unknown during a cycle" rule, disabling protection, making chip erase guess instead of refuse, and deleting a citation were each caught (1-4 failing tests each).
- **Review fix (Puya chip erase), 2026-11-13.** A final review found that the model, registry, a test and FLASH-CHIPS.md treated Puya's chip erase as ambiguous. Puya p.24 and p.38 give one rule (run only when the BP bits are set to "None protected"), so all 64 BP/CMP combinations are decided (14 run, 50 are ignored). Only the UC25HQ80's own p.9 and p.28 statements conflict, at 14 of 64 combinations (1 runs, 49 ignored). Fixed in `chipspec.mjs` (`prot.chip-erase` per profile, `prot.chip-erase-conflict` UC25HQ80-only), `chipmodel.mjs` (`#chipErase`), the tests and the docs. UC25HQ80 behaviour is unchanged.
- **New tests for the fix:** all 64 BP/CMP combinations per profile, with the expected outcome of each written as literal lists from the datasheet wording (nothing calls the model's decision logic or the spec tables); a chip-erase comparison of the two profiles (they differ at exactly the 14 combinations the UC25HQ80 refuses); no-WREN tests for page program, page/sector/32K/64K erase, chip erase (60h and C7h) and WRSR; and a literal copy of both printed protection tables (19 rows for CMP=0 and 19 for CMP=1) compared with each profile.
- **Mutation controls for the fix** (temporary edits, restored byte-identical, each caught): Puya using the UC conflict logic again (2 failing), the UC25HQ80 no longer refusing (2), a corrupted Puya CMP=1 protection row (3), page erase no longer needing WREN (4), chip erase no longer needing WREN (2), a Puya conflict entry added back to the registry (1).
- **Registry:** 81 behaviours, 205 citations; Puya 80 entries and UC25HQ80 80 entries (`timing.puya-q-option` is Puya-only, `prot.chip-erase-conflict` is UC25HQ80-only). Levels, Puya / UC25HQ80: verified 46 / 45, interpretation 7 / 6, unspecified 13 / 16, not modelled 14 / 13. All 205 citations fall inside their cited sections' pages per each document's own table of contents (the suspend/resume entries now also cite the command listings, Puya p.20 and UC25HQ80 p.13).
- `fm1_web.wasm` byte-identical; no engine, Rust or WASM involvement.
- Datasheet ambiguities are tested as refusals (e.g. UC25HQ80 chip erase at 14 of 64 BP/CMP combinations, WEL after rejected commands); they are listed in FLASH-CHIPS.md. Puya's chip erase is not ambiguous.

## Component 3 verification (2026-11-13, Windows 11)
- `npm test`: PASS, 12.2-12.6 s (was ~8 s); all existing assertions unchanged. Same result under Node 20.20.2 (`node ci/verify.mjs`, children inherit the runtime, so the quick tier ran on Node 20 too).
- Quick tier alone: 19/19, 4.4-4.8 s (Node 24 and Node 20). Full tier: 30/30, 85.2 s on Node 24.19.0 and 92.8 s on Node 20.20.2.
- Combined test "default is untouched" (one test, both tiers): quick runs only its fast memory check (~0.1 s); full also runs the whole-run comparison (~4.5 s). Mutation controls: breaking the fast part fails the quick tier (18/19, exit 1); breaking the slow part leaves the quick tier passing (19/19) and fails the full tier (29/30, exit 1). Restored byte-identical.
- Negative controls (temporary edits, restored byte-identical): breaking one quick assertion makes `npm test` exit 1 and name the failing test; stalling the quick tier 25 s makes it stop at the limit with "exceeded its 20-second limit"; `--bogus` exits 2; zero selected tests exits 1.
- `fm1_web.wasm` byte-identical (sha256 `cdf039104a74...0278`).
- **Not verified:** macOS and Linux; GitHub Actions itself (release tags only; nothing was pushed).

## Flash-ID tests (Component 2), all in `ci/machine/selftest.mjs`
Default untouched (explicit `puya` leaves engine memory byte-identical to no option; `uc25hq80` differs by exactly one byte); both IDs read back; invalid IDs rejected (`0x000000`, SMK `eb6014`, malformed); live copy proven and only it patched; stale copies inert and live-only equals all-three (quadro-fm1); firmware reacts (quadro-fm1 flash writes 3 -> 0, AURORA screen differs); repeatable on both IDs; power cycle keeps the ID, can change it, default stays default; unvalidated engine hash and non-FM-1 board refused; synthetic-memory refusals (too few/many copies, unknown ID, no live copy, two live copies, wrong offset, no layout) leave memory untouched; CLI default JSON keys unchanged.
Evidence behind the design (scratch probes, not in repo): 3 copies of the chip structure, 1 live; sentinel echo through `fm1_flash_revision`; 3 of 12 firmware sampled react to the ID.

## Existing test coverage (what `npm test` does not cover)
- `ci/test-flash.mjs` uses `ci/fake-fm1.mjs`, a JS mock of the USB-MIDI update protocol. It tests the updater app, not firmware on the emulated CPU.
- Only `ci/audit-firmwares.mjs` and the new harness boot the real engine. No test covers flash-chip behaviour at machine level except the harness.

## Known limitations (tests named `KNOWN LIMITATION` in selftest.mjs)
- Boot-area sector `0x0`: corrupting it has no effect (boot ROM/loader not run).
- Chip-key sector `0xFF000`: blank in the emulator and unused; corrupting it has no effect.
- Flash ID: selectable only as ID bytes (Component 2). The chips' other behaviour is specified by the reference model (Component 4 Stage A) but **not emulated**: the running engine still has instant program/erase, no WIP, no write-enable check on program, no page wrap, no protection.
- Not available in this engine: native ID export, flash fault injection, reset counter, flash timing, real update loader/USB OTA.

## Not tested
JIT mode, input injection (key/encoder/MIDI paths are written but untested), `--flash`/`--save-flash` file round trip through the CLI, firmware other than the three above, other OSes.
