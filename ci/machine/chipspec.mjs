// Datasheet-derived reference data for the two FM-1 flash chips, with a citation for every behaviour.
// DATA ONLY: used by chipmodel.mjs (the reference model) and checked by chiptests.mjs. Not used by the
// running emulator. See docs/dev/FLASH-CHIPS.md for the research behind it.
//
// Two chips, two independent profiles (they are deliberately NOT derived from one another, even where
// the datasheets say the same thing, so each can be checked and corrected against its own document):
//   puya      "Puya P25Q80H" reference profile, from Puya's P25Q80H Datasheet V1.7. Whether the physical
//             older FM-1 contains exactly this variant is UNRESOLVED (docs/dev/FLASH-CHIPS.md).
//   uc25hq80  UC25HQ80 (UCUNDATA), from the vendor's Datasheet Version 1.2.
//
// Behaviour levels (BEHAVIORS below):
//   verified        the datasheet states it; cited by page and section
//   interpretation  a reading of the datasheet, labelled as such (not stated outright)
//   unspecified     the datasheet is silent or contradicts itself: the model REFUSES to answer
//                   (throws UnspecifiedBehavior) instead of guessing
//   not-modeled     outside this model's scope; the model throws NotModeled
// Page numbers are the PDF/printed page (they coincide in both documents).

export const DOCS = {
  puya: {
    title: "Puya P25Q80H Datasheet V1.7 (Jan. 01, 2021), 70 pages",
    url: "https://www.puyasemi.com/download_path/%E6%95%B0%E6%8D%AE%E6%89%8B%E5%86%8C/Flash/P25Q80H_Datasheet_V1.7.pdf",
  },
  uc25hq80: {
    title: "UC25HQ80 Datasheet Version 1.2 (UCUNDATA), 61 PDF pages (printed numbers coincide with PDF pages)",
    url: "http://www.ucuntech.com/uploads/20220324/d8602ea203b2303c2162d067ce715c4c.pdf",
  },
};

export const GEOMETRY = { bytes: 1 << 20, page: 256, sector: 4096, block32: 32768, block64: 65536 };

// 16-bit status register: S15..S8 are read by 35h, S7..S0 by 05h (UC p8 Table-4; Puya p23 10.5).
export const SR = {
  WIP: 1 << 0, WEL: 1 << 1, BP0: 1 << 2, BP1: 1 << 3, BP2: 1 << 4, BP3: 1 << 5, BP4: 1 << 6, SRP0: 1 << 7,
  SRP1: 1 << 8, QE: 1 << 9, SUS2: 1 << 10, LB1: 1 << 11, LB2: 1 << 12, LB3: 1 << 13, CMP: 1 << 14, SUS1: 1 << 15,
};

// ---------------------------------------------------------------- block-protect tables
// Rows are written as in the datasheets: BP4 BP3 BP2 BP1 BP0 | protected range (x = don't care).
// UC25HQ80: Table-6.0 (CMP=0) p10-11 and Table-6.1 (CMP=1) p11, section 8 Data Protection.
const UC_CMP0 = `
x x 0 0 0 | none
0 0 0 0 1 | 0F0000-0FFFFF
0 0 0 1 0 | 0E0000-0FFFFF
0 0 0 1 1 | 0C0000-0FFFFF
0 0 1 0 0 | 080000-0FFFFF
0 1 0 0 1 | 000000-00FFFF
0 1 0 1 0 | 000000-01FFFF
0 1 0 1 1 | 000000-03FFFF
0 1 1 0 0 | 000000-07FFFF
0 x 1 0 1 | 000000-0FFFFF
x x 1 1 x | 000000-0FFFFF
1 0 0 0 1 | 0FF000-0FFFFF
1 0 0 1 0 | 0FE000-0FFFFF
1 0 0 1 1 | 0FC000-0FFFFF
1 0 1 0 x | 0F8000-0FFFFF
1 1 0 0 1 | 000000-000FFF
1 1 0 1 0 | 000000-001FFF
1 1 0 1 1 | 000000-003FFF
1 1 1 0 x | 000000-007FFF`;
const UC_CMP1 = `
x x 0 0 0 | 000000-0FFFFF
0 0 0 0 1 | 000000-0EFFFF
0 0 0 1 0 | 000000-0DFFFF
0 0 0 1 1 | 000000-0BFFFF
0 0 1 0 0 | 000000-07FFFF
0 1 0 0 1 | 010000-0FFFFF
0 1 0 1 0 | 020000-0FFFFF
0 1 0 1 1 | 040000-0FFFFF
0 1 1 0 0 | 080000-0FFFFF
0 x 1 0 1 | none
x x 1 1 x | none
1 0 0 0 1 | 000000-0FEFFF
1 0 0 1 0 | 000000-0FDFFF
1 0 0 1 1 | 000000-0FBFFF
1 0 1 0 x | 000000-0F7FFF
1 1 0 0 1 | 001000-0FFFFF
1 1 0 1 0 | 002000-0FFFFF
1 1 0 1 1 | 004000-0FFFFF
1 1 1 0 x | 008000-0FFFFF`;
// Puya P25Q80H: "P25Q80H Protected Area Sizes (CMP bit = 0)" p15 and "(CMP bit = 1)" p16, section 6 Data Protection.
const PUYA_CMP0 = `
x x 0 0 0 | none
0 0 0 0 1 | 0F0000-0FFFFF
0 0 0 1 0 | 0E0000-0FFFFF
0 0 0 1 1 | 0C0000-0FFFFF
0 0 1 0 0 | 080000-0FFFFF
0 1 0 0 1 | 000000-00FFFF
0 1 0 1 0 | 000000-01FFFF
0 1 0 1 1 | 000000-03FFFF
0 1 1 0 0 | 000000-07FFFF
0 x 1 0 1 | 000000-0FFFFF
x x 1 1 x | 000000-0FFFFF
1 0 0 0 1 | 0FF000-0FFFFF
1 0 0 1 0 | 0FE000-0FFFFF
1 0 0 1 1 | 0FC000-0FFFFF
1 0 1 0 x | 0F8000-0FFFFF
1 1 0 0 1 | 000000-000FFF
1 1 0 1 0 | 000000-001FFF
1 1 0 1 1 | 000000-003FFF
1 1 1 0 x | 000000-007FFF`;
const PUYA_CMP1 = `
x x 0 0 0 | 000000-0FFFFF
0 0 0 0 1 | 000000-0EFFFF
0 0 0 1 0 | 000000-0DFFFF
0 0 0 1 1 | 000000-0BFFFF
0 0 1 0 0 | 000000-07FFFF
0 1 0 0 1 | 010000-0FFFFF
0 1 0 1 0 | 020000-0FFFFF
0 1 0 1 1 | 040000-0FFFFF
0 1 1 0 0 | 080000-0FFFFF
0 x 1 0 1 | none
x x 1 1 x | none
1 0 0 0 1 | 000000-0FEFFF
1 0 0 1 0 | 000000-0FDFFF
1 0 0 1 1 | 000000-0FBFFF
1 0 1 0 x | 000000-0F7FFF
1 1 0 0 1 | 001000-0FFFFF
1 1 0 1 0 | 002000-0FFFFF
1 1 0 1 1 | 004000-0FFFFF
1 1 1 0 x | 008000-0FFFFF`;

export function parseProtection(text) {
  return text.trim().split("\n").map((line) => {
    const [left, right] = line.split("|").map((s) => s.trim());
    const pattern = left.split(/\s+/).map((c) => (c === "x" ? "x" : Number(c)));   // BP4 BP3 BP2 BP1 BP0
    if (pattern.length !== 5) throw new Error(`bad protection row: ${line}`);
    const range = right === "none" ? null : { lo: parseInt(right.slice(0, 6), 16), hi: parseInt(right.slice(7), 16) };
    return { pattern, range };
  });
}

/** The row of `rows` that matches bp = [BP4, BP3, BP2, BP1, BP0]; exactly one must (checked by the tests). */
export function protectionRows(rows, bp) {
  return rows.filter((r) => r.pattern.every((c, i) => c === "x" || c === bp[i]));
}

// ---------------------------------------------------------------- profiles
// Timing in microseconds, as printed (typ and max only: the datasheets give no minimum, and none is invented).
export const PROFILES = {
  puya: {
    name: "puya",
    label: "Puya P25Q80H (V1.7 reference profile)",
    jedec: [0x85, 0x60, 0x14],
    // Table 5-4 p11 (tPP, tPE, tSE, tBE1, tBE2, tCE) and Table 5-3 p10 (tW). tPP row used: the standard one (typ 2, max 3 ms).
    timingUs: {
      typical: { pp: 2000, pe: 8000, se: 8000, be32: 8000, be64: 8000, ce: 8000, wrsr: 8000 },
      maximum: { pp: 3000, pe: 20000, se: 20000, be32: 20000, be64: 20000, ce: 20000, wrsr: 12000 },
    },
    protection: { cmp0: parseProtection(PUYA_CMP0), cmp1: parseProtection(PUYA_CMP1) },
  },
  uc25hq80: {
    name: "uc25hq80",
    label: "UC25HQ80 (UCUNDATA, Datasheet v1.2)",
    jedec: [0xb3, 0x60, 0x14],
    // Table-18 p53 (tPP, tPE, tSE, tBE1, tBE2, tCE) and Table-17.1 p53 (tW).
    timingUs: {
      typical: { pp: 1500, pe: 7000, se: 7000, be32: 7000, be64: 7000, ce: 7000, wrsr: 8000 },
      maximum: { pp: 3000, pe: 10000, se: 10000, be32: 10000, be64: 10000, ce: 10000, wrsr: 12000 },
    },
    protection: { cmp0: parseProtection(UC_CMP0), cmp1: parseProtection(UC_CMP1) },
  },
};

// ---------------------------------------------------------------- behaviour registry
const P = (page, section, note) => ({ doc: "puya", page, section, ...(note ? { note } : {}) });
const U = (page, section, note) => ({ doc: "uc25hq80", page, section, ...(note ? { note } : {}) });
const V = (cites, note) => ({ level: "verified", cites, ...(note ? { note } : {}) });
const I = (cites, note) => ({ level: "interpretation", cites, ...(note ? { note } : {}) });
const X = (cites, note) => ({ level: "unspecified", cites, ...(note ? { note } : {}) });
const N = (cites, note) => ({ level: "not-modeled", cites, ...(note ? { note } : {}) });

export const BEHAVIORS = {};
const add = (id, summary, puya, uc25hq80) => { BEHAVIORS[id] = { summary, ...(puya ? { puya } : {}), ...(uc25hq80 ? { uc25hq80 } : {}) }; };

// --- geometry, identity
add("geometry", "1 MiB array, 256-byte pages, 4 KiB sectors, 32/64 KiB blocks",
  V([P(17, "7 Memory Address Mapping"), P(25, "10.6 RDCR: default page size 256 bytes (DP=0)")], "the 512-byte Dual Page option (DP=1) is not modelled"),
  V([U(6, "5 Memory Organization, Table-2.0 and Table-3.0")]));
add("id.rdid", "9Fh returns manufacturer, memory type, capacity (3 bytes)",
  V([P(50, "10.35 RDID, Table ID Definitions: 85 60 14")]),
  V([U(14, "Table-8.0 ID Definition: B3 60 14"), U(39, "9.32 RDID")]));
add("id.rdid-busy", "RDID during a program or erase cycle is not decoded and does not disturb the cycle",
  V([P(50, "10.35 RDID")]), V([U(39, "9.32 RDID")]));
add("id.rdid-busy-wrsr", "RDID during a write-status-register cycle",
  X([P(50, "10.35 RDID names only Program/Erase")]), X([U(39, "9.32 RDID names only Erase/Program")]));
add("id.rdid-extra-bytes", "reading more than the 3 ID bytes with 9Fh",
  X([P(50, "10.35 RDID: 24-bit ID, nothing after it")]), X([U(14, "Table-8.0"), U(39, "9.32 RDID")]));

// --- read unique ID (4Bh). Added in the 4Bh Stage A extension; read from both datasheets' dedicated sections (P p54 10.41, U p43-44 9.38) and
// command tables (P p21, U p13), the figures rendered and read as images. The ID's VALUE is per device and appears in neither document.
add("ruid.command", "4Bh Read Unique ID: opcode, then four dummy bytes, then the unique ID is shifted out; CS# high ends the command",
  V([P(54, "10.41 RUID text: 'Dummy Byte1 -> Dummy Byte2 -> Dummy Byte3 -> Dummy Byte4 -> 128bit Unique ID Out -> CS# goes high'; Figure 10-42"), P(21, "10.1 Command set (Cont'd): RUID 4Bh, DMY bytes 4, data bytes 1+")]),
  V([U(43, "9.38 RUID: 'the command code 4BH followed by four dummy bytes. Then, the 128-bit ID is shifted out'"), U(44, "Figure-40: command, 3 bytes dummy, dummy byte, 128 bit unique serial number"), U(13, "Table-7: 4BH 00H 00H 00H dummy (UID7-UID0) (continuous)")]));
add("ruid.length-order", "the ID is 128 bits (16 bytes) and the first bit shifted out is bit 127 (MSB); byte 0 of the response carries bits 127-120",
  I([P(54, "10.41 RUID: 'factory-set read-only 128bit number'; Figure 10-42 shows bits 127 ... 0, MSB first"), P(4, "Features: 128 bit unique ID for each device")], "verified: 128 bits, MSB (bit 127) first; interpretation: the bits are grouped into bytes in transmission order, byte 0 = bits 127-120 (the datasheet labels no bytes)"),
  I([U(43, "9.38 RUID: 'factory-set read-only 128-bit number'"), U(44, "Figure-40: bits 127 ... 0, MSB first"), U(4, "Features: 128-Bit Unique ID for each device")], "verified: 128 bits, MSB (bit 127) first; interpretation: grouped into bytes in transmission order, byte 0 = bits 127-120"));
add("ruid.dummy-values", "the values of the dummy bytes",
  I([P(54, "10.41 RUID: 'Dummy Byte1-4'")], "the datasheet calls them dummy and gives no value; read as don't-care, as the model reads 0Bh's dummy byte"),
  X([U(13, "Table-7: bytes 2-4 are listed as 00H, byte 5 as dummy"), U(43, "9.38 RUID: 'four dummy bytes'")], "the table lists 00H for the first three; whether another value changes anything is not stated, so the model refuses non-zero values there. The fourth (dummy) byte is read as don't-care"));
add("ruid.constant", "the ID is factory-set and read-only, so a read returns the same value every time, unchanged by program, erase, write-status and power cycles",
  I([P(54, "10.41 RUID: 'factory-set read-only 128bit number that is unique to each P25Qxx device'")], "'factory-set' and 'read-only' are stated; that this means a constant value is the reading"),
  I([U(43, "9.38 RUID: 'factory-set read-only 128-bit number that is unique to each UC25HQxx device'")], "'factory-set' and 'read-only' are stated; that this means a constant value is the reading"));
add("ruid.value", "the value of the unique ID",
  X([P(54, "10.41 RUID: unique to each device; no value is printed")], "per-device and not in the datasheet: the model reports the bytes as unknown (mask 0xFF) unless the caller supplies a fixture, which is a test choice, not a datasheet claim"),
  X([U(43, "9.38 RUID: unique to each device; no value is printed")], "per-device and not in the datasheet: the model reports the bytes as unknown (mask 0xFF) unless the caller supplies a fixture"));
add("ruid.beyond-128-bits", "reading more than 16 bytes with 4Bh",
  X([P(21, "10.1 Command set: data bytes '1+'"), P(54, "10.41 RUID: 128 bit ID Out, then CS# goes high")], "continued clocking is allowed by the table but the content after the 128th bit is not defined"),
  X([U(13, "Table-7: '(continuous)'"), U(44, "Figure-40: 128 bit unique serial number")], "unlike RDSFDP (9.39: rolls over to 0), RUID's text does not say what follows the 128th bit"));
add("ruid.malformed", "4Bh with fewer or more than four dummy bytes before the data",
  X([P(54, "10.41 RUID: exactly four dummy bytes in the sequence")], "CS# rising early, or other lengths, are not described"),
  X([U(43, "9.38 RUID: 'four dummy bytes'")], "CS# rising early, or other lengths, are not described"));
add("ruid.no-cycle", "RUID is a read: it starts no cycle (WIP stays 0) and leaves WEL, the status register and the array unchanged; neither datasheet gives a timing figure for it",
  I([P(54, "10.41 RUID: accesses a read-only number"), P(21, "10.1 Command set (Cont'd): listed under Other Commands; no write-enable requirement stated")], "a read of a read-only number; no AC timing is printed for RUID"),
  I([U(43, "9.38 RUID: accesses a read-only number"), U(13, "Table-7: no WREN involved")], "a read of a read-only number; no AC timing is printed for RUID"));
add("ruid.busy", "4Bh while a program/erase/write-status cycle is in progress",
  X([P(18, "8 Device Operation: the commands accepted during a cycle are not listed for RUID")], "not stated"),
  X([U(44, "9.39 RDSFDP: 'rejected without having any effects on the cycle'; 9.38 RUID says nothing")], "UC states it for RDSFDP only"));

// --- interrupted operations (Component 5, Stage 5B). READ docs/dev/FAULT-INJECTION.md section 2: every page of both datasheets was searched; NEITHER states the array contents
// after power is lost (or a reset is issued) during a program/erase. The entries below separate what is stated (V), what is read from it (I), what is not stated (X) and what is out of
// scope (N). The model records interruption, range and indeterminate state ONLY; synthetic fills live in faultpolicy.mjs and are never datasheet claims.
add("fault.powerup-standby", "at power-up the state machine is reset to standby: an interrupted cycle is never resumed",
  V([P(15, "6 Data Protection: 'The state machine will be reset as standby mode automatically during power up'")], "that no cycle resumes is the reading of 'reset to standby'"),
  V([U(10, "8 Data Protection: 'The state machine will be reset to standby mode automatically during power up'")], "that no cycle resumes is the reading of 'reset to standby'"));
add("fault.status-after-restore", "after power returns WIP is 0 (no cycle is running); the datasheets print no WIP value for power-up",
  I([P(15, "6 Data Protection: state machine reset to standby at power-up")], "WIP is read as 0 because a cycle in standby is not running; not stated outright"),
  I([U(10, "8 Data Protection: state machine reset to standby at power-up")], "WIP is read as 0 because a cycle in standby is not running; not stated outright"));
add("fault.wel-sus-cleared", "WEL and the suspend bits are 0 after power returns",
  V([P(22, "10.3 WRDI: WEL reset by Power-up"), P(25, "10.5 SUS1 and SUS2 bits: cleared by a power-down, power-up cycle")]),
  V([U(15, "9.2 WRDI: 'the WEL bit is automatically reset after Power-up'"), U(10, "7 SUS1 and SUS2 bits: cleared by a power-down, power-up cycle")]));
add("fault.nv-retained", "the non-volatile status bits (BP4-BP0, SRP1:SRP0, QE, LB3-LB1, CMP) keep their values across a power cut",
  V([P(24, "10.5 BP, SRP, QE and LB bits: non-volatile"), P(25, "10.5 CMP bit: non-volatile")], "a cut during a write-status cycle itself is not modelled (fault.out-of-scope)"),
  V([U(9, "7 BP, SRP, QE and LB bits: non-volatile"), U(10, "7 CMP bit: non-volatile")], "a cut during a write-status cycle itself is not modelled (fault.out-of-scope)"));
add("fault.cut-contents", "the contents of the bytes of a program/erase/chip erase interrupted by power loss",
  X([P(15, "6 Data Protection: concerns inadvertent writes at power transitions, not a cut valid cycle"), P(53, "10.40 Software Reset: only the reset case says 'could be damaged or lost'")], "no page states the array after an interrupted cycle: the model marks the range indeterminate and never states a value"),
  X([U(10, "8 Data Protection: concerns inadvertent writes at power transitions, not a cut valid cycle"), U(43, "9.37 Reset: only the reset case says 'could be damaged or lost'")], "no page states the array after an interrupted cycle: the model marks the range indeterminate and never states a value"));
add("fault.range", "the bytes at risk are the cycle's own: the latched bytes of a page program, the whole unit of a sector/block erase, the whole array of a chip erase",
  I([P(53, "10.40 Software Reset: 'the data under processing'"), P(39, "10.24 PP: the programmed bytes"), P(36, "10.20 SE: the unit erased")], "'data under processing' is read as the command's own range; not stated for power loss"),
  I([U(43, "9.37 Reset: 'the data under processing'"), U(28, "9.21 PP: the programmed bytes"), U(26, "9.17 SE: the unit erased")], "'data under processing' is read as the command's own range; not stated for power loss"));
add("fault.neighbours", "no byte outside the interrupted cycle's own range is affected",
  I([P(15, "6 Data Protection"), P(53, "10.40 Software Reset")], "an ASSUMPTION, not a statement: the datasheets are silent about collateral effects; the model assumes none and the tests only prove the implementation honours that assumption"),
  I([U(10, "8 Data Protection"), U(43, "9.37 Reset")], "an ASSUMPTION, not a statement: the datasheets are silent about collateral effects; the model assumes none and the tests only prove the implementation honours that assumption"));
add("fault.erase-clears", "a later complete erase over an indeterminate byte leaves it 0xFF and known",
  I([P(36, "10.20 SE"), P(37, "10.21 BE32K, 10.22 BE"), P(38, "10.23 CE")], "an erase sets every bit of its unit to 1 (Stage A erase.*); applied to indeterminate bytes it is read as defining them"),
  I([U(26, "9.17 SE, 9.18 HBE"), U(27, "9.19 BE"), U(28, "9.20 CE")], "an erase sets every bit of its unit to 1 (Stage A erase.*); applied to indeterminate bytes it is read as defining them"));
add("fault.program-over-indeterminate", "a page program over an indeterminate byte",
  X([P(39, "10.24 PP: programming clears bits of a byte whose current value is not known here")], "the result depends on the unknown prior contents: the byte stays indeterminate"),
  X([U(28, "9.21 PP: programming clears bits of a byte whose current value is not known here")], "the result depends on the unknown prior contents: the byte stays indeterminate"));
add("fault.out-of-scope", "interruption of a write-status cycle or a page erase (81h), suspend/resume, reset during an operation, and brown-out",
  N([P(26, "10.8 WRSR"), P(36, "10.19 PE"), P(51, "10.36 Suspend/Resume"), P(53, "10.40 Reset: 'could be damaged or lost'"), P(14, "5.5 power-down timing")], "a trigger never matches these cycles and powerCut() on them is refused, never silently completed; each needs its own proposal"),
  N([U(17, "9.6 WRSR"), U(25, "9.16 PE"), U(40, "9.33 Suspend/Resume"), U(43, "9.37 Reset: 'could be damaged or lost'"), U(50, "10.1 power-on timing")], "a trigger never matches these cycles and powerCut() on them is refused, never silently completed; each needs its own proposal"));

// --- status register
add("sr.layout", "16-bit status register; 05h returns S7-S0, 35h returns S15-S8",
  V([P(23, "10.5 RDSR, Status Register table")]), V([U(8, "7 Status Register, Table-4"), U(16, "9.4 RDSR")]));
add("sr.continuous", "status can be read continuously (repeated bytes)",
  V([P(23, "10.5 RDSR, Figure 10-5 shows the byte repeated")]), V([U(16, "9.4 RDSR: read continuously")]));
add("sr.read-during-cycle", "the status register can be read at any time, including during a cycle",
  V([P(23, "10.5 RDSR")]), V([U(16, "9.4 RDSR")]));
add("sr.wip", "WIP is 1 during a self-timed program/erase/write-status cycle and 0 otherwise",
  V([P(24, "10.5 WIP bit"), P(36, "10.20 SE"), P(39, "10.24 PP")]),
  V([U(8, "7 WIP bit"), U(26, "9.17 SE"), U(28, "9.21 PP")]));

// --- write enable latch
add("wel.set", "WREN (06h) sets WEL", V([P(22, "10.2 WREN")]), V([U(14, "9.1 WREN")]));
add("wel.clear", "WRDI (04h) clears WEL", V([P(22, "10.3 WRDI")]), V([U(15, "9.2 WRDI")]));
add("wel.power-up", "WEL is cleared at power-up",
  V([P(22, "10.3 WRDI: WEL reset by Power-up")]), V([U(15, "9.2 WRDI: reset after Power-up")]));
add("wel.required", "WRSR, program and every erase need WEL; without it the command is not accepted",
  V([P(22, "10.2 WREN"), P(26, "10.8 WRSR")]), V([U(14, "9.1 WREN"), U(8, "7 WEL bit")]));
add("wel.completion", "WEL is cleared when WRSR, program or erase completes",
  V([P(22, "10.3 WRDI: list of WEL reset events")]), V([U(15, "9.2 WRDI: completion list"), U(17, "9.6 WRSR")]));
add("wel.during-cycle", "WEL value while a cycle is in progress",
  I([P(36, "10.20 SE: WEL is reset when the cycle completes"), P(39, "10.24 PP")], "read as: WEL stays 1 until completion; the datasheet does not state the in-cycle value outright"),
  X([U(26, "9.17 SE: WEL reset 'at some unspecified time before the cycle is completed'"), U(28, "9.21 PP")]));
add("wel.rejected-wren-wrdi", "a WREN/WRDI rejected for a non-byte-boundary CS# leaves WEL unchanged",
  I([P(18, "8 Device Operation: 'rejected and not executed'")], "'not executed' read as no state change"),
  I([U(12, "9 Command Description: 'rejected and is not executed'")], "'not executed' read as no state change"));
add("wel.pp-partial-byte", "program with CS# raised mid-byte: WEL",
  X([P(39, "10.24 PP: rejected, WEL not mentioned")]),
  V([U(12, "9 Command Description: 'nothing will happen and WEL will not be reset'")]));
add("wel.be32-protected", "32 KiB block erase refused by BP protection: WEL",
  V([P(37, "10.21 BE32K: 'the WEL bit will be reset'")]),
  X([U(26, "9.18 HBE"), U(11, "8 Data Protection note 2: 'ignored'")]));
add("wel.after-rejected", "WEL after any other rejected or ignored write command",
  X([P(18, "8 Device Operation"), P(16, "6 Data Protection note 2")], "not stated; the model marks WEL unknown"),
  X([U(12, "9 Command Description"), U(11, "8 Data Protection note 2")], "not stated; the model marks WEL unknown"));
add("cs.byte-boundary", "CS# must rise on a byte boundary (and after the right number of bytes) or the command is rejected",
  V([P(18, "8 Device Operation: list incl. WREN, WRDI, WRSR, PE, SE, BE32K, BE, CE, PP")]),
  V([U(12, "9 Command Description"), U(25, "9.16 PE")]));
add("cmd.extra-bytes", "WREN/WRDI/RDSR/RDID/chip erase followed by extra bytes",
  X([P(18, "8 Device Operation")]), X([U(12, "9 Command Description")]));

// --- page program
add("pp.basic", "page program (02h): 3 address bytes then data; executes after WREN, WIP for tPP",
  V([P(39, "10.24 PP")]), V([U(28, "9.21 PP")]));
add("pp.wrap", "if A7-A0 are not 0, data past the end of the page wraps to the start of the same page",
  V([P(39, "10.24 PP")]), V([U(28, "9.21 PP")]));
add("pp.more-than-256", "more than 256 bytes: previously latched data is discarded, the last 256 bytes are programmed",
  I([P(39, "10.24 PP")], "verified: only the last 256 bytes are programmed; interpretation: they land at wrap positions from the start address"),
  I([U(28, "9.21 PP")], "verified: only the last 256 bytes are programmed; interpretation: they land at wrap positions from the start address"));
add("pp.partial", "fewer than 256 bytes are programmed at the requested addresses without touching the rest of the page",
  V([P(39, "10.24 PP")]), V([U(28, "9.21 PP")]));
add("pp.bits", "programming can only clear bits (result = old AND new)",
  V([P(39, "10.24 PP: 'programming the memory to be 0'")]),
  I([U(26, "9.17 SE: erase sets bits to 1"), U(28, "9.21 PP")], "NOR-flash reading: not stated outright for this chip"));
add("pp.min-one-byte", "program with no data byte",
  X([P(39, "10.24 PP: 'at least 1-byte on data'")]), X([U(28, "9.21 PP: 'at least one data byte'")]));

// --- erase
add("erase.page", "81h erases the 256-byte page containing the address", V([P(36, "10.19 PE")], "Dual Page (DP=1) not modelled"), V([U(25, "9.16 PE")]));
add("erase.sector", "20h erases the 4 KiB sector", V([P(36, "10.20 SE")]), V([U(26, "9.17 SE")]));
add("erase.block32", "52h erases the 32 KiB block", V([P(37, "10.21 BE32K")]), V([U(26, "9.18 HBE"), U(27, "9.18 HBE (continued)")]));
add("erase.block64", "D8h erases the 64 KiB block", V([P(37, "10.22 BE")]), V([U(27, "9.19 BE")]));
add("erase.chip", "60h or C7h erases the whole chip", V([P(38, "10.23 CE")]), V([U(27, "9.20 CE"), U(28, "9.20 CE (continued)")]));
add("erase.any-address", "any address inside the unit selects it",
  V([P(36, "10.19 PE and 10.20 SE"), P(37, "10.21 BE32K, 10.22 BE")]), V([U(25, "9.16 PE"), U(26, "9.17 SE, 9.18 HBE"), U(27, "9.19 BE")]));
add("erase.length", "an erase command must end exactly after the third address byte (chip erase after the opcode)",
  V([P(36, "10.20 SE"), P(37, "10.21 BE32K, 10.22 BE"), P(38, "10.23 CE")]), V([U(26, "9.17 SE"), U(27, "9.19 BE, 9.20 CE")]));
add("addr.range", "an address beyond 1 MiB (A23-A20 not 0)",
  X([P(17, "7 Memory Address Mapping")]), X([U(6, "5 Memory Organization")]));

// --- protection
add("prot.table", "BP4-BP0 and CMP select the protected area (Table: 19 rows each for CMP=0 and CMP=1)",
  V([P(15, "6 Data Protection, Table 6-1 CMP=0"), P(16, "6 Data Protection, Table 6-1 CMP=1")]),
  V([U(10, "8 Data Protection, Table-6.0"), U(11, "8 Data Protection, Table-6.0 end and Table-6.1")]));
add("prot.ignored", "a program/erase command on protected memory is ignored (array unchanged)",
  V([P(16, "6 Data Protection note 2"), P(24, "10.5 BP4-BP0 bits")]), V([U(11, "8 Data Protection note 2"), U(9, "7 BP4-BP0 bits")]));
add("prot.partial-overlap", "a command whose range contains any protected byte is ignored entirely",
  V([P(16, "6 Data Protection note 2: 'a memory that contains protected data portion'")]),
  V([U(11, "8 Data Protection note 2: 'a memory that contains protected data portion'")]));
add("prot.no-cycle", "an ignored command starts no cycle (WIP stays 0)",
  I([P(16, "6 Data Protection note 2: 'ignored'")], "'ignored' read as nothing happens"), I([U(11, "8 Data Protection note 2: 'ignored'")], "'ignored' read as nothing happens"));
add("prot.chip-erase", "chip erase runs only when nothing is protected ('None protected') and is ignored when something is protected",
  I([P(24, "10.5 BP4-BP0 bits: CE is executed only if the BP bits are set to 'None protected'"),
     P(38, "10.23 CE: 'It will be only executed when all Block Protect(BP4, BP3, BP2, BP1, BP0) are set to None protected'")],
    "'None protected' is read as the NONE state of the protected-area table (Table 6-1, p15-16): CMP=0 with BP2=BP1=BP0=0 (BP4/BP3 any), or CMP=1 with the rows '0 x 1 0 1' and 'x x 1 1 x'. Puya gives this one rule and no second, conflicting sentence, so all 64 BP/CMP combinations are decided"),
  V([U(9, "7 BP4-BP0 bits: CE is executed only if the BP bits are set to 'None protected'"),
     U(28, "9.20 CE: executed only if all BP bits are 0; ignored if one, or more blocks are protected")],
    "where the UC25HQ80's statements agree: BP all 0 and nothing protected runs; BP not 0 and something protected is ignored. See prot.chip-erase-conflict for the rest"));
add("prot.chip-erase-conflict", "UC25HQ80 chip erase where its own statements disagree: 'None protected' (p9) and 'ignored if one or more blocks are protected' (p28) versus 'only if all BP bits are 0' (p28)",
  null,
  X([U(9, "7 BP4-BP0 bits: 'None protected'"), U(28, "9.20 CE: 'all BP bits are 0' versus 'ignored if one, or more blocks are protected'")],
    "14 of the 64 BP/CMP combinations: CMP=0 with BP4 and/or BP3 set and BP2=BP1=BP0=0 (3), and CMP=1 with BP=00000 or a NONE row (11). The model refuses these. Puya has no such conflict"));

// --- write status register
add("wrsr.width", "WRSR takes 1 or 2 data bytes; any other length, or a non-byte boundary, is rejected",
  V([P(27, "10.8 WRSR: 'exactly at the 8 bits or 16 bits data boundary'")]), V([U(17, "9.6 WRSR: 'exactly at the 8 bit or 16 bit data boundary'")]));
add("wrsr.readonly-bits", "WRSR has no effect on S15, S10, S1, S0",
  V([P(26, "10.8 WRSR")]), V([U(17, "9.6 WRSR")]));
add("wrsr.writable-bits", "S7-S2 (SRP0, BP4-BP0) and S14, S13-S11, S9, S8 (CMP, LB3-LB1, QE, SRP1) are writable",
  V([P(24, "10.5 BP/SRP/QE/LB bits"), P(25, "10.5 CMP bit")]), V([U(8, "7 Table-4"), U(9, "7 BP/SRP/QE/LB bits"), U(10, "7 CMP bit")]));
add("wrsr.cycle", "WRSR takes tW; WIP is 1 during it; WEL is cleared when it completes",
  V([P(26, "10.8 WRSR"), P(10, "Table 5-3 tW")]), V([U(17, "9.6 WRSR"), U(53, "Table-17.1 tW")]));
add("wrsr.hw-protection", "SRP1:SRP0 and WP# decide whether the status register can be written (Table: 00 software, 01 hardware, 10 lock-down)",
  V([P(24, "10.5 SRP table"), P(27, "10.8 WRSR: not executed in Hardware Protected Mode")]), V([U(9, "7 Table-5"), U(17, "9.6 WRSR")]));
add("srp.lockdown", "SRP1:SRP0 = 1:0 (power-supply lock-down) returns to 0:0 after a power cycle",
  V([P(24, "10.5 SRP table note 1")]), V([U(9, "7 Table-5 note 1")]));
add("srp.otp", "SRP1:SRP0 = 1:1 (one-time-program protection)",
  X([P(24, "10.5 SRP table note 2: 'available on special order'")]), X([U(9, "7 Table-5 note 2: 'available on special order'")]));
add("wrsr.one-byte-high", "a one-byte WRSR and the bits S15-S8",
  V([P(26, "10.8 WRSR: CMP, QE and SRP1 are cleared to 0")]), X([U(17, "9.6 WRSR does not say")]));
add("wrsr.lb-otp", "LB3-LB1 are one-time-programmable: once 1, they stay 1",
  I([P(24, "10.5 LB3, LB2, LB1 bits: OTP, read-only permanently once set")], "read as: writing 0 over a set LB bit has no effect"),
  I([U(9, "7 LB3, LB2, LB1 bits")], "read as: writing 0 over a set LB bit has no effect"));
add("wrsr.bits-during-cycle", "old or new value of the writable bits while the WRSR cycle runs",
  X([P(26, "10.8 WRSR"), P(27, "10.8 WRSR")], "the model marks changing bits unknown until the cycle completes"),
  X([U(17, "9.6 WRSR")], "the model marks changing bits unknown until the cycle completes"));

// --- reads
add("read.03", "03h read: 3 address bytes then data", V([P(28, "10.10 READ")]), V([U(18, "9.7 READ")]));
add("read.0b", "0Bh fast read: 3 address bytes, one dummy byte, then data", V([P(28, "10.11 FREAD")]), V([U(18, "9.8 FAST_READ")]));
add("read.rollover", "the address counter rolls over to 0 after the highest address",
  V([P(28, "10.10 READ, 10.11 FREAD")]), V([U(18, "9.7 READ, 9.8 FAST_READ")]));
add("read.busy", "an array read during a program/erase/write-status cycle is rejected without effect on the cycle",
  V([P(18, "8 Device Operation"), P(28, "10.11 FREAD")]), V([U(18, "9.7 READ, 9.8 FAST_READ")]));
add("read.malformed", "a read command with the wrong number of address/dummy bytes",
  X([P(28, "10.10 READ, 10.11 FREAD")]), X([U(18, "9.7 READ, 9.8 FAST_READ")]));
add("cmd.busy", "write commands (WREN, WRDI, WRSR, PP, erase) issued while WIP=1",
  X([P(18, "8 Device Operation")], "only 'check the status register before a command' is stated"), X([U(6, "6 Device Operation")], "only 'check the status register before a command' is stated"));
add("array.during-cycle", "array contents while a program/erase cycle runs",
  X([P(18, "8 Device Operation")]), X([U(18, "9.7 READ")]));

// --- timing
const timing = (id, what, p, u) => add(`timing.${id}`, `${what}: typical and maximum time`, V(p), V(u));
timing("pp", "page program (tPP, up to 256 bytes)", [P(11, "5.4 Table 5-4 tPP: typ 2 ms, max 3 ms")], [U(53, "10.6 Table-18 tPP: typ 1.5 ms, max 3 ms")]);
timing("pe", "page erase (tPE)", [P(11, "5.4 Table 5-4 tPE: typ 8 ms, max 20 ms")], [U(53, "10.6 Table-18 tPE: typ 7 ms, max 10 ms")]);
timing("se", "sector erase (tSE)", [P(11, "5.4 Table 5-4 tSE: typ 8 ms, max 20 ms")], [U(53, "10.6 Table-18 tSE: typ 7 ms, max 10 ms")]);
timing("be32", "32 KiB block erase (tBE1)", [P(11, "5.4 Table 5-4 tBE1: typ 8 ms, max 20 ms")], [U(53, "10.6 Table-18 tBE1: typ 7 ms, max 10 ms")]);
timing("be64", "64 KiB block erase (tBE2)", [P(11, "5.4 Table 5-4 tBE2: typ 8 ms, max 20 ms")], [U(53, "10.6 Table-18 tBE2: typ 7 ms, max 10 ms")]);
timing("ce", "chip erase (tCE)", [P(11, "5.4 Table 5-4 tCE: typ 8 ms, max 20 ms")], [U(53, "10.6 Table-18 tCE: typ 7 ms, max 10 ms")]);
timing("wrsr", "write status register (tW)", [P(10, "5.3 Table 5-3 tW: typ 8 ms, max 12 ms")], [U(53, "10.6 Table-17.1 tW: typ 8 ms, max 12 ms")]);
add("timing.model", "WIP is 1 from CS# rising until start + duration; one figure covers a program of up to 256 bytes",
  I([P(11, "5.4 Table 5-4: 'Page program time (up to 256 bytes)'")], "the datasheets give typ/max durations, not exact completion instants"),
  I([U(53, "10.6 Table-18: 'Page program time (up to 256 bytes)'")], "the datasheets give typ/max durations, not exact completion instants"));
add("timing.min", "a minimum cycle time",
  X([P(11, "5.4 Table 5-4: min column empty")]), X([U(53, "10.6 Table-18: min column empty")], "no minimum timing is invented"));
add("timing.puya-q-option", "Puya's faster page program for ordering option 'Q' (typ 0.6 ms, max 1.5 ms)",
  N([P(11, "5.4 Table 5-4 note 8")], "the standard tPP row is modelled"));

// --- not modelled
add("cmd.unknown", "an opcode outside the modelled set",
  N([P(18, "8 Device Operation: an incorrect command leaves the chip in standby until the next CS# fall")], "the model refuses rather than guess which opcodes are 'incorrect'"),
  N([U(6, "6 Device Operation: an incorrect command leaves the chip in standby until the next CS# fall")], "the model refuses rather than guess which opcodes are 'incorrect'"));
add("nm.vwren", "Write Enable for Volatile Status Register (50h) and the volatile status copy",
  N([P(23, "10.4")]), N([U(15, "9.3")]));
add("nm.puya-config-register", "Configure Register (RDCR 15h, WRCR 31h, Dual Page bit)",
  N([P(25, "10.6 RDCR"), P(27, "10.9 WRCR")]), N([U(12, "9 Table-7: no 15h or 31h command")], "not a documented UC25HQ80 command"));
add("nm.asi", "Active Status Interrupt (25h)", N([P(26, "10.7")]), N([U(16, "9.5")]));
add("nm.suspend-resume", "program/erase suspend and resume (75h/B0h, 7Ah/30h) and the SUS bits", N([P(20, "10.1 Commands listing: 75h/B0h suspend, 7Ah/30h resume"), P(25, "10.5 SUS1 and SUS2 bits")], "the dedicated sections (10.36-10.38, p51-53) were not read; the command listing and the status bits are what is cited"),
  N([U(13, "9 Table-7: 75/B0H suspend, 7A/30H resume"), U(10, "7 SUS1 and SUS2 bits")], "the dedicated sections (9.33-9.35, p40-42) were not read; the command listing and the status bits are what is cited"));
add("nm.deep-power-down", "deep power-down and release (B9h, ABh)", N([P(21, "10.1 Commands listing")]), N([U(13, "9 Table-7")]));
add("nm.reset", "reset enable/reset (66h, 99h)", N([P(21, "10.1 Commands listing")]), N([U(13, "9 Table-7")]));
add("nm.security", "security registers (44h, 42h, 48h)", N([P(20, "10.1 Commands listing")]), N([U(13, "9 Table-7")]));
add("nm.unique-sfdp", "SFDP (5Ah). (4Bh Read Unique ID moved out of this entry: see ruid.*; the id is kept so existing transcripts and the engine still agree)", N([P(21, "10.1 Commands listing")]), N([U(13, "9 Table-7")]));
add("nm.multi-io", "dual and quad reads and programs", N([P(20, "10.1 Commands listing")]), N([U(12, "9 Table-7")]));
add("nm.electronic-id", "REMS/DREMS/QREMS (90h, 92h, 94h)", N([P(21, "10.1 Commands listing")]), N([U(13, "9 Table-7")]));
add("nm.burst-wrap", "set burst length (77h) and continuous read mode reset (FFh)", N([P(21, "10.1 Commands listing")]), N([U(12, "9 Table-7")]));
add("nm.power-loss", "power loss during a cycle (fault injection, out of scope for this stage)", N([P(18, "8 Device Operation")]), N([U(6, "6 Device Operation")]));
