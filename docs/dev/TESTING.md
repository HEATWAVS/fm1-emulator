# Testing

## How to run
```bash
npm test                              # existing suite + machine quick tier (ci/verify.mjs), ~13 s
npm run test:machine:quick            # machine quick tier alone, 19 tests, ~5 s
npm run test:machine                  # machine full tier, 30 tests, ~90 s (not run by npm test or CI)
node ci/machine/cli.mjs --fw felucca --corrupt erase:0x20000 --expect crashed
```
**Tiers (Component 3).** A machine test is quick if declared `test.quick(...)` in `ci/machine/selftest.mjs`; the full tier runs every test, so quick is a subset by construction. Quick tests run no firmware longer than the Felucca boot smoke test. `npm test` runs the quick tier through `ci/verify.mjs` with a **20 s hard timeout**; a failing quick test, a timeout, or an empty selection fails `npm test`. Output ends with `PASS: N machine tests (quick|full)`.
`cli.mjs` exit codes: 0 verdict matched `--expect`, 1 mismatch, 2 usage error or package would not boot.

## Results on record (2026-11-13, Windows 11, Node 24.19.0)
- `npm test`: PASS, 277 firmware packages (hashes, identities, order, source manifest, resource loader).
- Harness self-test: **30/30 pass** (16 Component 1 tests + 14 flash-ID tests, as approved). Felucca 1.8.2-beta, AURORA 0.9.1, Melodee 1.6.1 boot headless (3 s) and show a screen.
- Repeatability: two boots of Felucca give identical LCD hash, flash hash and engine clock (interpreter, no input).
- Corruption on Felucca: zero `0x4000` -> `blank`; erase `0x20000` -> `crashed` (CPU halt). Fixture-specific; other firmware may differ.
- Speed: about 1x real time at 100 MHz interpreter (3 s emulated ~ 3 s wall); stuck-loop runs can cost far more (one case ~14 s for 2 s of audio).

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
- Flash ID: selectable only as ID bytes (Component 2). The UC25HQ80's other behaviour is unknown and not emulated.
- Not available in this engine: native ID export, flash fault injection, reset counter, flash timing, real update loader/USB OTA.

## Not tested
JIT mode, input injection (key/encoder/MIDI paths are written but untested), `--flash`/`--save-flash` file round trip through the CLI, firmware other than the three above, other OSes.
