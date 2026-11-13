# Headless FM-1 machine harness

Boots a real firmware package (`.fwsc`) on the emulated FM-1 with **no window, no audio device
and no Electron**: only Node 18+. It exists to test firmware and flash behaviour before risking
real hardware. It reads the bundled engine (`site/emulator/fm1_web.wasm`) but never changes it.

## Quick start

```bash
node ci/machine/selftest.mjs                                   # the harness's own checks, full tier (~90 s)
node ci/machine/selftest.mjs --quick                           # quick tier only (~5 s); also run by `npm test`
node ci/machine/cli.mjs --fw felucca                           # boot a bundled firmware
node ci/machine/cli.mjs --package build/fw.fwsc --seconds 5    # boot your own build
node ci/machine/cli.mjs --fw felucca --corrupt zero:0x4000 --expect blank
node ci/machine/cli.mjs --fw felucca --corrupt erase:0x20000 --expect crashed --json
```

Exit code: `0` the verdict matched `--expect` (default `booted`), `1` it did not, `2` bad usage or
the file is not a bootable package. See the header of `cli.mjs` for every option.

### From a firmware project's `make test`

```make
FM1_EMU ?= ../fm1-emulator
test: build/fw.fwsc
	node $(FM1_EMU)/ci/machine/cli.mjs --package $< --seconds 5 --expect booted
	node $(FM1_EMU)/ci/machine/cli.mjs --package $< --seconds 5 --corrupt erase:0x20000 --expect crashed
```

## Choosing the flash chip ID (older vs newer hardware)

```bash
node ci/machine/cli.mjs --fw quadro-fm1 --seconds 4 --flash-id old    # Puya P25Q80, 85 60 14 (the default)
node ci/machine/cli.mjs --fw quadro-fm1 --seconds 4 --flash-id new    # UC25HQ80,  B3 60 14
```

In code: `Fm1Machine.boot(engine, pkg, { flashId: "puya" | "uc25hq80" })`; `machine.flashId()` reads it
back; `powerCycle()` keeps it (or `powerCycle({ flashId: ... })` swaps the chip while "off").

**This selects the ID only, it is not chip emulation.** Only the 3 bytes a firmware gets from a JEDEC
read change; timing, status bits, other commands and protection are unchanged. Firmware that checks
the ID does react (for example `quadro-fm1` stops writing flash on the newer ID).

How it stays safe: it patches the engine's memory (the engine file is never modified), only for an engine
build whose layout was validated (`FLASH_ID_LAYOUTS` in `engine.mjs`, keyed by the .wasm sha256), only on
the FM-1 board, only before the firmware runs. It finds the live copy of the engine's chip structure and
proves it with the engine's own `fm1_flash_revision` before writing; on any mismatch it refuses and leaves
memory untouched (`FlashIdError`: `unsupported-engine`, `layout-mismatch`, `no-live-copy`, `ambiguous`,
`unsupported-board`, `invalid-id`). Without the option nothing is touched. A rebuilt engine must be
re-validated before its hash is added.

## Choosing a flash chip PROFILE (realistic chip behaviour; needs a chip-profile engine)

```bash
node ci/engine/build.mjs --upstream /path/to/fm1-emu        # once: builds ci/engine/out/fm1_web_chips.wasm (never committed)
node ci/machine/cli.mjs --fw quadro-fm1 --seconds 4 --flash-chip puya                          # Puya P25Q80H reference profile, typical timing
node ci/machine/cli.mjs --fw quadro-fm1 --seconds 4 --flash-chip uc25hq80 --flash-timing maximum
node ci/machine/cli.mjs --fw felucca --engine some/other_engine.wasm --flash-chip puya      # any engine that exports the chip functions
```

In code: `Fm1Machine.boot(engine, pkg, { flashChip: "puya" | "uc25hq80" | "legacy", flashTiming: "typical" | "maximum" })`;
`machine.flashChipInfo` says what was selected, `machine.flashWip()` reads the chip's WIP bit (distinct from `observe().flashBusy`,
which is chip-select), `machine.flashEvents()` counts commands the model ignored as unspecified and opcodes outside it
(`{ unspecified, notModeled, lastNotModeled }`: the last such opcode, 0 = none).

- **This is not `flashId`.** `flashId` changes the three ID bytes of the *shipped* engine by a runtime patch and nothing else.
  `flashChip` selects a datasheet-based chip model (status register, WEL, WIP, protection, page wrap, cycle timing) inside the
  chip-profile engine. The two cannot be combined (`id-conflict`); `flashId` is unchanged.
- **Default = `legacy`:** the engine's original instantaneous model, no export is called, behaviour is exactly as before. Explicit
  `"legacy"` is the same. `flashTiming` needs a chip profile (`timing-needs-chip`); `typical` is its default.
- **Before the first render, only:** the profile is selected while the machine boots (after any flash restore, before the first instruction);
  there is no API to change the chip of a running machine. `powerCycle()` keeps it, or `powerCycle({ flashChip })` swaps it while "off".
  The chip's non-volatile status bits (BP, CMP, SRP0, QE, LB) are carried over for the same chip (boot option `flashNvStatus`, passed for you; WEL is
  not carried; lock-down SRP 1:0 returns to 0:0); a different chip swapped in starts with status 0.
- **Refusals** (`FlashChipError`, before anything boots): `invalid-chip`, `invalid-timing`, `timing-needs-chip`, `id-conflict`,
  `unsupported-engine` (the engine lacks `fm1_flash_chip`/`fm1_flash_timing`: the shipped engine does), `unsupported-board` (not the FM-1),
  `engine-refused`, `invalid-nv-status`, `nv-needs-chip`. The CLI exits 2 with the reason.
- Behaviour differences from the original model, the array-at-accept simplification and the known limitations: `ci/engine/README.md`.

## Flash-chip reference model (datasheet oracle)

`chipspec.mjs` + `chipmodel.mjs` model the Puya P25Q80H (documented reference profile; the physical older chip's
variant is unresolved) and the UC25HQ80 from their datasheets, every behaviour cited by page and section. Time is a
caller-supplied clock; timing is typical (default) or maximum. Where the datasheets are silent or contradict themselves it
throws `UnspecifiedBehavior` instead of guessing. Tests: `node ci/machine/chiptests.mjs` (also in the quick tier). It is a pure-JavaScript
specification and test oracle; the running emulator uses a Rust port of it only in the chip-profile engine (`ci/engine/`), verified against it
by replaying oracle transcripts.
Research, sources and the list of ambiguities: `docs/dev/FLASH-CHIPS.md`.

## Pieces

| File | Role |
|---|---|
| `engine.mjs` | Loads the WebAssembly engine, lists its exports, reports **capabilities** (never assumed) |
| `machine.mjs` | `Fm1Machine`: boot, run, observe, flash read/diff, input, `powerCycle()` |
| `flash.mjs` | Sector records, diffs, corruption (`zero`, `erase`, `flip`) |
| `monitor.mjs` | `watch()`: runs and judges: `booted` / `crashed` / `blank` / `display-lost` |
| `cli.mjs` | Command line; JSON output with `--json` |
| `selftest.mjs` | Checks the harness itself against bundled firmware (and runs the chip-model tests) |
| `chipspec.mjs`, `chipmodel.mjs`, `chiptests.mjs` | Flash-chip reference model and its 75 conformance tests |

Flash files (`--flash`, `--save-flash`) use the same record format the app saves: per 4 KiB sector,
a 4-byte little-endian offset then the 4096 bytes. A test can therefore run a firmware, save what it
wrote, and boot the next "power-on" from it (`machine.powerCycle()` does this in code).

## What it can observe

`halted` (the CPU hit something it cannot run), the engine and audio clocks, the screen (colour
count, picture hash), audio level, flash revision/busy, and which flash sectors differ from the
package. Inputs: keys, encoders, pot, MIDI bytes.

Two clocks: `audioMs` is what `run()` was asked for. `emulatedMs` is the engine's own clock, which
can be far ahead because the engine skips time while the firmware idles. Use `audioMs` for timeouts.

## What it cannot do (this engine)

Recorded as capabilities and `KNOWN LIMITATION` self-tests, so nothing passes by silently not testing:

- Make the running engine behave like either chip beyond its ID (timing, status/protection, page wrap): that
  is specified by the reference model below but is not an engine feature. No native ID-select export exists yet.
- **Fault injection** inside the flash chip (power cut mid-write, failed write, stuck busy).
- Count **watchdog/chip resets**.
- **Bricking**: the boot ROM/loader is not emulated; corrupting the boot area (`0x0`) or the chip-key
  sector (`0xFF000`) has no effect here.
- The real update loader/USB update path; flash timing (erase/program are instant on the shipped engine; a chip-profile engine with `flashChip` gives datasheet timing).
- A **hung** verdict: a static screen waiting for input looks identical to a stuck loop. A test must
  send a stimulus and judge the response for its own firmware.

Corrupted-flash behaviour *is* real for the app area: zeroing its start blanks the screen, erasing a
code sector halts the CPU (see `selftest.mjs`).

## In the test workflow

| Command | What runs | Time |
|---|---|---|
| `npm test` | the existing suite **plus the quick tier**, which has a 20 s hard limit (`ci/verify.mjs`) | ~13 s |
| `npm run test:machine:quick` | quick tier alone (104 tests: 29 harness incl. one real Felucca boot + 75 chip-model) | ~6 s |
| `npm run test:machine` | full tier: every test (163 = 88 harness + 75 chip-model), including the slower firmware-behaviour checks. 47 of them need the chip-profile engine (5 chip-engine checks + 42 live chip conformance tests) and are reported **SKIPPED** (not passed) when `ci/engine/out/` has none: 116 run | ~90 s (~160 s with the chip engine) |
| `node ci/machine/selftest.mjs --filter "chip live"` | only the live chip conformance tests (needs the chip engine) | ~9 s |

A test is quick if it is declared `test.quick(...)` in `selftest.mjs`; the full tier runs all tests, so the
quick tier is a subset. The full tier is not run by `npm test` or CI; it is validated on Windows (Node 24 and
Node 20) only. Firmware projects should call `cli.mjs` (see "From a firmware project's `make test`" above),
not these self-tests.
