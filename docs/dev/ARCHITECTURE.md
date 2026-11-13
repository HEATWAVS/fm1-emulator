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

## Flash-chip reference model (Component 4 Stage A; `ci/machine/chipspec.mjs`, `chipmodel.mjs`, `chiptests.mjs`)
```
chipspec.mjs   datasheet data: profiles (puya, uc25hq80), timing, block-protect tables, BEHAVIORS registry + citations
chipmodel.mjs  ChipModel: transact(tx, {read, partialBits}) -> {outcome, out, unknown}; readStatus(); peek(); powerCycle(); ManualClock
chiptests.mjs  75 conformance tests (expected values typed from the datasheets, incl. all 64 chip-erase combinations per profile and both printed protection tables) + traceability check
```
- **Not connected to the engine or the harness machine.** Pure JS; one chip-select transaction at a time; time from a caller-supplied clock; completion at start + typical (or maximum) duration.
- Modelled: WREN/WRDI, RDSR (05h/35h, 16-bit status), WRSR, page program (wrap, last-256, AND), page/sector/32K/64K/chip erase, 9Fh, reads 03h/0Bh, BP/CMP/SRP protection, WEL/WIP rules, power cycle. Chip erase: Puya runs it when the table says nothing is protected (p.24, p.38); the UC25HQ80 refuses the 14 BP/CMP combinations where its p.9 and p.28 statements conflict. Everything else throws `NotModeled`; anything the datasheets leave open throws `UnspecifiedBehavior` or is flagged in the `unknown` mask (FLASH-CHIPS.md).
- Profile IDs equal the harness's selectable flash IDs (`flashid.mjs` FLASH_IDS), tested.
