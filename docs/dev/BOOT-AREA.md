# Boot area: evidence ledger (Component 7, Stage 7A)

Last updated: 2026-11-15. Status: **Stage 7A (evidence), reviewed and approved.** The diagnostic classifier (7B) and the scenarios (7C) are not implemented.

**Nothing here states what a physical FM-1 does.** Every entry below is a statement about this emulator, about the firmware packages, about decoded structure, or a claim made in project documentation. An emulator-defined verdict about the boot area must never be read as proof that a real unit is bricked, bootable or recoverable.

## Evidence levels

| Level | Meaning |
|---|---|
| **EMULATOR** | Directly implemented by the current emulator (read in its source and checked against the engine). |
| **PACKAGE** | Observed in the structure of the 277 catalogue packages. A package being self-consistent (valid CRC-16 fields) is **not** evidence that anything validates those fields. |
| **DECODED** | A structure or instruction sequence read statically from a package's `uboot.boot` body with the emulator's own instruction tables. Never executed. |
| **INFERRED** | A conclusion drawn from DECODED or PACKAGE facts. Always labelled; never established behaviour; never above DECODED. |
| **DOCUMENTED** | Stated in project documentation, not independently verified. |
| **UNKNOWN** | Not established. |

## Ledger

| # | Statement | Level | Method / source | Caveat |
|---|---|---|---|---|
| L1 | At package boot the emulator unpacks the **package's** flash image: it unmasks the 32-byte directory heads from offset 0x20 (CRC-16 keystream seeded 0xFFFF) until a head whose "last" field is non-zero; takes the chip key from `isd_config.ini`'s 32-byte blob (key formula in `fwsc.rs`), **checking the blob's CRC-16 but falling back to the unchecked key when no checked one exists**; needs an `app_dir_head` entry with flags 0x81; unscrambles the app area with the key; refuses ("no chip key or app area", "app area runs past the flash image") otherwise. It never checks the 32-byte header's CRC or any head's CRC. | EMULATOR | `fwsc.rs` `unpack_n`; reproduced by `ci/machine/fwscport.mjs`; cross-checked against the engine (below) | Runs once, on the package. |
| L2 | The engine does not read the live flash back into the key, the app window or the boot block: sectors restored after boot (`fm1_flash_restore`) change what the SPI chip holds and what the XIP window decrypts, not the key. A damaged sector 0 therefore changes nothing in the running emulator. | EMULATOR | `fm1_boot_fwsc`, `Soc::sfc_boot`, the sector-0 known-limitation test | Describes the current engine only. **Not evidence that sector-0 damage is harmless on hardware.** |
| L3 | The emulator imitates the SPL's hand-over: it passes the 32-byte flash header (unmasked, **not** CRC-checked) in a boot-parameter block to the firmware. | EMULATOR | `write_boot_info` | The imitation is the emulator's own. |
| L4 | All 277 packages share one raw 32-byte header; their directory has exactly four heads (`uboot.boot` at 0xA0, `isd_config.ini`, `app_dir_head` at 0x4000 flags 0x81, `key_mac`) in 6 layouts that differ only in body sizes and the offsets that follow from them; the header, every head and the key blob carry a valid CRC-16 in all 277; the gap between the end of `isd_config.ini` and 0x4000 is all 0xFF in every package; no image reaches 0xFF000. | PACKAGE | `ci/machine/bootareafacts.mjs`, `fixtures/bootarea-facts.json` | Self-consistency only. |
| L5 | The `key_mac` directory head names offset 0xFF000, size 4096, flags 0x12, and carries the "last" marker. | PACKAGE | same | The package directory names the region; **its contents and role are not established** (`0xFF000` is reported `unmodelled`). |
| L6 | `uboot.boot` has 6 distinct bodies: 267 packages share one (14,536 bytes, ends at 0x3968), the others have 14,384 (5), 14,488 (2), 14,560 (1), 14,444 (1) and 4,096 (1) bytes. | PACKAGE | same | |
| L7 | The key blob takes 2 variants (272 and 5 packages); the `isd_config.ini` entry is 45 bytes in 269 packages and 96, 699 or 755 bytes in 8; every package derives the key 0x980F, the value the project docs give. | PACKAGE, DOCUMENTED | same; `Recovery.md` | |
| L8 | The key function ignores most single-bit changes of the blob: 219 of 256 single-bit flips leave the derived key unchanged for the common blob, 169 of 256 for the other. A damaged blob therefore often fails its CRC while the derived key is unchanged. | EMULATOR | `fwscportcheck.mjs` | |
| L9 | Two of the 6 distinct bodies (the 267-package one and a single-package one) decode as plaintext pi32v2 code; the other four (9 packages) do not decode like code under the tried transforms (see reliability). | DECODED | read-only scratch scan | Coverage of the SPL analysis is 268 of 277 packages. |
| L9b | Nine packages have an SPL body that did not decode like code: `audiorouter`, `b1`, `beetle`, `beetleblue`, `clatter`, `dx747`, `etch`, `picovave`, `rupture` (`beetle` is one of the 17 surveyed firmware). Their SPL status stays **`boot-code-unknown`**; nothing is inferred about their contents and no behaviour is attributed to them. | DECODED (a negative result) | `fixtures/bootarea-spl-findings.json` (`undecodedSplPackages`) | The transforms tried were few; this is not proof that the bodies are encrypted or compressed. |
| L10 | The plaintext bodies contain: a hardware-CRC helper called from 14 (13) sites, 13 (12) of them followed within 8 instructions by a conditional branch; references to the CRC unit, the SFC decryption unit, the SPI0 flash controller, clock, timer and GPIO windows; the constants 0x4000 (9 times), 0x02000000 (4) and 0x100000 (1); no 0x1021 immediate; a table of about 60 configuration-key names including `app_dir_head`, `app_dir_head2`, `usb_update_mode`, `UARTUPDATE` and `UART_UPDATE_CUSTOM`. | DECODED | read-only scratch scan (`fixtures/bootarea-spl-findings.json`) | |
| L11 | The SPL **may** compute CRC-16s with the hardware unit and compare them with stored halfwords, **may** configure the SFC decryption unit, and **may** look directory entries up by name. Where a mismatch leads (refusal, update mode, a retry) was **not** traced. | INFERRED | from L10 | Not established. In particular no rule "the SPL rejects X" may be derived from it. |
| L12 | The packages carry no `app_dir_head2` entry although the SPL's name table lists one. | PACKAGE, DECODED for the two facts; any meaning **INFERRED only** | L4, L10 | **Not evidence of redundancy, fallback or recovery.** The meaning of the name is unknown. |
| L13 | A ROM download mode ("WL82 UBOOT1.00" USB disk), entered by REC at power-on or OCT-/OCT+ for about 10 s, an RP2040 wiring trick, the Unbricker/Transporter tools, "the unit stays in update mode until a whole image is written". | DOCUMENTED | `docs/Recovery.md`, `site/emulator/flash-core.js`, `install.js` | Not verified. |
| L14 | In the 8 s survey, 61 firmware-issued flash cycles over 17 firmware touch nothing below 0x4000 or at/above 0xFF000. Reads of the boot area by firmware are not observed (the chip engine has no per-address read trace). | EMULATOR (observation) | `docs/dev/fault-survey.json` | 8 s input script only. |
| L15 | What the mask ROM validates (header, directory, key, SPL body); whether it, or the SPL, refuses a flash with a bad CRC; what a changed `uboot.boot` or header does; what `0xFF000` holds; whether download mode survives boot-area damage; what the four undecoded bodies contain; anything about the stage before the SPL. | **UNKNOWN** | none | |

## Cross-check: the JS port against the engine (safeguard A)

`ci/machine/fwscportcheck.mjs` reproduces `fwsc.rs` (including the unchecked-key fallback) and compares it with the shipped engine (`fm1_boot_fwsc`, `fm1_xip`) on identical package bytes.

| Condition | 17 surveyed firmware | Catalogue |
|---|---|---|
| Unchanged package: the port's decrypted app window equals the engine's XIP window byte for byte | **17 of 17** | **277 of 277** (all keys 0x980F) |
| One blob bit flipped so that the key changes (CRC fails, fallback key used) | port and engine **agree in 17 of 17**: both refuse ("app area runs past the flash image", because the app head decrypts to garbage) | not run |
| A blob bit flipped that leaves the key unchanged (CRC fails) | **17 of 17**: the package still boots, the window is unchanged, the port flags the fallback | not run |
| Only the stored CRC changed | **17 of 17**: same key, fallback, window unchanged | not run |
| `app_dir_head` entry renamed | **17 of 17** both refuse | not run |
| `isd_config.ini` entry renamed | **17 of 17** both refuse | not run |

Consequences for the 7B rules (all EMULATOR level): a bad blob CRC alone is **not** a refusal (the fallback key is used, and the key is often unchanged); a changed derived key made the emulator's own unpacker refuse in 17 of 17 trials, because the app head decrypts to garbage, but a refusal in general depends on the garbage, so the classifier must run the ported unpack and report its result and whether the key and the decrypted window differ from the reference, not assume. None of this says the SPL or the ROM behaves the same way.

## Decoder reliability (read-only static scan)

Tool: a scratch Rust program outside the repository that copies the emulator's `fm1-isa` decoder tables, sweeps a block linearly with `decode_bytes` (resynchronising two bytes after an undecodable position) and records, per block, how many positions decode, how many do not, and whether relative branch targets land on decoded instruction starts. It never executes anything, and no listing or byte is stored in the repository.

| Block (14.5 KB) | Positions undecoded per 1,000 bytes | Relative targets on a decoded instruction start |
|---|---|---|
| Felucca app code (known executed code), two windows | 0.1 and 1.0 | 79 % and 75 % |
| Felucca window from 0x60000 (decodes like noise) | 90 | 66 % |
| Scrambled flash as stored | 91 | 66 % |
| Seeded random bytes | 90 | 64 % |
| `uboot.boot`, 267-package body | 1.7 | 85 % |
| `uboot.boot`, 1-package body (14,444 bytes) | 1.7 | 86 % |
| `uboot.boot`, the other four bodies (9 packages) | 90 to 96 | 61 % to 65 % |

The decoder accepts about 82 % of positions of noise, so **a successful decode of an instruction is not evidence**, and **no SPL validation or rejection behaviour has been established**. What separates code from noise is the density of undecodable positions (under 2 per 1,000 bytes against about 90) and branch-target coherence. On that basis the two plaintext bodies are code-like (they also contain ASCII string tables and peripheral constants consistent with the emulator's own SoC model); the other four are not decodable under the tried transforms (chip-key unscramble at two bases, 32-byte unmask with 0xFFFF and 0x980F) and are reported as such, not guessed at.

## Approved decisions for 7B

1. The classifier runs the validated `fwscport.mjs` unpacker on the damaged flash and compares with the intact reference. It reports unpack success or refusal, the refusal reason, whether the derived key differs and whether the decrypted window differs. These are emulator-defined results, never statements about physical bootability.
2. The scratch decoder stays outside the repository; only the reproduction method and the reliability limits are documented here.
3. The SPL status of the nine packages above stays `boot-code-unknown`.
4. `app_dir_head2` is INFERRED only.

## What 7B may use

- EMULATOR rules through the validated port (L1, L8, cross-check): bad blob CRC with an unchanged derived key is a *finding*, not unbootability; report the derived key and whether the decrypted window differs; report the unpack's refusal reason when it refuses.
- A changed `uboot.boot` body, header or gap is **never** `emulator-unbootable` merely for differing (L2, L3, L11, L15): `boot-code-unknown` or `boot-area-written` as approved.
- `0xFF000` changes: `unmodelled` (L5).
- Changed and indeterminate byte counts kept apart per region.
- No rule may cite L11 or L13 as an established fact.

## Reproduction

```bash
node ci/machine/fwscportcheck.mjs            # 17 firmware, every condition (about 1 s)
node ci/machine/fwscportcheck.mjs --all      # the unchanged-package condition for all 277
node ci/machine/bootareafacts.mjs            # the PACKAGE facts match fixtures/bootarea-facts.json
```

The SPL scan is a one-off made with a scratch tool outside the repository (a copy of the `fm1-isa` crate plus a linear-sweep scanner); `fixtures/bootarea-spl-findings.json` records its structural results only. It can be rebuilt from the description above.

## Limits

The scan reads two bodies (268 of 277 packages) and traces no control flow beyond call-site counts; it does not tell what the SPL does on a mismatch. Nothing here covers the mask ROM, USB, download mode or any hardware behaviour.
