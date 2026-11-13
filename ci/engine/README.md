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
# also run the Rust host tests and the oracle replay (about a minute more)
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
5. the artifact's exports are **exactly** the 58 in `pin.json` (the 48 of an unpatched v0.3.0 build plus ten: `fm1_flash_chip`,
   `fm1_flash_timing`, `fm1_flash_wip`, `fm1_flash_events`, `fm1_flash_nv_status`, `fm1_flash_nv_restore`, and four test-only bus hooks
   `fm1_test_bus_write32`, `fm1_test_bus_read32`, `fm1_test_advance_us`, `fm1_test_set_wp`; none removed) and its only import is `env.fm1_jit_compile`;
6. the artifact's sha256 equals the verified hash **for the same toolchain**. `pin.json` records one:
   `rustc 1.97.1 (8bab26f4f 2026-07-14)` on Windows x64 gives
   `159acffe97a0942b16d4c1da12c3d1d9f92c5de1abb678287af48513bd21a926` (2,721,296 bytes); an unpatched build of the same source with
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
- opcodes outside the model (for example `4Bh` unique ID, which the original model answered) return `FF` and are counted
  (`fm1_flash_events(1)`; `fm1_flash_events(2)` is the most recent such opcode); behaviour the datasheets leave open is ignored and counted, never guessed;
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

## Known limitations
- **No USB host in this engine.** Upstream v0.3.0 has no `fm1_usb_plug` (a fork addition), so `usb: true` has no effect here; compare against
  the shipped engine only with `usb: false`.
- **Known XIP-tail difference (not investigated).** The shipped engine and this v0.3.0-based engine differ in 3,488 of the 585,728 bytes of the
  decoded XIP window, at flash offsets `0x9225B-0x93000` (the end of the window): the shipped engine shows the erased bytes there as `0xFF`,
  v0.3.0 shows scrambled values. Present at boot for every firmware, reproducible, no behavioural difference seen in any compared run.
- Not proof of equivalence with the fork: see `docs/dev/TESTING.md` for exactly what was compared.
- The Rust crate's transcript tests are `#[ignore]` unless `FM1_CHIP_ORACLE` names a transcript (`gen-transcripts.mjs`); `build.mjs --test` does this for you.

## Files
`build.mjs` build and verify | `verify.mjs` pin checks | `pin.json` pins | `chip-profiles.patch` | `tables.mjs`/`gen-tables.mjs` table generator |
`gen-transcripts.mjs` deterministic oracle transcripts from the Stage A model (about 4.7 MB, 145,587 lines; generated, not committed).
