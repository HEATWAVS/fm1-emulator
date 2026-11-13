# FM-1 flash chips: research and reference model

Researched 2026-11-13. Source of truth for every modelled behaviour is `ci/machine/chipspec.mjs` (page-level
citations per behaviour and profile); this document explains the research and its limits. The model
(`ci/machine/chipmodel.mjs`) is an executable specification and test oracle, **not** part of the running emulator.

Evidence levels used everywhere: **verified** (the datasheet states it), **interpretation** (a reading, labelled),
**unspecified** (silent or self-contradictory: the model throws `UnspecifiedBehavior` instead of answering),
**not modelled** (out of scope: `NotModeled`).

## Sources

| Chip | Document | Notes |
|---|---|---|
| Older: Puya **P25Q80H** (reference profile) | [P25Q80H Datasheet V1.7, Jan. 01, 2021, 70 pp](https://www.puyasemi.com/download_path/%E6%95%B0%E6%8D%AE%E6%89%8B%E5%86%8C/Flash/P25Q80H_Datasheet_V1.7.pdf) | read page by page |
| Newer: **UC25HQ80** (UCUNDATA) | [UC25HQ80 Datasheet Version 1.2, 60 pp](http://www.ucuntech.com/uploads/20220324/d8602ea203b2303c2162d067ce715c4c.pdf) | read page by page |
| Real firmware usage | AURORA `firmware/hal/fm1_flash.h` and `fm1_flash_id.h` (twochannels/AURORA, GPL-3.0) | what a firmware actually asks of the chip |
| Emulator's current model | upstream `crates/fm1-soc/src/spiflash.rs` (joakimeriksson/fm1-emu, MIT) | the fork's compiled engine has no public source |

Re-fetching: WebFetch saves the PDF, which can then be read page by page. Page numbers in citations are PDF pages and
coincide with the printed ones in both documents.

## UNRESOLVED: which physical chip is in the older FM-1

`P25Q80H` is the **documented reference profile**, chosen because its `9F` ID table (`85 60 14`, p.50) matches the older
units' JEDEC ID. That is **not** confirmation that the physical older FM-1 contains exactly this variant: other Puya
variants may report the same ID and differ in details, and datasheet revisions differ. The project's notes (`docs/Recovery.md`,
AURORA's header comment) say "Puya P25Q80H/P25Q80"; no unit has been opened or probed. Settling it needs the chip marking
or a read of the status/SFDP registers from a real older unit. The same caveat applies in principle to the UC25HQ80
(its ID `B3 60 14` is in the vendor's Table-8.0, p.14).

## What the two datasheets say (verified)

**Identical:** 1 MiB; 256-byte pages; 4 KiB sectors; 32/64 KiB blocks; memory type `60`, capacity `14`, electronic ID `13`;
the 16-bit status register (S0 WIP, S1 WEL, S2-S6 BP0-BP4, S7 SRP0, S8 SRP1, S9 QE, S10 SUS2, S11-S13 LB1-LB3, S14 CMP,
S15 SUS1; `05h` reads S7-S0, `35h` reads S15-S8); the opcodes the model covers; the CMP=0 and CMP=1 block-protect tables
(compared row by row: identical); WEL set/clear/completion events; the CS#-on-a-byte-boundary rule; page-program wrap and
last-256-bytes rule; reads roll over to 0; erase/program on protected memory is ignored; chip erase runs only when nothing is protected (but the two datasheets word it differently, see the table below).

**Different:**

| | Puya P25Q80H V1.7 | UC25HQ80 v1.2 |
|---|---|---|
| `9F` manufacturer byte | `85` (p.50) | `B3` (p.14) |
| tPP typ / max | 2 ms / 3 ms (Table 5-4, p.11) | 1.5 ms / 3 ms (Table-18, p.53) |
| page, sector, 32K, 64K, chip erase typ / max | 8 ms / 20 ms (p.11) | 7 ms / 10 ms (p.53) |
| tW (write status register) typ / max | 8 ms / 12 ms (Table 5-3, p.10) | 8 ms / 12 ms (Table-17.1, p.53) |
| Configure Register (`15h` read, `31h` write, Dual Page 512-byte option) | yes (p.20, 25, 27) | not in the command table (p.12-13) |
| one-byte WRSR | CMP, QE, SRP1 cleared to 0 (p.26) | not stated (p.17) |
| WEL while a cycle runs | reset when the cycle completes (p.36-39) | reset "at some unspecified time before" completion (p.26-28) |
| program with CS# mid-byte | rejected, WEL not mentioned (p.39) | WEL "will not be reset" (p.12) |
| 32 KiB erase refused by protection | WEL reset (p.37) | not stated |
| **chip erase rule** | runs only when the BP bits are set to "None protected" (p.24, p.38): one rule, no conflicting sentence, **all 64 BP/CMP combinations are decided** (14 run, 50 are ignored) | p.9 says "None protected" and p.28 says "ignored if one, or more blocks are protected", but p.28 also says "executed only if all BP bits are 0": the statements **conflict at 14 of the 64 combinations**, 1 runs, 49 are ignored |
| suspend latency / min resume-to-suspend | 30 us / 20 us (p.11) | 45 us / 0.3 us (p.53); suspend not modelled |

Neither datasheet prints a **minimum** time; none is invented. Typical values are "TA=25C, not 100% tested"; maximum
values are the guarantee. Puya's Table 5-4 also lists a faster page-program row for ordering option "Q" (typ 0.6 ms,
max 1.5 ms; note 8): not modelled, the standard row is used.

## Where the datasheets are ambiguous (the model refuses; see `BEHAVIORS` with level `unspecified`)

- **UC25HQ80 chip erase only** (`prot.chip-erase-conflict`): p.9 says the command is executed only if the BP bits are set to
  "None protected"; p.28 says it is "ignored if one, or more blocks are protected" but also "executed only if all Block Protect
  bits are 0". The statements give opposite answers at 14 of the 64 BP/CMP combinations: CMP=0 with BP4 and/or BP3 set and
  BP2=BP1=BP0=0 (3: BP is not all 0 yet nothing is protected), CMP=1 with BP=00000 (1: BP is all 0 yet everything is protected),
  and the 10 CMP=1 combinations the table marks NONE. The model refuses exactly these. **Puya has no such conflict** (p.24 and p.38 give
  only the "None protected" rule): an earlier version of this model wrongly applied the UC25HQ80 ambiguity to Puya; it was found in
  review and fixed.
- **WEL after any rejected or ignored write command** (except the cases stated above): not stated; the model tracks WEL as
  unknown until the next WREN/WRDI/completion.
- **Writable bits while a WRSR cycle runs:** old or new value not stated; reported unknown until completion.
- **UC25HQ80 one-byte WRSR** effect on S15-S8; **UC25HQ80 WEL during a cycle.**
- **Commands issued while WIP=1** other than RDSR, RDID (program/erase only) and reads; **RDID during a WRSR cycle**;
  **array contents during a cycle**; **bytes after the 3 ID bytes**; **program with no data byte**; **addresses above 1 MiB**;
  **extra bytes after a command that takes none**; **SRP1:SRP0 = 1:1** (one-time-program, "available on special order").

## Interpretations (labelled, not stated outright)

Puya chip erase: "None protected" is read as the NONE state of the protected-area table (CMP=0 with BP2=BP1=BP0=0, BP4/BP3 any; CMP=1 with the rows `0 x 1 0 1` and `x x 1 1 x`), which is the only place the word NONE appears; WEL stays 1 until completion on Puya; "not executed" means no state change; an ignored (protected) command starts no cycle
(WIP stays 0); the last 256 bytes of an over-long program land at wrap positions from the start address; program ANDs
bits on the UC25HQ80 (Puya states "programming the memory to be 0"); LB1-LB3 only go 0 to 1; WIP is 1 from CS# rising
until start + the chosen duration (typical or maximum), and one figure covers a program of up to 256 bytes.

## Not modelled

Volatile status register (`50h`), Configure Register, Active Status Interrupt, suspend/resume, deep power-down, reset,
security registers, unique ID, SFDP, dual/quad, electronic-ID reads, burst wrap, and power loss during a cycle (that is
fault injection, a later component).

## What the emulator does today (for comparison)

Upstream `spiflash.rs`: ID only from `9F`; `05h` returns only WEL, `35h` returns 0; **WIP never set**, `busy()` is chip-select;
erase/program instant; `WREN`/`WRDI`; `03h`/`0Bh`; `20h` and `D8h` erase (need WEL); `02h` program ANDs bits but **does not
check WEL**, does not wrap in the page and is unbounded; no `01h`, `52h`, `60h`/`C7h`, `81h`; no protection. The fork's engine is
a black box: its `fm1_flash_busy()` was 1 in 16 of 1,100 audio quanta, all where flash was being written, consistent with
chip-select rather than a 2-20 ms write cycle (observation, inferential). None of these gaps can change in the shipped `fm1_web.wasm`.
The chip-profile test engine (`ci/engine/`, Component 4 Stage C) closes them for the modelled commands, in a separate never-committed
build selected with `flashChip`; see `ci/engine/README.md` for behaviour and limitations (array-at-accept, no USB host, XIP-tail difference).

## The `4Bh` command quadro-fm1 issues (resolved 2026-11-13, Stage C3)

Under the Puya profile quadro-fm1 1.0 triggers exactly one opcode the model does not cover: **`4Bh`, Read Unique ID**, at power-on (about 6 ms of audio time, 86 ms of
emulated clock), before any flash write, once. Under the UC25HQ80 profile it never issues it (that package does not recognise `B3 60 14`, so it skips the unique-ID read).
Other firmware compared (AURORA, Felucca, Melodee, coqui) never issues it. The identification is by the engine's own report (`fm1_flash_events(2)`).

**Firmware context** (public source, read-only): in `charlesvestal/fm1-base` `device/main_fm1.c` (about line 1239), right after the JEDEC ID is read and accepted
(`flash_ok = FM1B_FLASH_JEDEC_OK(id)`: `856014` or `B36014`), builds with WiFi or BLE read the part's 16-byte factory unique ID with `fl_uid_ram(flash_uid)` (opcode `4Bh`).
`plat_chip_uid()` returns it (or 0 if the ID was not accepted) and is used for the WiFi MAC (`device/wifi.c`) and the Bluetooth name (`device/radio.c`). `wifi.c` states the
case of "a part that does not answer 0x4B: all FF or all 0" and then falls back to the Bluetooth address. The package in the catalog (1.0) is older than the source read, so this
is the HAL's behaviour, not a statement about that exact binary.

**Is it specified by the Stage A sources? No.** Stage A cites `4Bh` only in each datasheet's command listing (Puya p.20-21 "10.1 Commands listing", UC25HQ80 p.13 Table-7):
the command exists on both chips, but the dedicated sections (dummy bytes, ID length) were not read, so nothing about its response is specified here. Decision D42: the model
answers `FF` and counts it; it does not invent a unique ID. Consequences: (1) quadro-fm1 and similar firmware take the documented "no unique ID" path under a profile, so a
profile run does **not** reproduce the WiFi MAC / BLE name that the original model's fake `FM1-` pattern (`46 4D 31 2D` repeated) produced; (2) to model `4Bh`, read the two
datasheets' Read Unique ID sections first (a Stage A extension).

## What real firmware does (AURORA fm1_flash.h)

Uses only `9F`, `05`, `35` (diagnostic), `06`, `20`, `02`, `0B`. Sequence: `WREN`; read status and require WEL (else error); erase or
program; poll `05` bit 0 (WIP) with a timeout (erase 500 ms, program 10 ms) and measure the time with a 24 MHz timer. An unknown JEDEC
ID is never written (matches `quadro-fm1` stopping writes on `B3 60 14`). So WEL checking and WIP/timing are the firmware-visible
behaviours that matter most.

## Using the model

```js
import { ChipModel, ManualClock } from "./ci/machine/chipmodel.mjs";
const clock = new ManualClock();                       // time is supplied by the caller: deterministic
const chip = new ChipModel({ profile: "uc25hq80", clock, timing: "typical" });   // or "puya"; "maximum" for stress
chip.transact([0x06]);                                 // WREN
chip.transact([0x02, 0x00, 0x10, 0x00, 0xaa]);         // page program: WIP=1 until start + tPP
clock.advance(1500);
chip.readStatus();                                     // { value, unknown }
```
Tests: `node ci/machine/chiptests.mjs` (75 tests, milliseconds); also part of the machine self-test quick tier.
The same behaviour runs in the chip-profile engine (a Rust port, `fm1-soc/src/spichip.rs`); its tables are generated from `chipspec.mjs`, so the datasheet data has one source.
