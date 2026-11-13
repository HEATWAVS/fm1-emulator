# Testing

## How to run
```bash
npm test                              # existing suite (ci/verify.mjs), ~8 s
node ci/machine/selftest.mjs          # headless harness self-test, ~90 s (not in npm test yet)
node ci/machine/cli.mjs --fw felucca --corrupt erase:0x20000 --expect crashed
```
`cli.mjs` exit codes: 0 verdict matched `--expect`, 1 mismatch, 2 usage error or package would not boot.

## Results on record (2026-11-13, Windows 11, Node 24.19.0)
- `npm test`: PASS, 277 firmware packages (hashes, identities, order, source manifest, resource loader).
- Harness self-test: **30/30 pass** (16 Component 1 tests unchanged + 14 flash-ID tests, see below). Felucca 1.8.2-beta, AURORA 0.9.1, Melodee 1.6.1 boot headless (3 s) and show a screen.
- Repeatability: two boots of Felucca give identical LCD hash, flash hash and engine clock (interpreter, no input).
- Corruption on Felucca: zero `0x4000` -> `blank`; erase `0x20000` -> `crashed` (CPU halt). Fixture-specific; other firmware may differ.
- Speed: about 1x real time at 100 MHz interpreter (3 s emulated ~ 3 s wall); stuck-loop runs can cost far more (one case ~14 s for 2 s of audio).

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
