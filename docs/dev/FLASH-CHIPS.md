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

**Was it specified by the Stage A sources? Not at the time.** Stage A cited `4Bh` only in the command listings, so the model refused it (D42). The 4Bh Stage A extension
(next section) then read both dedicated sections and added it to the **reference model**, and the **engine port** (D48-D52) implements it in the chip-profile engine for both
profiles. The original model's `FM1-` pattern remains the **legacy** profile's answer, unchanged. Consequences for firmware under a profile: the ID **value** is in neither datasheet, so the engine has no ID unless a test configures one (`flashUid`). With none, 4Bh answers `FF` and the read is counted
as unknown, so quadro-fm1 and similar firmware take the documented "no unique ID" path, and a profile run does **not** reproduce the WiFi MAC / BLE name that the original model's fake `FM1-` pattern
(`46 4D 31 2D` repeated) produced. With a fixture configured they behave as the firmware's source says (see "Engine port results" below).

**Attribution (Stage C4).** The 4Bh answer is the only chip behaviour that changes quadro-fm1's and fm1-field's flash content between legacy and the Puya profile: a throwaway scratch engine returning the original `FM1-` pattern for `4Bh` made both firmware's flash identical to legacy (fm1-field's three extra writes disappear). So under a profile these firmware take their no-unique-ID path (fm1-field then stores generated data). FF is **not** equivalent to the `FM1-` pattern.

## Read Unique ID, 4Bh: the datasheet evidence (4Bh Stage A extension, 2026-11-13)

Read in full from both datasheets' dedicated sections (Puya V1.7 p.54 "10.41 Read Unique ID (RUID)", command table p.21; UC25HQ80 v1.2 p.43-44 "9.38 Read Unique ID (RUID) (4BH)",
Table-7 p.13), with the figures and tables rendered and read as images. Registry ids `ruid.*` in `chipspec.mjs`. Levels: **V** verified, **I** interpretation, **X** unspecified
(the model refuses), **U** unknown value.

| Question | Puya P25Q80H (V1.7) | UC25HQ80 (v1.2) | Level |
|---|---|---|---|
| Sequence | CS# low, `4Bh`, Dummy Byte1-4, 128-bit ID out, CS# high (p.54 text); Figure 10-42: command, "3 bytes dummy", one more dummy byte, ID from clock 40 | `4BH` "followed by four dummy bytes. Then, the 128-bit ID is shifted out" (p.43); Figure-40 identical; Table-7: `4BH 00H 00H 00H dummy (UID7-UID0) (continuous)` | **V**, same on both |
| Response length | a "128bit number" | a "128-bit number" | **V**: 128 bits = 16 bytes |
| Bit order | Figure 10-42: bits 127 ... 0, MSB first | Figure-40: bits 127 ... 0, MSB first | **V** bit order; **I** that byte 0 carries bits 127-120 (the datasheets label no bytes) |
| Dummy byte values | "dummy", no value given (command table: 4 DMY bytes, no address bytes, 1+ data bytes) | Table-7 lists `00H` for bytes 2-4 and "dummy" for byte 5 | Puya **I** (don't care, as for 0Bh); UC25HQ80 **X** for non-zero in bytes 2-4 (model refuses), byte 5 **I** (don't care) |
| Value of the ID | factory-set, read-only, unique per device; no value printed | same | **U**: the model reports the bytes as unknown (mask `FF`) unless a test supplies a fixture |
| Constant across reads, program/erase, power cycles | "factory-set read-only" | "factory-set read-only" | **I** (read-only and factory-set are stated; that it never changes is the reading) |
| More than 16 bytes | data bytes "1+" | "(continuous)"; unlike RDSFDP (9.39: rolls over to 0) nothing is said after the 128th bit | **X** (refused) |
| Wrong number of dummy bytes / CS# early | not described | not described | **X** (refused) |
| Timing, WIP, WEL | no timing parameter printed; listed under Other Commands | no timing parameter printed | **I**: a read, no cycle, WEL/status/array unchanged |
| During a program/erase/write-status cycle | not named | RDSFDP is "rejected without any effects on the cycle"; RUID's section says nothing | **X** (refused) |
| Differences between chips | none in structure | none in structure; only Table-7's explicit `00H` bytes | the dummy-value row |

Not stated anywhere in either document (so not modelled): whether protection bits or SRP affect it, whether deep power-down or reset affects it, any maximum clock frequency for RUID,
and the UID's internal structure. **Not changed:** the legacy (original) model keeps its fake `FM1-` pattern.

## 4Bh engine port: results (2026-11-13)

The chip-profile engine implements 4Bh exactly as the reference model: opcode, four dummy bytes, then 16 ID bytes byte 0 first; refusals counted as unspecified (`ruid.malformed`,
`ruid.beyond-128-bits`, `ruid.busy`, and `ruid.dummy-values` on the UC25HQ80 only); the fixture survives power cycles. With **no fixture** the bytes are `FF` and the read is counted as unknown
(`fm1_flash_events(3)`), so firmware behaves as it did before the port. Firmware effects (quadro-fm1 and fm1-field, Puya, 4 s, `usb: false`; fixtures are test values, never device IDs):

| unique ID the chip returns | quadro-fm1 | fm1-field |
|---|---|---|
| legacy model (`FM1-` pattern) | 3 writes; reference flash | 0 writes |
| none configured (`FF`, counted unknown) | 3 writes; flash differs from legacy | 3 writes (34 bytes, sector `0xDE000`) |
| the `FM1-` pattern as a fixture | **flash identical to legacy** | **0 writes, flash identical to legacy** |
| an arbitrary value | 3 writes; other bytes, repeatable | 0 writes |
| 16 bytes of `00` or of `FF` | **same as none configured** | **same as none configured** |

So the unique-ID-dependent behaviour is fully explained by the ID the firmware reads, and an ID of identical bytes is treated as "no unique ID", as fm1-base's `wifi.c` says. These are firmware
behaviours, not model defects.

## What real firmware does (AURORA fm1_flash.h)

Uses only `9F`, `05`, `35` (diagnostic), `06`, `20`, `02`, `0B`. Sequence: `WREN`; read status and require WEL (else error); erase or
program; poll `05` bit 0 (WIP) with a timeout (erase 500 ms, program 10 ms) and measure the time with a 24 MHz timer. An unknown JEDEC
ID is never written (matches `quadro-fm1` stopping writes on `B3 60 14`). So WEL checking and WIP/timing are the firmware-visible
behaviours that matter most.

## Interrupted operations (Component 5 research)

Summary only; the full evidence table, citations and design are in `FAULT-INJECTION.md`. **Neither datasheet states what the array holds after power is lost, or a reset is issued, during a
program, erase or chip erase (unspecified).** Verified: the state machine is reset to standby at power-up (Puya p.15, UC p.10), WEL and SUS bits clear at power-up (UC p.15, p.10; Puya p.22, p.25),
non-volatile status bits are retained, and a reset during program/erase means "the operation will be disabled, the data under processing could be damaged or lost" (Puya p.53, UC p.43).
Suspend/resume exist (Puya p.51-53, UC p.40-42) but are not modelled; a deep-power-down command during a cycle is rejected (UC p.34).

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
Tests: `node ci/machine/chiptests.mjs` (87 tests, milliseconds); also part of the machine self-test quick tier.
The same behaviour runs in the chip-profile engine (a Rust port, `fm1-soc/src/spichip.rs`); its tables are generated from `chipspec.mjs`, so the datasheet data has one source.

## Using the profiles in the application (Component 8, Stage 2, 2026-11-16)

The left side bar's **Flash chip test** panel selects the emulation: **Default (original engine)**; **Older FM-1 flash: Puya P25Q80H profile** (JEDEC `85 60 14`); **Newer FM-1 flash: UC25HQ80 profile** (JEDEC `B3 60 14`); or the original flash model on the unified engine (the baseline). Profile modes show *Chip timing*: typical or maximum cycle times (Stage A: typical is the default, maximum a stress profile). The same models, tables and timing as the harness (`flashChip`, `flashTiming`) run, built into `fm1_web_unified.wasm`; the chip commands, WEL, WIP, status registers, protection, page wrap, erase and program times and the other behaviours of this document apply unchanged. **Both are reference profiles from the datasheets; which physical chip is in a given unit is unresolved (above), and nothing in the application claims otherwise.**

How to read a report: "WIP seen: yes" means the firmware issued a program/erase and the model's write cycle was busy at some quantum; "unspecified" = commands the datasheets leave open or contradictory (the model ignores and counts them); "outside the model" = opcodes the model does not implement (the last is shown); `4Bh` unique-ID reads count as unknown unless a fixture is configured (the application configures none). **Compare chips** differences are what the two models did to this firmware in this run; the JEDEC remark is an inference. Upstream fm1-emu v0.5.1 added an ID-only `--flash-chip uc25hq80` (same IDs, no timing, status or protection); the unified engine does not use it.
