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
    title: "UC25HQ80 Datasheet Version 1.2 (UCUNDATA), 60 pages",
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
add("nm.unique-sfdp", "unique ID (4Bh) and SFDP (5Ah)", N([P(21, "10.1 Commands listing")]), N([U(13, "9 Table-7")]));
add("nm.multi-io", "dual and quad reads and programs", N([P(20, "10.1 Commands listing")]), N([U(12, "9 Table-7")]));
add("nm.electronic-id", "REMS/DREMS/QREMS (90h, 92h, 94h)", N([P(21, "10.1 Commands listing")]), N([U(13, "9 Table-7")]));
add("nm.burst-wrap", "set burst length (77h) and continuous read mode reset (FFh)", N([P(21, "10.1 Commands listing")]), N([U(12, "9 Table-7")]));
add("nm.power-loss", "power loss during a cycle (fault injection, out of scope for this stage)", N([P(18, "8 Device Operation")]), N([U(6, "6 Device Operation")]));
