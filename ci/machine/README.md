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

## Pieces

| File | Role |
|---|---|
| `engine.mjs` | Loads the WebAssembly engine, lists its exports, reports **capabilities** (never assumed) |
| `machine.mjs` | `Fm1Machine`: boot, run, observe, flash read/diff, input, `powerCycle()` |
| `flash.mjs` | Sector records, diffs, corruption (`zero`, `erase`, `flip`) |
| `monitor.mjs` | `watch()`: runs and judges: `booted` / `crashed` / `blank` / `display-lost` |
| `cli.mjs` | Command line; JSON output with `--json` |
| `selftest.mjs` | Checks the harness itself against bundled firmware |

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

- Model the **UC25HQ80's other behaviour** (only its ID is selectable, see above), or select an ID
  natively through an engine export (none exists yet).
- **Fault injection** inside the flash chip (power cut mid-write, failed write, stuck busy).
- Count **watchdog/chip resets**.
- **Bricking**: the boot ROM/loader is not emulated; corrupting the boot area (`0x0`) or the chip-key
  sector (`0xFF000`) has no effect here.
- The real update loader/USB update path; flash timing (erase/program are instant).
- A **hung** verdict: a static screen waiting for input looks identical to a stuck loop. A test must
  send a stimulus and judge the response for its own firmware.

Corrupted-flash behaviour *is* real for the app area: zeroing its start blanks the screen, erasing a
code sector halts the CPU (see `selftest.mjs`).

## In the test workflow

| Command | What runs | Time |
|---|---|---|
| `npm test` | the existing suite **plus the quick tier**, which has a 20 s hard limit (`ci/verify.mjs`) | ~13 s |
| `npm run test:machine:quick` | quick tier alone (19 tests, including one real Felucca boot) | ~5 s |
| `npm run test:machine` | full tier: every test (30), including the slower firmware-behaviour checks | ~90 s |

A test is quick if it is declared `test.quick(...)` in `selftest.mjs`; the full tier runs all tests, so the
quick tier is a subset. The full tier is not run by `npm test` or CI; it is validated on Windows (Node 24 and
Node 20) only. Firmware projects should call `cli.mjs` (see "From a firmware project's `make test`" above),
not these self-tests.
