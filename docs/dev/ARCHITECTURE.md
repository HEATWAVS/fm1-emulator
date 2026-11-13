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
