# Headless FM-1 machine harness

Boots a real firmware package (`.fwsc`) on the emulated FM-1 with **no window, no audio device
and no Electron**: only Node 18+. It exists to test firmware and flash behaviour before risking
real hardware. It reads the bundled engine (`site/emulator/fm1_web.wasm`) but never changes it.

## Quick start

```bash
node ci/machine/selftest.mjs                                   # the harness's own checks (~45 s)
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

- Select or read the **flash JEDEC ID** (old `0x856014` vs new `0xB36014`).
- **Fault injection** inside the flash chip (power cut mid-write, failed write, stuck busy).
- Count **watchdog/chip resets**.
- **Bricking**: the boot ROM/loader is not emulated; corrupting the boot area (`0x0`) or the chip-key
  sector (`0xFF000`) has no effect here.
- The real update loader/USB update path; flash timing (erase/program are instant).
- A **hung** verdict: a static screen waiting for input looks identical to a stuck loop. A test must
  send a stimulus and judge the response for its own firmware.

Corrupted-flash behaviour *is* real for the app area: zeroing its start blanks the screen, erasing a
code sector halts the CPU (see `selftest.mjs`).

## Not yet wired into `npm test`

Deliberately standalone for now; hooking `ci/verify.mjs` is a separate step.
