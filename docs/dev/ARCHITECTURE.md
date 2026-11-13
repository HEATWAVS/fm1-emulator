# Architecture (verified findings)

Evidence tags: **[V]** verified in source or by running it; **[U]** uncertain.

## The app
- Electron shell (`main.js`, `preload.js`, `updater.js`) serves `site/` over `fm1://app` and loads `site/emulator/index.html` **[V]**. Windows-only extras: USB check/repair, bundled `vendor/M-Flasher`.
- Page (`site/emulator/*.js`, about 75 plain scripts sharing `window.FM1`, no bundler) **[V]**.
- Engine: `site/emulator/fm1_web.wasm` (2.6 MB), Rust compiled to WebAssembly. Exports about 60 `fm1_*` / `panel_*` functions; imports only `env.fm1_jit_compile` **[V]**.
- The page loads the same wasm twice: once as a drawing library (`panel_draw` paints the front panel), once in the audio path (worker `engine.js` -> `stream-worklet.js`; fallback `worklet.js`) **[V]**.
- Firmware: `.fwsc` packages (JieLi UFW/JLFS format, parsed in `fwsc.js`); catalog `site/emulator/firmwares.json`; booted via `fm1_boot_fwsc` plus `package-resources.js` **[V]**.
- Audio: firmware computes the sound on the emulated CPU; the engine hands out 44.1 kHz float frames (`fm1_out_l/r`) **[V]**.

## Emulated hardware (upstream source, MIT, `joakimeriksson/fm1-emu`)
- Two pi32v2 cores (JieLi AC791N), timers, interrupts, LCD 240x240, key matrix, encoders, MIDI, USB (limited), watchdog and chip reset, XIP + SFC decrypt **[V]**.
- SPI flash model `crates/fm1-soc/src/spiflash.rs`: 1 MiB; commands 9F (ID), 4B, 05/35, 06/04, 03/0B, 20, D8, 02. Default ID `85 60 14`; SMK-37 board sets `EB 60 14` (`lib.rs:736`). Instant erase/program, never busy, no chip erase/SFDP/quad, program does not check write-enable, no page wrap **[V]**.
- Native-only power cut: `FM1_FLASH_CUT=N` (environment variable, cannot work in wasm) **[V]**.

## Fork engine vs upstream
- The fork's wasm contains the path `crates\fm1-soc\src\spiflash.rs` **[V]**, but is **not** a build of upstream master: it lacks `fm1_cpu1_fault`, `fm1_cpu1_survives`, `fm1_lcd_timed`, `fm1_jit_selftest` and has extras (`fm1_usb_plug`, `fm1_audio_in`, `fm1_skin`, `fm1_has_usr`, ...) **[V]**. The author's public repos contain no engine source; `tools/sync-emulator-mirror.ps1` mentions a private repo **[V]**.
- Therefore never assume upstream is a drop-in replacement.
- Stage B (2026-11-13) built upstream v0.3.0 (commit `631b790`) separately and compared it in lockstep with the shipped engine (USB off for both: v0.3.0 has no `fm1_usb_plug`): every compared observable matched in 51 of 51 runs, with one reproducible difference outside those observables, the **XIP-tail difference**: 3,488 of the 585,728 bytes of the decoded XIP window differ, at flash offsets `0x9225B-0x93000`; the shipped engine shows erased bytes there as `0xFF`, v0.3.0 shows scrambled-looking values; present at boot for every firmware, no behavioural difference seen; **cause not investigated**. The shipped engine is therefore *not* byte-for-byte reproducible from public source; v0.3.0 is only a behavioural reference.

## Flash-chip structure in the fork's engine memory (validated 2026-11-13, engine sha256 `cdf039104a74...0278`)
- The engine keeps **3 copies** of its flash-chip structure in linear memory **[V]**. Each starts with a pointer to the flash bytes (`fm1_flash()`) and holds the 3 JEDEC ID bytes **48 bytes after that pointer**. The same offsets in all 3; identical across the 6 firmware checked.
- **One copy is live, two are stale** leftovers (probably from Rust moving the structure; the cause is not verified). Absolute addresses depend on the heap, so never hard-code them. Liveness is proven at runtime: the live copy has the revision word at **+36**; writing a sentinel there makes the engine's own `fm1_flash_revision()` return it (note: the export returns a signed i32; compare unsigned) **[V]**.
- Patching only the stale copies changes nothing; patching only the live copy equals patching all three **[V]** (selftest). Changing the live ID changes firmware behaviour: `quadro-fm1` stops writing flash on `B3 60 14`, AURORA's screen changes **[V]**.
- The firmware's behaviour on the new ID is consistent with `docs/Recovery.md` (older firmware keeps saves in RAM on the newer chip). The chip's other behaviour is unchanged: ID selection is not chip emulation **[V]**.
- Layout is build-specific; `engine.mjs` `FLASH_ID_LAYOUTS` lists validated hashes. A different engine build is refused.

## Headless harness (`ci/machine/`)
```
cli.mjs / selftest.mjs
  monitor.mjs  (watch -> verdict)    flash.mjs (records, diff, corrupt)
  machine.mjs  (Fm1Machine)          engine.mjs (loads wasm, capabilities)
  fm1_web.wasm, read-only
```
- Capabilities come from the engine's exports; a test needing a missing one throws (`requires()`).
- Flash record format = engine restore format = app save format: 4-byte LE offset + 4096 bytes. Restore works only before the first render **[V]**.
- Two clocks: `audioMs` (harness) and `emulatedMs` (engine, runs ahead through idle skipping) **[V]**.
- `flashid.mjs` (Component 2): `parseFlashId`, `locateLiveFlashId` (finds candidates from the flash pointer, proves the live one, refuses on any mismatch), `applyFlashId`, `readFlashId`. Used by `Fm1Machine.boot({ flashId })`, `machine.flashId()`, `powerCycle()` (the choice persists) and the CLI `--flash-id`. FM-1 board only, before the first instruction runs.

## Chip-profile engine (Component 4 Stage C; `ci/engine/`)
```
ci/engine/build.mjs  pinned upstream v0.3.0 (git objects) + chip-profiles.patch + tables generated from ci/machine/chipspec.mjs
                     -> ci/engine/out/fm1_web_chips.wasm  (git-ignored, never committed)   verified against pin.json
engine: fm1-soc/src/spichip.rs (byte-stream chip state machine)  <- spiflash.rs routes to it only when a profile is selected
harness: flashchip.mjs (options)  machine.mjs (boot: select before the first instruction)  engine.mjs (capabilities)  cli.mjs
```
- **Where the flash lives:** `SpiFlash` in `fm1-soc/src/spiflash.rs`, reached only through the SoC's SPI0 registers (`0x11C00`) and chip select, which is GPIO PD0 (`lib.rs`: `flash.set_cs`, `flash.write`). With no profile selected the original code runs, unchanged.
- **Time (C0 finding):** the chip uses the SoC cycle counter `Periph::cycles` (at `Periph::hz`), the same counter that drives TIMER4's 24 MHz count (what AURORA's `took_us` reads), USB frames and the SMK-37's SPI1 busy. `Soc` hands the flash the cycle count before each chip-select and SPI0 write (`SpiFlash::set_clock`). Idle skipping only moves the counter forward, to just before the next event, so a deadline compared with `cycles >= end` is never missed; SPI0 is not a "pure read" for the polling-loop skipper, so a loop polling flash is never skipped and a WIP poll sees real emulated time pass (one cycle per instruction). Durations are the datasheet figures rounded up to whole cycles.
- **Chip state machine:** WIP/WEL/BP/SRP/QE/LB/CMP, protection tables, page wrap and last-256 rule, erases `20h 52h D8h 81h 60h C7h`, `9Fh 05h 35h 03h 0Bh 06h 04h 01h 02h`. It is a port of the Stage A model, replayed against oracle transcripts (388 scenarios, 85,283 transactions; see TESTING.md). SPI0 moves whole bytes, so CS rising mid-byte cannot occur on the machine; those cases are exercised through the chip API only. Unspecified behaviour is never guessed: the command is ignored with no state change and counted (`fm1_flash_events`); opcodes outside the model (such as `4Bh`) return `FF` and are counted.
- **Simplification (D33): array at accept.** The array changes when a program/erase command is accepted (CS rises), as in the original model, while WIP and WEL follow the cycle time. The datasheets leave array contents during a cycle unspecified; array reads during a cycle return `FF`. `changed`/`revision` and the XIP mirror therefore update at accept, exactly as before. Power loss during a cycle is Component 5. `FM1_FLASH_CUT` (native only) is not honoured under a profile.
- **Not carried across a power cycle:** non-volatile status bits (BP, CMP, ...). `powerCycle()` boots a new machine whose chip status starts at 0.
- **Exports** (the shipped engine has none of them): `fm1_flash_chip(id)` (0 original, 1 Puya, 2 UC25HQ80), `fm1_flash_timing(0 typical | 1 maximum)`, `fm1_flash_wip()` (the status register's WIP bit, **separate** from the unchanged `fm1_flash_busy()`, which stays chip-select), `fm1_flash_events(0 unspecified | 1 not modelled)`. The unpatched v0.3.0 has 48 exports; the patched build 52.
- **No USB host:** v0.3.0 has no `fm1_usb_plug`; `usb: true` does nothing on this engine.

## Flash-chip reference model (Component 4 Stage A; `ci/machine/chipspec.mjs`, `chipmodel.mjs`, `chiptests.mjs`)
```
chipspec.mjs   datasheet data: profiles (puya, uc25hq80), timing, block-protect tables, BEHAVIORS registry + citations
chipmodel.mjs  ChipModel: transact(tx, {read, partialBits}) -> {outcome, out, unknown}; readStatus(); peek(); powerCycle(); ManualClock
chiptests.mjs  75 conformance tests (expected values typed from the datasheets, incl. all 64 chip-erase combinations per profile and both printed protection tables) + traceability check
```
- **Not connected to the running engine** (the chip-profile engine is a Rust port checked against it; see above). Pure JS; one chip-select transaction at a time; time from a caller-supplied clock; completion at start + typical (or maximum) duration.
- Modelled: WREN/WRDI, RDSR (05h/35h, 16-bit status), WRSR, page program (wrap, last-256, AND), page/sector/32K/64K/chip erase, 9Fh, reads 03h/0Bh, BP/CMP/SRP protection, WEL/WIP rules, power cycle. Chip erase: Puya runs it when the table says nothing is protected (p.24, p.38); the UC25HQ80 refuses the 14 BP/CMP combinations where its p.9 and p.28 statements conflict. Everything else throws `NotModeled`; anything the datasheets leave open throws `UnspecifiedBehavior` or is flagged in the `unknown` mask (FLASH-CHIPS.md).
- Profile IDs equal the harness's selectable flash IDs (`flashid.mjs` FLASH_IDS), tested.
