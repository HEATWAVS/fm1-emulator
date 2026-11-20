# Notices

The [MIT License](LICENSE) covers the FM-1 Emulator desktop wrapper and the parts of the web UI
authored for this project. The following third-party components are included under their own terms.

## Based on
A fork of [fm1-emu](https://github.com/joakimeriksson/fm1-emu) by Joakim Eriksson (MIT) — the
Rust→WebAssembly pi32v2 emulation engine and the base player page.

fm1-emu is Copyright (c) 2026 Joakim Eriksson and is distributed under the MIT License. Its copyright and
permission notice, which applies to the engine and the player page this project is based on, is reproduced
in full, unchanged, in [LICENSES/MIT-fm1-emu.txt](LICENSES/MIT-fm1-emu.txt) (the project's own
[LICENSE](LICENSE) is kept as it was). It covers the shipped engine (`site/emulator/fm1_web.wasm`), the
unified chip-test engine (`site/emulator/fm1_web_unified.wasm`) and the optimized unified engine
(`site/emulator/fm1_web_frodhes_optimized.wasm`, the engine that runs Default and the chip test modes: the unified engine plus this project's
`ci/engine/settled-loop.patch`, which adds an early exit for loops the second CPU core provably cannot leave; it is built from the same
upstream sources by `ci/engine/build.mjs --optimized`).

The unified engine is built from fm1-emu v0.3.0 (commit `631b790b191e87ea8b796d351cfe7e61ab366794`) with this
project's patches (`ci/engine/chip-profiles.patch`, `ci/engine/unified-engine.patch`), and with `usb.rs` taken whole
from fm1-emu commit `9acb2df464c7d91347f0c114423d955d909f4448` (blob `43af499a63`), which differs from v0.3.0's
copy only in its SPDX line (v0.3.0 declares `GPL-3.0-only`, that commit declares `MIT`, as the rest of the
repository). From fm1-emu commit `d2bcc331d039855060dcef78c3bcaebb193b213a` (MIT, the same notice) the unified engine also takes PLL0's two boot-state register values (Component 8, Stage 4). The source and the exact build are described in `docs/dev/ARCHITECTURE.md` and `ci/engine/README.md`.

## Bundled firmware
The `.fwsc` files under `site/` are the separate work of their authors, redistributed unchanged
under their own GPL, MPL, MIT, or other stated open-source licenses. See
[THIRD-PARTY.md](THIRD-PARTY.md) for authors and corresponding source,
[FIRMWARE-SOURCES.json](FIRMWARE-SOURCES.json) for exact package hashes and identities, and
[LICENSES](LICENSES/) for the license texts shipped with the application.

## Bundled tools
**M-Flasher** by Julius Vitkauskas (MIT) is bundled in the Windows build for FM-1 firmware backup,
restore, and recovery.

## Trademarks
"M-VAVE" and "FM-1" are trademarks of their respective owner. This project is an independent,
unofficial emulator and is not affiliated with, authorized by, or endorsed by M-VAVE. See
[DISCLAIMER.md](DISCLAIMER.md).
