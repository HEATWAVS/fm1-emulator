# Boot area: evidence ledger (Component 7, Stage 7A)

Last updated: 2026-11-15. Status: **Stage 7A (evidence): committed (`d7832e0`). Stage 7B (the diagnostic classifier and its tests): committed (`75e9ae2`). Stage 7C (curated scenarios and deterministic reports): implemented, see "Stage 7C" below and `BOOT-AREA-SCENARIOS.md`.**

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

## Stage 7B: the diagnostic classifier

**What it is.** `ci/machine/bootarea.mjs` (pure) compares a flash image with an intact reference under the emulator's own package-unpacker rules (`fwscport.mjs`) and the package structure of 7A, and reports flags, a primary label and per-rule evidence. `bootareadiag.mjs` is the read-only machine adapter. **It is a diagnostic, not a boot gate:** `Fm1Machine.boot` and `machine.mjs` are untouched and never consult it, there is no boot ROM, no SPL execution, no update loader and no recovery model. `hardwareBootability` is fixed to `"unknown"`: an unpacker refusal is **not** proof that a physical unit is bricked, and an accepted image is not proof that one boots.

**Inputs.** The flash image; the intact reference (required for any verdict: without a valid one the primary label and the bootability are `not-evaluable` and only per-rule diagnostics of the image itself are given); optional indeterminate ranges (inclusive `[lo, hi]`, the chip-profile engine's list); optional `assume` (a HYPOTHETICAL recovery assumption). Malformed ranges or an unknown assumption throw `RangeError`; a bad image or reference is a result, not an error.

**Regions** are derived from the **intact reference's** directory, never from the damaged image: `header` (0 to 0x20), `directory` (the heads, up to the terminating head), `spl` (`uboot.boot` body), `keyBlob` (`isd_config.ini` body), `gap` (the bytes below the app area that none of those cover: one interval after the blob in 5 layouts, two in one; it is all 0xFF in every package), `appArea` (0x4000, for the reference's decrypted window), `keySector` (0xFF000, 4096 bytes, named by the `key_mac` head), `other`. Each byte belongs to exactly one (first match in that order). The committed `fixtures/bootarea-layout.json` records the 6 layouts, derived from all 277 packages (regenerate/check: `node ci/machine/bootareacatalogue.mjs [--write]`); a full-tier test regenerates it.

**Counts.** Per region the report keeps three independent numbers: `changed` (bytes that differ from the reference), `indeterminate` (bytes physically unknown after an interrupted cycle, ranges merged) and `both`, plus `changedKnown = changed - both`. A byte inside an unknown range holds a placeholder or a synthetic fill, so it is not evidence of a write: **rules use `changedKnown` for "written" and `indeterminate` for "at risk"**, and neither count absorbs the other. A synthetic `old` outcome that leaves every byte equal to the reference still reports the region at risk. A byte missing from a shorter image counts as changed (`image-length-differs`).

**Emulator part.** The damaged image is run through the port. The report gives the unpack result (`accepted` / `refused`) and the exact refusal text, whether the key was checked or came from the unchecked fallback, the derived key, whether it differs from the reference's, whether the decrypted window differs (and by how many bytes). A bad key-blob CRC alone is never a refusal (flag `key-blob-crc-fails`; the fallback key is the same key in most single-bit cases). If unknown bytes lie in what the unpacker reads (directory, key blob, app area) the verdict is `not-evaluable` with flag `emulator-result-on-placeholder-bytes`: the result would be on placeholder bytes. If the image's own directory never terminates, the rules about what that directory led to (`key-blob-crc-fails`, `derived-key-differs`, `app-window-differs`) are `not-evaluable`; no offset is ever taken from the damaged image.

**Labels and precedence:** `unmodelled` > `boot-area-at-risk` > `emulator-unbootable` > `boot-code-unknown` > `boot-area-written` > `emulator-bootable` (else `not-evaluable`). `flags` always lists every applicable label and detail flag, even when a higher one wins.

| Label | When | Evidence |
|---|---|---|
| `unmodelled` | any changed or unknown byte at 0xFF000 | PACKAGE (the `key_mac` head names it), UNKNOWN (contents and role) |
| `boot-area-at-risk` | unknown bytes in header, directory, SPL, key blob, gap or 0xFF000 (including when the bytes still equal the reference) | EMULATOR (the engine's own indeterminate list) |
| `emulator-unbootable` | the unpacker refuses the image while it accepts the reference | EMULATOR only |
| `boot-code-unknown` | a changed or unknown byte in header, directory, SPL or key blob (and the unpacker's verdict does not decide it) | PACKAGE, EMULATOR, DECODED, UNKNOWN |
| `boot-area-written` | a changed (known) byte in the gap | PACKAGE, UNKNOWN |
| `emulator-bootable` | the unpacker accepts the image | EMULATOR |

Every rule is listed in the report with its evidence labels, region, consequence and status (`applies` / `clear` / `not-evaluable`): see `RULES` in `bootarea.mjs`. A changed SPL body is **never** `emulator-unbootable` for differing; the SPL status is `boot-code-unknown` for every package, and the nine packages whose body did not decode (L9b) keep that status with `spl.decode = not-decodable-under-tried-transforms`. `app_dir_head2` is INFERRED, appears only as a note with `used: false` and supports no claim.

**Recovery.** `recovery.assessment` is always `recovery-unknown` (UNKNOWN). With `assume` set, `recovery.hypothetical` carries `HYPOTHETICAL: true`, `evidence: UNKNOWN` and a minimal outcome: `download-mode-available` → `recoverable-by-reinstall`, `external-programmer-available` → `recoverable-by-external-reflash`, `pessimistic-no-recovery-path` → `unrecoverable` (each `nothing-to-recover` for an image with no applicable boot-area label). It changes nothing else in the report. These are assumptions, not evidence: the ROM download mode is DOCUMENTED only (L13).

**New decisions made in 7B (flagged for review).** (1) A changed or unknown byte in the *directory* or the *key blob* (where the emulator still accepts the image) is `boot-code-unknown`, like the header and SPL: the SPL's use of them is unknown (L11); the 7B decisions fixed header, gap, SPL and 0xFF000 only. (2) A directory/key-blob/app-area byte that is unknown makes the emulator verdict `not-evaluable` (placeholder bytes), though the at-risk label still applies. (3) Without a valid reference the primary label is `not-evaluable` even when the image shows unknown bytes (the flags still say `boot-area-at-risk`). (4) A truncated image counts its missing bytes as changed; a truncated directory image is therefore `unmodelled` by precedence while its refusal and `directory-unterminated` are still reported.

**The divergence with the engine (EMULATOR, not hardware).** The engine boots a machine whose sector 0 is zeroed, because it unpacks the *package*, never the live flash (L2): the existing KNOWN LIMITATION tests stay and say so. The diagnostic labels that same flash `emulator-unbootable` ("no chip key or app area in the flash image"): the unpacker's rules, applied to the live flash. Neither says what hardware does. Pinned by a quick test (flash read, no run) and a full-tier test (the machine boots, draws, and still equals an undiagnosed twin).

**The machine adapter** reads `flash()`, `baseFlash()` and `indeterminateRanges()` and nothing else (a call spy test proves it; it never calls `observe()`, `run()`, `armFault`, `cutPower`, `powerCycle` or anything that changes state), and a before/after snapshot (flash, base, frames, audio accumulators, status, clock, fault state, cycles, chip status, indeterminate list) proves nothing changed, on the shipped engine and the fault-injection engine.

**Survey evidence (EMULATOR observation, L14):** a quick test re-derives from `docs/dev/fault-survey.json` that none of the 61 firmware-issued flash cycles (7 firmware, 0x97000 to 0xFCFFF) touches the boot region in the 8 s survey. It says nothing about other input or longer runs.

**Key-derivation boundaries.** `CHIP_KEY_VECTORS` in `fwscport.mjs` are seven synthetic blobs that pin the 0xE0/0x10 clamps and the strict comparison; `fwscportcheck.mjs` crafts a package for each (blob and app area scrambled with the listed key) and the shipped engine boots it to the expected window, so the engine derives exactly those keys (EMULATOR). The catalogue's two real blobs never reach those branches.

### Stage 7C: curated scenarios and deterministic reports

90 rows (`ci/machine/bootareascenarios.mjs`): 6 intact references (one package per layout), the 16 pure and 6 chip-engine scenarios of 7B (inherited by id), the 8-damage matrix on the five other layouts (40), 7 combined damages, 5 interrupted-cycle inputs, 1 recovery-assumption row, 7 new interrupted harness cycles on the chip-profile engine, and 2 divergence rows. Each row reports the primary label, the emulator verdict and the flags side by side, the unpacker's refusal, the per-region changed/indeterminate counts and the rules that applied with their evidence labels; `hardwareBootability` is `unknown` and the recovery assessment `recovery-unknown` in every row, and the only HYPOTHETICAL content is the recovery-assumption row. The results are in `ci/machine/fixtures/bootarea-scenarios.json` (machine-readable, one row per line, `reportSha256` `60699d37a731260c50662cde0fcef013790a939e0f276065943db67aea08b021`) and `BOOT-AREA-SCENARIOS.md` (generated, sha256 `db7004fab88617cd0b6e6b49d59eb92a06b0d7d55ef22684488e27141a6fa4a8`); `node ci/machine/bootareascenarios.mjs --check` rebuilds and compares them.

**Pairing guard.** Every reference is pinned by SHA-256 (package, intact image, and Felucca's engine base flash for the machine rows) and a wrong reference throws `ReferenceMismatchError` instead of being diagnosed against (D92).

**Findings the rows make visible (no classifier change; flagged in the 7C plan and approved).** (1) The primary label can hide the verdict: a flash zeroed everywhere is `unmodelled` while the emulator verdict is `emulator-unbootable`. (2) An interrupted cycle in the app area only gives primary `not-evaluable` (no boot-area rule applies and the app-area bytes the unpacker reads are unknown). (3) After an interrupted 4 KiB erase at 0x3000 with synthetic outcome `ff`, the rebooted flash shows a derived key that differs and an unpacker refusal, but the verdict stays `not-evaluable` because those bytes are unknown. (4) A gap program cut with outcome `new` changes 256 bytes but they are also unknown, so there is no `boot-area-written` flag. (5) The 4 KiB range at 0x3000 is at risk but still `emulator-bootable` for picovave, whose boot area ends at 0x10CD. (6) Both divergence rows boot a flash the diagnostic labels unbootable or at risk, because the engine boots from the package.

**Not claimed.** Nothing here says a unit would start or could be recovered; the interrupted outcomes are synthetic inputs; the SPL and the mask ROM are not run; a decoded SPL finding is not promoted; `app_dir_head2` decides nothing; 0xFF000 stays package evidence and unmodelled.

### Tests (counts in TESTING.md)

Quick tier (shipped engine): rule table and vocabulary; layout fixture against the 7A facts; scenario catalogue; 16 pure scenarios on Felucca (header, sector 0 zeroed/erased, key blob changing the key, bad CRC with the same key, stored CRC only, renamed `app_dir_head` / key entry, SPL bit, SPL uncertain, gap, 0xFF000, app only, unterminated directory, `old` outcome on sector 0 and on 0xFF000); app-area boundaries; unterminated directory; purity; the 17 surveyed firmware and the nine undecoded-SPL packages; the nine's SPL status; missing/invalid reference; independent counts; recovery defaults and hypotheticals; survey evidence; the adapter; the divergence. Full tier: all 277 intact packages, the regenerated fixture, the running divergence; with the chip engine (SKIPPED without it), interrupted 4 KiB erases at sector 0 and 0xFF000 under the outcomes `old`, `ff` and `zero`, diagnosed powered off and after the reboot (at-risk and unmodelled hold whatever bytes the outcome leaves), and the adapter on the fault-injection engine.

## Reproduction

```bash
node ci/machine/fwscportcheck.mjs            # 17 firmware, every condition and the chip_key vectors (about 1 s)
node ci/machine/fwscportcheck.mjs --all      # the unchanged-package condition for all 277
node ci/machine/bootareafacts.mjs            # the PACKAGE facts match fixtures/bootarea-facts.json
node ci/machine/bootareacatalogue.mjs        # the layout fixture matches the 277 packages (--write regenerates it)
node ci/machine/selftest.mjs --filter "boot area"   # the 7B and 7C tests (quick and full tier; the chip-engine tests are SKIPPED without the engine)
node ci/machine/bootareascenarios.mjs        # 7C: rebuild the 90 rows and compare with the committed report and summary (live rows SKIPPED without the chip engine)
node ci/machine/bootareascenarios.mjs --write   # regenerate both (needs the chip-profile engine)
```

The SPL scan is a one-off made with a scratch tool outside the repository (a copy of the `fm1-isa` crate plus a linear-sweep scanner); `fixtures/bootarea-spl-findings.json` records its structural results only. It can be rebuilt from the description above.

## Limits

The scan reads two bodies (268 of 277 packages) and traces no control flow beyond call-site counts; it does not tell what the SPL does on a mismatch. Nothing here covers the mask ROM, USB, download mode or any hardware behaviour.
