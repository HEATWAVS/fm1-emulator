# Changelog

## 1.1.4 — 2026-11-20

- Flash chip compatibility is a box of its own under Now running, with a fold button like the other boxes: Default / Older / Newer chip buttons (picking one restarts the firmware on that chip), what the chip does, the warning, Compare chips and the explanations, always showing. A badge in the top bar names the chip while a chip mode is on. The sidebar's Clock is now called CPU clock.
- Compare chips gives a plain verdict (did the firmware start, show a screen, start its audio and write to flash on the older and newer chip models), a code check for the two chips' IDs, and a copyable report about that firmware only. Only Default mode saves; the chip models keep nothing.
- The Firmware radar moved to the right sidebar, under Install firmware, and the desktop window opens maximized.
- One engine: the unified engine with a validated CPU optimization (settled-loop early exit of core 1) now runs every firmware; no engine or optimization selection is needed. Frodhes runs about 2.9x faster; the other bundled packages are unchanged in behaviour with the optimization on or off.
- The Older chip and Newer chip modes now run the same optimized engine as Default, so heavy firmware such as Frodhes no longer overloads there. Checked on all 277 packages under both chip models (typical and maximum timing, JIT on and off): identical results with the optimization on and off. Compare chips still runs on the plain interpreter.
- README: states that the CPU optimization helps only firmware with an idle second core (about a quarter of the packages), and lists the heavy firmware that can run below real time.
- The previous engine remains for the front panel and as a reference mode in the Flash chip test panel.
- The XIP tail after the app area is decrypted (as upstream does), which the official stock firmware needs to start.
- Known limitations: see README (15 PLL0 packages, 6 audio-in packages, `dx747`/`clatter`, stock firmware sound/UI and speed, real audio device and Electron untested).

## 1.1.3 — 2026-11-11

- Windows USB recovery guidance and MASIF compatibility filtering.
- Focus and fullscreen buttons on the header next to Flash.
- Focus enlarges the LCD screen well to fit the viewport, not the whole panel.
- Release CI uploads all platform builds in one step; MIDI bridge tests run in verify.

## 1.1.2 — 2026-11-10

- Documented both production flash chips (0x856014 / 0xB36014) in recovery help.
- Patch bay with generative modules, presets, and cable motion.
- Desktop MIDI link to a real FM-1; Focus Mode; shorter Install confirm.
- Themes, wave app icon, open-license catalog cleanup.

## 1.1.1 — 2026-11-09

- Ported the private-app update set into the public tree while keeping the **open-license-only**
  catalog (259 packages). Closed / unlicensed firmwares stay private.
- Fixed Apple Silicon audio noise (issue #1): worker + stream queue (`engine.js` /
  `stream-worklet.js`). Fallback: `?engine=worklet`. Worker JIT on by default (`?jit=0` off).
- Neutral catalog naming (no “Firmware Hub” branding); open-license radar still filters licenses.
- Hide/show every bar and panel (`layout.js`); MIDI/Tape/Scope start folded.
- Compact install / recovery flow, Advanced recovery for M-Flasher only, USB check IPC,
  flash-core troubleshooting.
- Play-assist chain (transpose / chords / arp / scale), command palette, help, themes, scope,
  tuner, MIDI monitor, notes, and related tools.
- Desktop app update check against this public repo’s Releases; Mac ad-hoc codesign unchanged.

## 1.1.0 — 2026-11-09

- Expanded the public offline library from 115 to 259 unique, explicitly open-licensed FM-1 firmware packages.
- Refreshed all catalog packages to their current releases and ordered the library newest to oldest.
- Added AURORA 0.9.1 by twochannels, including its newer-UC25HQ80 flash compatibility update.
- Added an in-app firmware radar that compares the bundled catalog with the live firmware catalog and remembers new releases without downloading them until selected.
- Rebuilt firmware search as a visible all-catalog result list with accent-insensitive matching across names, IDs, versions, authors, licenses, products, and descriptions.
- Defaulted to software rendering on desktop to prevent the full-window black-screen failure after Start.
- Defaulted firmware execution to the stable interpreter; the JIT is now opt-in with `?jit=1`.
- Kept the animation loop alive after a transient detached WebAssembly view instead of freezing the panel.
- Added visible renderer recovery, desktop failure logs, truthful running-firmware identity, and package SHA-256/product checks.
- Added type-101 factory-resource loading so Melodee displays its own resources instead of falling back to another firmware's screen.
- Added a reproducible catalog verifier, exact source/hash manifest, third-party license texts, and release-CI validation.
