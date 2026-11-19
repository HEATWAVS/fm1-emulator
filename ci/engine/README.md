# Chip-profile test engine (`ci/engine/`)

A test-only build of the emulator engine whose flash chip behaves like a real Puya P25Q80H or UC25HQ80 (status register, WEL,
WIP, block protection, page wrap, datasheet cycle times) instead of the original instant model. It exists so firmware and the
headless harness (`ci/machine/`) can be tested against realistic chip behaviour before anything touches real hardware.

**The shipped `site/emulator/fm1_web.wasm` is never changed and never rebuilt by this.** The test engine is a *separate* file
that is generated on demand under `ci/engine/out/` (git-ignored) and is never committed.

## What it is built from
| Piece | Where | Pinned by |
|---|---|---|
| Upstream engine source: `joakimeriksson/fm1-emu` (MIT), tag `v0.3.0`, commit `631b790b191e87ea8b796d351cfe7e61ab366794` | your clone, or cloned by the script | commit id checked; files read from git objects |
| The chip-profile patch (`fm1-soc` `spiflash.rs`/`lib.rs`, new `spichip.rs`, `fm1-web` exports) | `chip-profiles.patch` | sha256 in `pin.json` |
| Protection/timing/ID tables (`spichip_tables.rs`) | **generated** from `ci/machine/chipspec.mjs` (the Stage A datasheet spec, the one source of truth) by `tables.mjs` | sha256 in `pin.json` |
| Build recipe | upstream's `web/build.sh` flags, in `pin.json` | – |

The upstream workspace needs crates.io for `fm1-live` (`cpal`). The four crates the web engine needs (`fm1-isa`, `fm1-core`,
`fm1-soc`, `fm1-web`) have no external dependencies, so the script builds them from a trimmed workspace
(`pin.json` `workspaceFiles`, root `Cargo.toml` with only those members) with `--offline`. Nothing is downloaded by cargo.

## Build
Requirements: Node, git, Rust (`rustc`/`cargo`) with the `wasm32-unknown-unknown` target (and the host target for `--test`).
The script installs nothing.

```bash
# recommended: use an existing clone of https://github.com/joakimeriksson/fm1-emu (it must contain the pinned commit; its working tree is not used)
node ci/engine/build.mjs --upstream /path/to/fm1-emu
# or let it clone the pinned tag into ci/engine/out/upstream (needs network)
node ci/engine/build.mjs
# also run the Rust host tests and the oracle replay, including the 4Bh and interrupted-operation (--with-fault) scenarios (about a minute more)
node ci/engine/build.mjs --upstream /path/to/fm1-emu --test
```
Output in `ci/engine/out/`: `fm1_web_chips.wasm` (the engine), `BUILD-RECORD.json` (toolchain, hashes), `src/` (the patched tree),
`target/`. The build fails, and says why, if the patch hash, the upstream commit, the generated tables or the exports differ
from `pin.json`.

### What the build verifies
1. the patch file's sha256 equals `pin.json`;
2. the pinned upstream commit exists in the clone;
3. `git apply --check` then apply (with `core.autocrlf=false`: the upstream blobs are LF) succeeds;
4. the generated tables' sha256 equals `pin.json` (if `chipspec.mjs` changes, rebuild and update `pin.json` deliberately);
5. the artifact's exports are **exactly** the 73 in `pin.json` (the 48 of an unpatched v0.3.0 build, twelve chip/test exports and thirteen fault-injection exports (`fm1_fault_*` incl. `fm1_fault_set_ranges`, `fm1_power_cut`, `fm1_cycles`; docs/dev/FAULT-INJECTION.md sections 12 and 13); the twelve chip/test exports are: `fm1_flash_chip`,
   `fm1_flash_timing`, `fm1_flash_wip`, `fm1_flash_events`, `fm1_flash_nv_status`, `fm1_flash_nv_restore`, `fm1_flash_uid_set`, `fm1_flash_uid_clear`, and four test-only bus hooks
   `fm1_test_bus_write32`, `fm1_test_bus_read32`, `fm1_test_advance_us`, `fm1_test_set_wp`; none removed) and its only import is `env.fm1_jit_compile`;
6. the artifact's sha256 equals the verified hash **for the same toolchain**. `pin.json` records one:
   `rustc 1.97.1 (8bab26f4f 2026-07-14)` on Windows x64 gives
   `28dacdb40cee4f7620f306f761a35b820116b62981874dfeb657afe269ba764e` (2,741,445 bytes; it was `70796e01...b785` before the D-1 bus fix, decision D80); an unpatched build of the same source with
   the same recipe gives `943d3cdf04d865de2cbe9e4d7787082353c0e9d90772e04af5b4292f72211bbe`. A different toolchain may produce a
   different hash legitimately: the build then says "no verified hash" and still checks everything else.

Windows is the only host verified. macOS and Linux are untested.

## Use
```bash
node ci/machine/cli.mjs --fw quadro-fm1 --flash-chip uc25hq80 --flash-timing maximum     # uses ci/engine/out/ automatically
node ci/machine/cli.mjs --fw felucca --engine ci/engine/out/fm1_web_chips.wasm --flash-chip puya
```
In code: `loadEngine({ wasmPath })`, then `Fm1Machine.boot(engine, pkg, { flashChip: "puya", flashTiming: "typical" })`
(see `ci/machine/README.md`). `FM1_CHIP_ENGINE=<file>` overrides the default engine location for the tests.
Without a built engine the live chip tests in `npm run test:machine` are reported as SKIPPED (never as passed).

## Behaviour with a chip profile selected (differs from the original model)
- program and erase need WEL; WIP is real and lasts the datasheet time (typical by default, maximum on request); WEL stays set until the cycle ends;
- `05h` returns the full status register, `35h` the high byte; WRSR works (BP/CMP/SRP/QE/LB), with `WP#` held high;
- page program wraps inside its 256-byte page and keeps only the last 256 bytes; erases `20h 52h D8h 81h 60h C7h`; BP/CMP protection;
- opcodes outside the model (for example `5Ah` SFDP) return `FF` and are counted (`fm1_flash_events(1)`; `fm1_flash_events(2)` is the most recent such opcode);
- **`4Bh` Read Unique ID is modelled** (from Puya p.54 / UC25HQ80 p.43-44; levels in `docs/dev/FLASH-CHIPS.md`): command, four dummy bytes, then 16 ID bytes, byte 0 (bits 127-120)
  first. **The ID's value is a caller-supplied fixture** (`fm1_flash_uid_set(w0..w3)`, `fm1_flash_uid_clear()`; harness option `flashUid`, CLI `--flash-uid`): it is per device
  and in neither datasheet, so the engine has none unless one is given and never invents one. **Without a fixture the bytes are `FF` and the read is counted as unknown**
  (`fm1_flash_events(3)`), which is what firmware saw before the port; FF is not equivalent to the legacy model's `FM1-` pattern. The fixture survives power cycles (it stays with
  the same chip; a different chip swapped in has none). UC25HQ80: non-zero values in dummy bytes 2-4 are refused (Table-7 lists 00H); Puya's dummy bytes are don't-care. Refused and
  counted as unspecified: CS# before the four dummy bytes, more than 16 bytes, 4Bh during a cycle. The legacy profile keeps its original `FM1-` answer exactly; behaviour the datasheets leave open is ignored and counted, never guessed;
- the JEDEC ID comes from the profile (`85 60 14` / `B3 60 14`), even on the SMK-37 board (harness refuses profiles there);
- **array-at-accept simplification:** the array changes when the program/erase command is accepted (chip select rises), while WIP and WEL follow the
  cycle time. The datasheets leave array contents during a cycle unspecified and reads during a cycle are not answered. Power loss *during* a
  cycle is Component 5 (fault injection); `FM1_FLASH_CUT` is not honoured under a profile;
- **non-volatile status bits survive `powerCycle()`**: BP4-BP0, CMP, SRP0, QE and LB3-1 are kept for the same chip profile (via `fm1_flash_nv_status` /
  `fm1_flash_nv_restore`), WEL is not, SRP1:SRP0 = 1:0 (lock-down) returns to 0:0, and a different chip swapped in while off starts with status 0. A cycle
  still running at power-off is treated as completing (power loss mid-cycle is Component 5);

## Test hooks (not for firmware; absent from the shipped engine)
`fm1_test_bus_write32/read32` drive the SoC bus (SPI0 `0x11C00`, chip select GPIO PD0 `0x500C0`) exactly as the CPU does, `fm1_test_advance_us` moves
the SoC cycle counter, `fm1_test_set_wp` sets the WP# pin. `ci/machine/chiplive.mjs` uses them so the chip can be exercised without running firmware and
with a clock the test controls. Do not use them while the machine is rendering.

## The unified engine (Component 8, Stage 2)
`node ci/engine/build.mjs --unified` also builds **`fm1_web_unified.wasm`**: this chip-profile engine plus the USB exports the shipped engine has
(`fm1_usb_plug`, `fm1_usb_conf`, `fm1_usb_conf_len`, `fm1_has_usr`), a USB audio-in host (`fm1_audio_in`, `fm1_audio_in_buf`, `fm1_audio_pending`,
`fm1_has_audio_in`) and `fm1_xip_tail` (the switch below). It is the engine the application uses for its chip-test modes; the shipped
`site/emulator/fm1_web.wasm` stays the Default. Its pin is `pin.json` `unified`; its binary is **committed** as `site/emulator/fm1_web_unified.wasm`
(sha256 `5d595ae778bf8cf7c698c463ff175efa0a08313d1272efd30db7b34d3d74e0c8`, 2,747,410 bytes, rustc 1.97.1 on Windows: the one toolchain verified; Stage 2's was `58bacde6…`, 2,746,487 bytes, before the PLL0 boot state below), so the
tests and the app never need a build. The build needs a clone of the **whole** upstream repository (it reads commit `9acb2df`; a shallow clone is refused).

How it is made: the pinned v0.3.0 tree with `chip-profiles.patch`, then `usb.rs` replaced **whole** by upstream commit
`9acb2df464c7d91347f0c114423d955d909f4448`'s (blob `43af499a63d5d8d00169f38fc53df8ebe9900fae`; the build proves it differs from v0.3.0's only at line 36,
the SPDX identifier, `GPL-3.0-only` to `MIT`), then `unified-engine.patch` (12 hunks: `fwsc.rs`, `fm1-soc/src/lib.rs` (the PLL0 boot state and its test), `usb.rs`, `fm1-web/src/lib.rs`). The pinned v0.3.0 `usb.rs` is
never used in a unified build. Notice: `LICENSES/MIT-fm1-emu.txt`, `NOTICE.md`.

Stage 2's scratch rebuild gate: the Stage 1 validated binary (built with the v0.3.0 `usb.rs`) and this build (with the `9acb2df` one) are the **same binary**
(identical sha256), so the Stage 1 measurements stand for it; the pipeline reproduces both `fm1_web_chips.wasm` (`28dacdb4…`) and the unified engine on one machine.

### PLL0 boot state (Component 8, Stage 4; the unified engine only)
`Soc::new` sets PLL0's two control words as a bootloader leaves them, taken verbatim from upstream fm1-emu commit `d2bcc331d039855060dcef78c3bcaebb193b213a` (2026-11-07, first in v0.5.0): `PLL0_CON0` = `0x119a0` := `0x4540_0203`, `PLL0_CON1` = `0x119a4` := `0x3f50_3026`, set in that order at the end of `Soc::new` with `sfr_set`; they stay plain registers. Nothing else of v0.4.0 or later is used. **The shipped Default engine is unchanged and starts every analog register at 0, so the unified engine deliberately differs from it for firmware that checks PLL0** (the application lists them by package hash in `site/emulator/pll0-firmware.json`, audited by `node ci/pll0-audit.mjs --check`) (felucca-bsp's audio driver does, before it starts ALNK0): `amb`, `amenity`, `assid`, `atek303`, `choppah`, `ctl`, `fm1-ripple`, `fmfam`, `krisjangle`, `loom`, `midimon`, `mutable`, `polly`, `remotefm1`, `sidou` of the 277 bundled packages start their audio here and not on Default. Upstream attributes the values to reads off FM-1s (felucca-bsp `chip/fm1_clock.h`); **this project has not verified them on hardware.**

### XIP-tail switch (`fm1_xip_tail(mode)`, before a boot)
**Mode 1 is the default** (changed 2026-11-18, D108): the bytes after the app area are decrypted up to the protected image's end, as upstream v0.3.0 and its newer versions do. Mode 0 leaves them as stored, as the shipped engine does (and as this engine did before D108).
The 3,488-byte difference (below) is exactly this. Mode 0 gives decoded XIP windows identical to the shipped engine's on 277 of 277 packages; mode 1 gives XIP and flash identical to a plain v0.3.0 build on 277 of 277.
Why the default changed: the official stock FM-1.fwsc keeps a small encrypted table entry (an `EXT_RESERVED` marker) there and does not start its audio engine without it decoded (it never leaves an idle state on the shipped engine or on this engine in mode 0); firmware that does not read the region are unaffected, and the two in the catalogue that do (`dx747`, `clatter`) write a different 33-byte flash record and show small audio differences (docs/dev/ARCHITECTURE.md). Which of the two matches real hardware for those two is **not known**; the stock firmware's boot is evidence for decoding the entry, not for the erased bytes after it.

## The optimized unified engine (settled-loop early exit; the engine of Default since D109)
`node ci/engine/build.mjs --optimized` (implies `--unified`) also builds **`fm1_web_frodhes_optimized.wasm`**: the unified engine plus `settled-loop.patch`, which gives core 1 an
early exit for a loop it provably cannot leave (`fm1_soc::machine::Settled1`): when core 1 is back at a pc with the same complete core state, clock and TIMER4 poll-detector state as
earlier in the same call, one round is single-stepped through the bus, and the remaining whole rounds are skipped only if that round changed nothing observable (no store, no read that is
not free of side effects, no clock move, no hardware lock, no interrupt core 1 could take). An adaptive hold-off stops the looking for up to 255 calls after calls that skipped nothing although core 1 did something observable
or the lookups were paid for and found no loop, and resumes by itself; the proof alone authorises a skip. This is **v5**; it supersedes v4 (patch `f0c787c8...`, wasm `a0dacf3f...`), whose hold-off counted only calls in which core 1 did something observable and so paid for the lookups forever on a core that computes with registers that never repeat (1.4 to 3.7 times slower on five bundled packages). v4's files and the evidence are kept in `audio-audit/unified-settled-loop-adaptive/v4-superseded/` and `audio-audit/stage2-validation/` (outside this repository). The switch is **off in every new boot**; a front end calls `fm1_settled_loop(1)` after a boot
(`fm1_settled_loop_stat(i)` reads the counters). The patch touches `fm1-soc/src/{machine.rs,periph.rs,lib.rs}` and `fm1-web/src/lib.rs` only, and applies to the tree `--unified` makes.
Its pin is `pin.json` `frodhesOptimized`; the binary is committed as `site/emulator/fm1_web_frodhes_optimized.wasm` and is **the engine Default runs** (D109): the page switches the early exit on after every boot of Default (`applyCpuOptimization` in `chipmode.js`, called by `worklet.js`). The shipped and the
unified engines are never read or written by this step. Evidence and measurements: the scratch reports of 2026-11-17 (outside this repository).

## Known limitations
- **No USB host in this (chip-profile) engine.** Upstream v0.3.0 has no `fm1_usb_plug` (a fork addition), so `usb: true` has no effect here; compare against
  the shipped engine only with `usb: false`. The **unified engine** has the host.
- **XIP-tail difference (explained in Stage 1).** This v0.3.0-based engine and the shipped engine differ in 3,488 of the 585,728 bytes of the
  decoded XIP window, at flash offsets `0x9225B-0x93000`: the shipped engine leaves the bytes after the app area as stored (erased `0xFF`), v0.3.0 decrypts
  them. The unified engine's `fm1_xip_tail` selects either (its default is the decrypting one, like this engine).
- Not proof of equivalence with the fork: see `docs/dev/TESTING.md` for exactly what was compared.
- The Rust crate's transcript tests are `#[ignore]` unless `FM1_CHIP_ORACLE` names a transcript (`gen-transcripts.mjs`); `build.mjs --test` does this for you.

## Files
`build.mjs` build and verify | `verify.mjs` pin checks | `pin.json` pins | `chip-profiles.patch` | `unified-engine.patch` (the unified engine) | `settled-loop.patch` (the optimized engine) | `tables.mjs`/`gen-tables.mjs` table generator |
`gen-transcripts.mjs` deterministic oracle transcripts from the Stage A model (about 4.7 MB, 145,587 lines; generated, not committed).
