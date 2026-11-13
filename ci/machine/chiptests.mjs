// Conformance tests for the flash-chip reference model (chipmodel.mjs / chipspec.mjs).
//   node ci/machine/chiptests.mjs        run alone (milliseconds)
// Also registered into the machine self-test quick tier (selftest.mjs calls registerChipTests).
//
// The expected values below are transcribed LITERALLY from the datasheets (page numbers in the comments), not
// read back from chipspec.mjs, so a transcription error in the spec is caught here. The last test checks that
// every modelled behaviour has page-level citations and at least one test, per profile.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ChipModel, ManualClock, UnspecifiedBehavior, NotModeled } from "./chipmodel.mjs";
import { PROFILES, BEHAVIORS, DOCS, protectionRows } from "./chipspec.mjs";
import { FLASH_IDS } from "./flashid.mjs";

const NAMES = ["puya", "uc25hq80"];
const BYTES = 1 << 20;
// Status register bit values (UC p8 Table-4; Puya p23 10.5).
const S = { WIP: 0x1, WEL: 0x2, BP0: 0x4, BP1: 0x8, BP2: 0x10, BP3: 0x20, BP4: 0x40, SRP0: 0x80, SRP1: 0x100, QE: 0x200, SUS2: 0x400, LB1: 0x800, LB2: 0x1000, LB3: 0x2000, CMP: 0x4000, SUS1: 0x8000 };
// Timing, microseconds. Puya: Table 5-4 p11 (+ Table 5-3 p10 tW). UC25HQ80: Table-18 p53 (+ Table-17.1 p53 tW).
export const TIMING = {
  puya: { typical: { pp: 2000, pe: 8000, se: 8000, be32: 8000, be64: 8000, ce: 8000, wrsr: 8000 }, maximum: { pp: 3000, pe: 20000, se: 20000, be32: 20000, be64: 20000, ce: 20000, wrsr: 12000 } },
  uc25hq80: { typical: { pp: 1500, pe: 7000, se: 7000, be32: 7000, be64: 7000, ce: 7000, wrsr: 8000 }, maximum: { pp: 3000, pe: 10000, se: 10000, be32: 10000, be64: 10000, ce: 10000, wrsr: 12000 } },
};
export const MID = { puya: 0x85, uc25hq80: 0xb3 };                // Puya p50; UC Table-8.0 p14
const a3 = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const OPS = {                                              // one command of each kind, at an address inside its unit
  pp: [0x02, ...a3(0x001000), 0xaa], pe: [0x81, ...a3(0x002050)], se: [0x20, ...a3(0x00a123)],
  be32: [0x52, ...a3(0x012345)], be64: [0xd8, ...a3(0x034567)], ce: [0x60],
};

// ---- Literal expectations, typed from the datasheets and NOT produced by the model or the spec tables.
// The printed protected-area tables, rows in printed order: [BP4 BP3 BP2 BP1 BP0 (x = don't care), protected range or null for NONE].
// CMP=0: UC25HQ80 Table-6.0 (p10-11), Puya Table 6-1 (p15).  CMP=1: UC25HQ80 Table-6.1 (p11), Puya Table 6-1 (p16).
const A = 0x0fffff;
export const PRINTED = {
  cmp0: [["xx000", null], ["00001", [0x0f0000, A]], ["00010", [0x0e0000, A]], ["00011", [0x0c0000, A]], ["00100", [0x080000, A]],
    ["01001", [0, 0x00ffff]], ["01010", [0, 0x01ffff]], ["01011", [0, 0x03ffff]], ["01100", [0, 0x07ffff]], ["0x101", [0, A]], ["xx11x", [0, A]],
    ["10001", [0x0ff000, A]], ["10010", [0x0fe000, A]], ["10011", [0x0fc000, A]], ["1010x", [0x0f8000, A]],
    ["11001", [0, 0x000fff]], ["11010", [0, 0x001fff]], ["11011", [0, 0x003fff]], ["1110x", [0, 0x007fff]]],
  cmp1: [["xx000", [0, A]], ["00001", [0, 0x0effff]], ["00010", [0, 0x0dffff]], ["00011", [0, 0x0bffff]], ["00100", [0, 0x07ffff]],
    ["01001", [0x010000, A]], ["01010", [0x020000, A]], ["01011", [0x040000, A]], ["01100", [0x080000, A]], ["0x101", null], ["xx11x", null],
    ["10001", [0, 0x0fefff]], ["10010", [0, 0x0fdfff]], ["10011", [0, 0x0fbfff]], ["1010x", [0, 0x0f7fff]],
    ["11001", [0x001000, A]], ["11010", [0x002000, A]], ["11011", [0x004000, A]], ["1110x", [0x008000, A]]],
};
// BP4..BP0 combinations whose printed row says NONE is protected (hand-expanded from the row labels):
//   CMP=0: 'x x 0 0 0' -> BP2=BP1=BP0=0, BP4 and BP3 free: 4 combinations.
//   CMP=1: '0 x 1 0 1' -> 00101, 01101;  'x x 1 1 x' -> BP2=BP1=1, BP4/BP3/BP0 free: 00110 00111 01110 01111 10110 10111 11110 11111.
export const NONE_PROTECTED = { 0: ["00000", "01000", "10000", "11000"], 1: ["00101", "01101", "00110", "00111", "01110", "01111", "10110", "10111", "11110", "11111"] };
// Chip erase, Puya (p24, p38): "executed only if the Block Protect bits are set to 'None protected'" -> runs exactly at those 14 combinations.
export const PUYA_CE_RUNS = new Set([...NONE_PROTECTED[0].map((b) => "0:" + b), ...NONE_PROTECTED[1].map((b) => "1:" + b)]);
// Chip erase, UC25HQ80: p9 'None protected' and p28 'ignored if one or more blocks are protected' say the same as Puya, but p28 also says
// 'executed only if all BP bits are 0'. Runs at CMP=0 BP=00000 (all statements agree). Statements conflict at these 14 combinations:
// the three where BP is not all 0 yet nothing is protected, the one where BP is all 0 yet everything is protected, and the ten CMP=1 NONE rows.
export const UC_CE_RUNS = new Set(["0:00000"]);
export const UC_CE_CONFLICT = new Set(["0:01000", "0:10000", "0:11000", "1:00000", ...NONE_PROTECTED[1].map((b) => "1:" + b)]);
const status = (cmp, bits) => parseInt(bits, 2) * 4 | (cmp ? 0x4000 : 0);          // BP4..BP0 sit at status bits 6..2; CMP is bit 14
const ALL_COMBOS = [0, 1].flatMap((cmp) => Array.from({ length: 32 }, (_, n) => [cmp, n.toString(2).padStart(5, "0")]));

function mk(profile, opts = {}) {
  const clock = new ManualClock(1000);
  const chip = new ChipModel({ profile, clock, ...opts });
  const wren = () => chip.transact([0x06]);
  const finish = () => { const t = chip.busyUntil(); if (t !== null) clock.advance(t - clock.now()); };
  return { chip, clock, wren, finish, st: () => chip.readStatus() };
}
const zeros = () => new Uint8Array(BYTES);
const throwsId = (fn, Cls, id) => assert.throws(fn, (e) => e instanceof Cls && e.id === id, `expected ${Cls.name} ${id}`);

export function registerChipTests(test) {
  const coverage = { puya: new Set(), uc25hq80: new Set() };
  const T = (profile, covers, name, fn) => {
    for (const id of covers) coverage[profile].add(id);
    test(`chip model [${profile}]: ${name}`, () => fn(profile));
  };
  const both = (covers, name, fn) => { for (const p of NAMES) T(p, covers, name, fn); };

  // ---------------------------------------------------------------- identity and status
  both(["id.rdid", "id.rdid-extra-bytes"], "9Fh returns the ID; more than 3 bytes is unspecified", (p) => {
    const { chip } = mk(p);
    assert.deepEqual([...chip.transact([0x9f], { read: 3 }).out], [MID[p], 0x60, 0x14]);
    assert.deepEqual([...chip.transact([0x9f], { read: 1 }).out], [MID[p]]);
    throwsId(() => chip.transact([0x9f], { read: 4 }), UnspecifiedBehavior, "id.rdid-extra-bytes");
  });
  both(["sr.layout", "sr.continuous"], "status layout: 05h reads S7-S0, 35h reads S15-S8, repeated when read continuously", (p) => {
    const { chip, wren } = mk(p, { status: S.QE | S.CMP | S.BP2 });
    assert.equal(chip.transact([0x05], { read: 1 }).out[0], 0x10);
    assert.equal(chip.transact([0x35], { read: 1 }).out[0], 0x42);            // S9 QE = 0x02, S14 CMP = 0x40 of the high byte
    wren();
    assert.deepEqual([...chip.transact([0x05], { read: 3 }).out], [0x12, 0x12, 0x12]);   // WEL = bit 1
  });
  both(["wel.set", "wel.clear", "wel.power-up"], "WREN sets WEL, WRDI clears it, power-up clears it", (p) => {
    const { chip, wren, st } = mk(p);
    assert.equal(st().value, 0);
    wren(); assert.equal(st().value, S.WEL);
    chip.transact([0x04]); assert.equal(st().value, 0);
    wren(); chip.powerCycle(); assert.equal(st().value, 0);
  });
  both(["wel.required"], "page program, page/sector/32K/64K/chip erase (60h and C7h) and WRSR without WREN are not accepted", (p) => {
    const cases = [["pp", OPS.pp, 0x1000, 0xff], ["pe", OPS.pe, 0x2050, 0x00], ["se", OPS.se, 0xa123, 0x00], ["be32", OPS.be32, 0x12345, 0x00],
      ["be64", OPS.be64, 0x34567, 0x00], ["ce60", [0x60], 0x80000, 0x00], ["ceC7", [0xc7], 0x80000, 0x00], ["wrsr", [0x01, 0x04, 0x00], 0, 0xff]];
    for (const [name, tx, at, keeps] of cases) {
      const { chip, st } = mk(p, { image: keeps === 0x00 ? zeros() : undefined });     // erase targets hold 0x00 so an erase would show; program targets hold 0xFF
      assert.equal(chip.transact(tx).outcome, "ignored-no-wel", name);
      assert.equal(chip.busyUntil(), null, name);
      assert.deepEqual(st(), { value: 0, unknown: 0 }, name);
      assert.equal(chip.peek(at)[0], keeps, `${name}: array untouched`);
    }
  });
  both(["wel.rejected-wren-wrdi", "cmd.extra-bytes", "cs.byte-boundary"], "WREN/WRDI on a non-byte boundary are rejected without effect; extra bytes are unspecified", (p) => {
    const { chip, st } = mk(p);
    assert.equal(chip.transact([0x06], { partialBits: 3 }).outcome, "rejected-boundary");
    assert.equal(st().value, 0);
    chip.transact([0x06]);
    assert.equal(chip.transact([0x04], { partialBits: 1 }).outcome, "rejected-boundary");
    assert.equal(st().value, S.WEL);
    throwsId(() => chip.transact([0x06, 0x00]), UnspecifiedBehavior, "cmd.extra-bytes");
    throwsId(() => chip.transact([0x05, 0x00], { read: 1 }), UnspecifiedBehavior, "cmd.extra-bytes");
  });

  // ---------------------------------------------------------------- page program
  both(["pp.basic", "sr.wip", "wel.completion", "sr.read-during-cycle", "timing.model"], "page program: WIP for tPP, data lands, WEL clears at completion", (p) => {
    const { chip, clock, wren, st } = mk(p);
    wren();
    const start = clock.now();
    assert.equal(chip.transact([0x02, ...a3(0x001000), 0x12, 0x34]).outcome, "executed");
    const d = TIMING[p].typical.pp;
    assert.equal(chip.busyUntil(), start + d);
    clock.advance(d - 1); assert.equal(st().value & S.WIP, S.WIP);                // RDSR works during the cycle
    clock.advance(1);
    assert.deepEqual(st(), { value: 0, unknown: 0 });                              // WIP and WEL clear
    assert.deepEqual([...chip.peek(0x1000, 3)], [0x12, 0x34, 0xff]);
  });
  both(["pp.wrap", "pp.partial", "geometry"], "page program wraps inside the 256-byte page and leaves the rest alone", (p) => {
    const { chip, wren, finish } = mk(p);
    wren();
    chip.transact([0x02, ...a3(0x0001f0), ...Array.from({ length: 32 }, (_, i) => i)]);   // starts 16 bytes before the page end
    finish();
    assert.deepEqual([...chip.peek(0x1f0, 16)], Array.from({ length: 16 }, (_, i) => i));          // bytes 0..15 at F0..FF
    assert.deepEqual([...chip.peek(0x100, 16)], Array.from({ length: 16 }, (_, i) => 16 + i));     // bytes 16..31 wrapped to 00..0F
    assert.equal(chip.peek(0x110)[0], 0xff);                                                       // rest of the page untouched
    assert.equal(chip.peek(0x200)[0], 0xff);                                                       // next page untouched
  });
  both(["pp.more-than-256"], "more than 256 bytes: only the last 256 are programmed", (p) => {
    const { chip, wren, finish } = mk(p);
    const data = Array.from({ length: 300 }, (_, i) => (i * 7 + 3) & 0xff);
    wren(); chip.transact([0x02, ...a3(0x003000), ...data]); finish();
    for (let o = 0; o < 256; o++) assert.equal(chip.peek(0x3000 + o)[0], o < 44 ? data[256 + o] : data[o], `offset ${o}`);
    assert.equal(chip.peek(0x3100)[0], 0xff);
  });
  both(["pp.bits"], "program can only clear bits", (p) => {
    const image = new Uint8Array(BYTES).fill(0xff); image[0x4000] = 0xf0;
    const { chip, wren, finish } = mk(p, { image });
    wren(); chip.transact([0x02, ...a3(0x004000), 0x3c]); finish();
    assert.equal(chip.peek(0x4000)[0], 0x30);                                       // 0xF0 AND 0x3C
  });
  both(["pp.min-one-byte"], "a program with no data byte is unspecified", (p) => {
    const { chip, wren } = mk(p);
    wren();
    throwsId(() => chip.transact([0x02, ...a3(0x001000)]), UnspecifiedBehavior, "pp.min-one-byte");
  });
  both(["wel.pp-partial-byte"], "program with CS# mid-byte: WEL known on UC (not reset, p12), unknown on Puya", (p) => {
    const { chip, wren, st } = mk(p);
    wren();
    assert.equal(chip.transact([0x02, ...a3(0x001000), 0xaa], { partialBits: 3 }).outcome, "rejected-boundary");
    assert.equal(chip.busyUntil(), null);
    assert.equal(chip.peek(0x1000)[0], 0xff);
    const s = st();
    assert.equal(s.value & S.WEL, S.WEL);
    assert.equal(s.unknown & S.WEL, p === "uc25hq80" ? 0 : S.WEL);
  });
  both(["wel.during-cycle"], "WEL during a cycle: Puya stays set; UC25HQ80 is unspecified; both clear at completion", (p) => {
    const { chip, clock, wren, st } = mk(p);
    wren(); chip.transact(OPS.pp);
    const mid = st();
    assert.equal(mid.value & S.WEL, S.WEL);
    assert.equal(mid.unknown & S.WEL, p === "uc25hq80" ? S.WEL : 0);
    clock.advance(TIMING[p].typical.pp);
    assert.deepEqual(st(), { value: 0, unknown: 0 });
  });

  // ---------------------------------------------------------------- erase
  both(["erase.page", "erase.sector", "erase.block32", "erase.block64", "erase.chip", "erase.any-address", "geometry"], "each erase clears exactly its unit, selected by any address inside it", (p) => {
    const cases = [
      ["pe", OPS.pe, 0x002000, 0x0020ff], ["se", OPS.se, 0x00a000, 0x00afff], ["be32", OPS.be32, 0x010000, 0x017fff],
      ["be64", OPS.be64, 0x030000, 0x03ffff], ["ce60", [0x60], 0, BYTES - 1], ["ceC7", [0xc7], 0, BYTES - 1],
    ];
    for (const [name, tx, lo, hi] of cases) {
      const { chip, wren, finish } = mk(p, { image: zeros() });
      wren(); assert.equal(chip.transact(tx).outcome, "executed", name);
      finish();
      assert.equal(chip.peek(lo)[0], 0xff, `${name} first`); assert.equal(chip.peek(hi)[0], 0xff, `${name} last`);
      if (lo > 0) assert.equal(chip.peek(lo - 1)[0], 0x00, `${name} byte before`);
      if (hi < BYTES - 1) assert.equal(chip.peek(hi + 1)[0], 0x00, `${name} byte after`);
    }
  });
  both(["cs.byte-boundary", "erase.length", "wel.after-rejected"], "erase on a non-byte boundary or with the wrong length is rejected; WEL becomes unknown", (p) => {
    for (const [name, tx] of [["pe", OPS.pe], ["se", OPS.se], ["be32", OPS.be32], ["be64", OPS.be64], ["ce", OPS.ce]]) {
      for (const bad of [{ tx, partialBits: 1 }, { tx: [...tx, 0x00] }, { tx: tx.slice(0, -1) }]) {
        if (!bad.tx.length) continue;                                              // chip erase is the opcode alone: nothing to truncate
        const { chip, wren, st } = mk(p, { image: zeros() });
        wren();
        const r = chip.transact(bad.tx, { partialBits: bad.partialBits ?? 0 });
        assert.equal(r.outcome, "rejected-boundary", `${name}`);
        assert.equal(chip.busyUntil(), null);
        assert.equal(chip.peek(0x0)[0], 0x00);
        assert.equal(st().unknown & S.WEL, S.WEL, `${name}: WEL fate is not stated`);
        throwsId(() => chip.transact(OPS.se), UnspecifiedBehavior, "wel.after-rejected");
        wren(); assert.equal(st().unknown, 0);                                     // WREN makes WEL known again
      }
    }
  });
  both(["addr.range"], "an address beyond 1 MiB is unspecified", (p) => {
    const { chip, wren } = mk(p);
    throwsId(() => chip.transact([0x03, 0x10, 0x00, 0x00], { read: 1 }), UnspecifiedBehavior, "addr.range");
    wren();
    throwsId(() => chip.transact([0x02, 0x10, 0x00, 0x00, 0xaa]), UnspecifiedBehavior, "addr.range");
    throwsId(() => chip.transact([0x20, 0x10, 0x00, 0x00]), UnspecifiedBehavior, "addr.range");
  });

  // ---------------------------------------------------------------- timing
  for (const mode of ["typical", "maximum"]) {
    both(["timing.pp", "timing.pe", "timing.se", "timing.be32", "timing.be64", "timing.ce", "timing.wrsr", "sr.wip", ...(mode === "typical" ? [] : [])],
      `${mode} timing: WIP until start + datasheet duration, for every operation`, (p) => {
        const wrsr = [0x01, 0x00, 0x00];
        for (const [name, tx] of [...Object.entries(OPS), ["wrsr", wrsr]]) {
          const { chip, clock, wren, st } = mk(p, { timing: mode });
          const d = TIMING[p][mode][name];
          wren(); const t0 = clock.now(); chip.transact(tx);
          assert.equal(chip.busyUntil(), t0 + d, `${name} ${mode}`);
          clock.advance(d - 1); assert.equal(st().value & S.WIP, S.WIP, `${name} still busy 1 us early`);
          clock.advance(1); assert.equal(st().value & S.WIP, 0, `${name} done`);
        }
      });
  }
  T("puya", ["timing.puya-q-option"], "the standard page-program row (typ 2 ms) is modelled, not the faster 'Q' ordering option (typ 0.6 ms)", () => {
    const { chip, clock, wren } = mk("puya");
    wren(); const t0 = clock.now(); chip.transact(OPS.pp);
    assert.equal(chip.busyUntil() - t0, 2000);
  });
  both(["timing.min"], "only typical and maximum exist: no minimum timing is invented", (p) => {
    assert.deepEqual(Object.keys(PROFILES[p].timingUs).sort(), ["maximum", "typical"]);
    assert.throws(() => new ChipModel({ profile: p, clock: new ManualClock(), timing: "minimum" }), RangeError);
  });
  both([], "deterministic: no real-time dependence, same script gives the same transcript; the clock cannot go backwards", (p) => {
    const run = () => {
      const { chip, clock, wren } = mk(p, { timing: "maximum" });
      const log = [];
      wren(); log.push(chip.transact(OPS.se).outcome); log.push(chip.readStatus());
      clock.advance(TIMING[p].maximum.se - 1); log.push(chip.readStatus()); clock.advance(1); log.push(chip.readStatus());
      return JSON.stringify(log);
    };
    assert.equal(run(), run());
    const clock = new ManualClock(500), chip = new ChipModel({ profile: p, clock });
    chip.readStatus(); clock.set(100);
    assert.throws(() => chip.readStatus(), /went backwards/);
    assert.throws(() => new ChipModel({ profile: p }), /clock/);
  });

  // ---------------------------------------------------------------- protection
  both(["prot.table"], "block-protect tables: spot rows as printed, every BP combination matches exactly one row, CMP=1 is the complement of CMP=0", (p) => {
    const NONE = null, ALL = [0, 0x0fffff];
    const rows0 = PROFILES[p].protection.cmp0, rows1 = PROFILES[p].protection.cmp1;
    const at = (rows, bp) => { const m = protectionRows(rows, bp); assert.equal(m.length, 1, `BP=${bp.join("")}`); return m[0].range && [m[0].range.lo, m[0].range.hi]; };
    // [BP4 BP3 BP2 BP1 BP0] -> range. CMP=0: UC Table-6.0 p10-11, Puya p15. CMP=1: UC Table-6.1 p11, Puya p16.
    for (const [bp, want] of [[[0, 0, 0, 0, 1], [0x0f0000, 0x0fffff]], [[0, 1, 1, 0, 0], [0, 0x07ffff]], [[1, 0, 1, 0, 0], [0x0f8000, 0x0fffff]],
      [[1, 1, 1, 0, 1], [0, 0x007fff]], [[1, 1, 0, 1, 1], [0, 0x003fff]], [[0, 1, 1, 1, 0], ALL], [[0, 0, 0, 0, 0], NONE], [[1, 1, 0, 0, 0], NONE]]) {
      assert.deepEqual(at(rows0, bp), want, `CMP=0 ${bp.join("")}`);
    }
    for (const [bp, want] of [[[0, 0, 0, 0, 0], ALL], [[0, 0, 0, 1, 1], [0, 0x0bffff]], [[0, 1, 1, 0, 1], NONE], [[1, 1, 0, 1, 0], [0x002000, 0x0fffff]], [[1, 0, 1, 0, 1], [0, 0x0f7fff]]]) {
      assert.deepEqual(at(rows1, bp), want, `CMP=1 ${bp.join("")}`);
    }
    for (let n = 0; n < 32; n++) {                                                  // total function + complement check (4 KiB granularity)
      const bp = [4, 3, 2, 1, 0].map((b) => (n >> b) & 1);
      const r0 = at(rows0, bp), r1 = at(rows1, bp);
      for (let s = 0; s < 256; s++) {
        const lo = s * 4096, in0 = r0 !== null && lo >= r0[0] && lo <= r0[1], in1 = r1 !== null && lo >= r1[0] && lo <= r1[1];
        assert.notEqual(in0, in1, `BP=${bp.join("")} sector ${s}: CMP=1 must protect exactly what CMP=0 does not`);
      }
    }
  });
  both(["prot.ignored", "prot.no-cycle", "prot.partial-overlap", "wel.after-rejected"], "protected memory: program/erase ignored, no cycle, partial overlap counts, array unchanged", (p) => {
    // BP0=1, CMP=0: 0F0000-0FFFFF protected (64 KB upper 1/16)
    let f = mk(p, { status: S.BP0 });
    f.wren(); assert.equal(f.chip.transact([0x02, ...a3(0x0f0000), 0x00]).outcome, "ignored-protected");
    assert.equal(f.chip.busyUntil(), null); assert.equal(f.chip.peek(0x0f0000)[0], 0xff);
    assert.equal(f.st().unknown & S.WEL, S.WEL);                                    // WEL after a plain ignore: not stated
    f = mk(p, { status: S.BP0, image: zeros() });
    f.wren(); assert.equal(f.chip.transact([0x20, ...a3(0x0f1000)]).outcome, "ignored-protected");
    f.wren(); assert.equal(f.chip.transact([0xd8, ...a3(0x0f0000)]).outcome, "ignored-protected");
    f.wren(); assert.equal(f.chip.transact([0xd8, ...a3(0x0e0000)]).outcome, "executed"); f.finish();       // just below: allowed
    assert.equal(f.chip.peek(0x0e0000)[0], 0xff); assert.equal(f.chip.peek(0x0f0000)[0], 0x00);
    // BP4|BP0: 0FF000-0FFFFF (4 KB). A 64 KB block containing it is ignored as a whole; neighbours are not.
    f = mk(p, { status: S.BP4 | S.BP0, image: zeros() });
    f.wren(); assert.equal(f.chip.transact([0xd8, ...a3(0x0f0000)]).outcome, "ignored-protected");
    f.wren(); assert.equal(f.chip.transact([0x52, ...a3(0x0f8000)]).outcome, "ignored-protected");
    f.wren(); assert.equal(f.chip.transact([0x52, ...a3(0x0f0000)]).outcome, "executed"); f.finish();      // 0F0000-0F7FFF: no overlap
    assert.equal(f.chip.peek(0x0f0000)[0], 0xff); assert.equal(f.chip.peek(0x0ff000)[0], 0x00);
  });
  both(["wel.be32-protected"], "32 KiB erase refused by protection: WEL reset on Puya (p37), unknown on UC25HQ80", (p) => {
    const { chip, wren, st } = mk(p, { status: S.BP0 });
    wren(); assert.equal(chip.transact([0x52, ...a3(0x0f0000)]).outcome, "ignored-protected");
    const s = st();
    if (p === "puya") assert.deepEqual(s, { value: S.BP0, unknown: 0 });
    else assert.deepEqual(s, { value: S.BP0 | S.WEL, unknown: S.WEL });
  });
  both(["prot.chip-erase", "prot.no-cycle"], "chip erase: runs with BP=0 and CMP=0; ignored, with no cycle, when BP is set and something is protected", (p) => {
    let f = mk(p, { image: zeros() });
    f.wren(); assert.equal(f.chip.transact([0x60]).outcome, "executed"); f.finish();
    assert.equal(f.chip.peek(0)[0], 0xff); assert.equal(f.chip.peek(BYTES - 1)[0], 0xff);
    for (const status of [S.BP0, S.BP0 | S.CMP]) {
      f = mk(p, { status, image: zeros() });
      f.wren(); assert.equal(f.chip.transact([0xc7]).outcome, "ignored-protected");
      assert.equal(f.chip.busyUntil(), null); assert.equal(f.chip.peek(0)[0], 0x00);
    }
  });
  // All 64 BP/CMP combinations, one test per profile. Expected outcomes are the literal lists above, written from each datasheet's
  // wording: nothing here calls the model's decision logic or reads the spec tables.
  T("puya", ["prot.chip-erase"], "chip erase, all 64 BP/CMP combinations: runs exactly when the table says 'None protected' (14), otherwise ignored (50); never refused", () => {
    const tally = { runs: 0, ignored: 0 };
    for (const [cmp, bits] of ALL_COMBOS) {
      const f = mk("puya", { status: status(cmp, bits), image: zeros() });
      f.wren();
      const r = f.chip.transact([0x60]), key = `${cmp}:${bits}`;
      if (PUYA_CE_RUNS.has(key)) {
        assert.equal(r.outcome, "executed", key); f.finish();
        assert.equal(f.chip.peek(0)[0], 0xff, key); assert.equal(f.chip.peek(A)[0], 0xff, key); tally.runs++;
      } else {
        assert.equal(r.outcome, "ignored-protected", key); assert.equal(f.chip.busyUntil(), null, key); assert.equal(f.chip.peek(0)[0], 0x00, key); tally.ignored++;
      }
    }
    assert.deepEqual(tally, { runs: 14, ignored: 50 });
  });
  T("uc25hq80", ["prot.chip-erase", "prot.chip-erase-conflict"], "chip erase, all 64 BP/CMP combinations: 1 runs, 14 are refused where the datasheet statements conflict, 49 are ignored", () => {
    const tally = { runs: 0, conflict: 0, ignored: 0 };
    for (const [cmp, bits] of ALL_COMBOS) {
      const f = mk("uc25hq80", { status: status(cmp, bits), image: zeros() });
      f.wren();
      const key = `${cmp}:${bits}`;
      if (UC_CE_CONFLICT.has(key)) {
        throwsId(() => f.chip.transact([0x60]), UnspecifiedBehavior, "prot.chip-erase-conflict"); assert.equal(f.chip.busyUntil(), null, key); tally.conflict++;
      } else if (UC_CE_RUNS.has(key)) {
        assert.equal(f.chip.transact([0x60]).outcome, "executed", key); f.finish(); assert.equal(f.chip.peek(0)[0], 0xff, key); tally.runs++;
      } else {
        assert.equal(f.chip.transact([0x60]).outcome, "ignored-protected", key); assert.equal(f.chip.busyUntil(), null, key); assert.equal(f.chip.peek(0)[0], 0x00, key); tally.ignored++;
      }
    }
    assert.deepEqual(tally, { runs: 1, conflict: 14, ignored: 49 });
  });
  test("chip model: chip erase differs between the profiles at exactly the 14 combinations where the UC25HQ80 refuses; Puya decides them", () => {
    const outcome = (p, cmp, bits) => {
      const f = mk(p, { status: status(cmp, bits), image: zeros() }); f.wren();
      try { return f.chip.transact([0x60]).outcome === "executed" ? "runs" : "ignored"; }
      catch (e) { if (e instanceof UnspecifiedBehavior) return "refused"; throw e; }
    };
    const differ = [];
    for (const [cmp, bits] of ALL_COMBOS) {
      const a = outcome("puya", cmp, bits), b = outcome("uc25hq80", cmp, bits);
      assert.notEqual(a, "refused", `Puya never refuses (${cmp}:${bits})`);
      if (a !== b) differ.push(`${cmp}:${bits}`);
      if (UC_CE_CONFLICT.has(`${cmp}:${bits}`)) assert.equal(b, "refused", `${cmp}:${bits}`);
    }
    assert.deepEqual(differ.sort(), [...UC_CE_CONFLICT].sort());                                    // they differ only where the UC25HQ80 refuses
    assert.equal(outcome("puya", 1, "00000"), "ignored");                                          // CMP=1, BP=0: everything protected -> Puya ignores
    for (const bits of ["01000", "10000", "11000"]) assert.equal(outcome("puya", 0, bits), "runs"); // CMP=0, BP4/BP3 only: nothing protected -> Puya runs
    assert.equal(outcome("puya", 1, "00110"), "runs");                                             // CMP=1 NONE row -> Puya runs
  });
  both(["prot.table"], "block-protect rows equal the printed table literally: 19 rows for CMP=0 and 19 for CMP=1, in printed order", (p) => {
    for (const key of ["cmp0", "cmp1"]) {
      const spec = PROFILES[p].protection[key].map((r) => [r.pattern.join(""), r.range ? [r.range.lo, r.range.hi] : null]);
      assert.deepEqual(spec, PRINTED[key], `${p} ${key}`);
    }
  });

  // ---------------------------------------------------------------- write status register
  both(["wrsr.cycle", "wrsr.bits-during-cycle", "wrsr.writable-bits", "wrsr.readonly-bits", "timing.wrsr"], "WRSR: tW cycle, changing bits unknown meanwhile, only writable bits change", (p) => {
    const { chip, clock, wren, st } = mk(p);
    wren(); assert.equal(chip.transact([0x01, 0x04, 0x00]).outcome, "executed");
    let s = st();
    assert.equal(s.value & S.WIP, S.WIP); assert.equal(s.unknown & S.BP0, S.BP0);   // BP0 is changing: old or new is not stated
    clock.advance(TIMING[p].typical.wrsr - 1); assert.equal(st().value & S.WIP, S.WIP);
    clock.advance(1); assert.deepEqual(st(), { value: S.BP0, unknown: 0 });          // WEL cleared at completion
    wren(); chip.transact([0x01, 0xfc, 0xff]); clock.advance(TIMING[p].typical.wrsr);
    assert.deepEqual(st(), { value: 0x7bfc, unknown: 0 });                           // S15 (SUS1) and S10 (SUS2) did not take the 1s; S1, S0 no effect
  });
  both(["wrsr.width", "wel.after-rejected"], "WRSR takes 1 or 2 data bytes on a byte boundary; anything else is rejected", (p) => {
    for (const bad of [{ tx: [0x01] }, { tx: [0x01, 1, 2, 3] }, { tx: [0x01, 4], partialBits: 2 }]) {
      const { chip, wren, st } = mk(p);
      wren();
      assert.equal(chip.transact(bad.tx, { partialBits: bad.partialBits ?? 0 }).outcome, "rejected-boundary");
      assert.equal(chip.busyUntil(), null); assert.equal(st().unknown & S.WEL, S.WEL);
    }
  });
  both(["wrsr.hw-protection", "srp.lockdown", "srp.otp"], "SRP1:SRP0 and WP# gate WRSR; lock-down ends at power cycle; 1:1 is unspecified", (p) => {
    let f = mk(p, { status: S.SRP0, wp: false });                                    // 0:1, WP# low: hardware protected
    f.wren(); assert.equal(f.chip.transact([0x01, 0x84, 0x00]).outcome, "ignored-hw-protected");
    f = mk(p, { status: S.SRP0, wp: true });                                         // 0:1, WP# high: writable
    f.wren(); assert.equal(f.chip.transact([0x01, 0x84, 0x00]).outcome, "executed");
    f = mk(p, { status: S.SRP1 });                                                   // 1:0 power-supply lock-down
    f.wren(); assert.equal(f.chip.transact([0x01, 0x04, 0x00]).outcome, "ignored-hw-protected");
    f.chip.powerCycle(); assert.equal(f.st().value & (S.SRP0 | S.SRP1), 0);          // back to 0:0
    f.wren(); assert.equal(f.chip.transact([0x01, 0x04, 0x00]).outcome, "executed"); f.finish();
    assert.equal(f.st().value, S.BP0);
    f = mk(p, { status: S.SRP0 | S.SRP1 }); f.wren();                                // 1:1 one-time-program: special order
    throwsId(() => f.chip.transact([0x01, 0x04, 0x00]), UnspecifiedBehavior, "srp.otp");
  });
  both(["wrsr.one-byte-high"], "a one-byte WRSR: Puya clears CMP/QE/SRP1 (p26); UC25HQ80 leaves S15-S8 unspecified", (p) => {
    const { chip, wren, finish, st } = mk(p, { status: S.CMP | S.QE | S.LB1 });
    wren(); assert.equal(chip.transact([0x01, 0x04]).outcome, "executed"); finish();
    if (p === "puya") assert.deepEqual(st(), { value: S.BP0 | S.LB1, unknown: 0 });   // CMP and QE cleared, LB1 untouched
    else {
      const s = st();
      assert.equal(s.value & 0xff, S.BP0); assert.equal(s.unknown, 0x7b00);           // S14,S13-S11,S9,S8 now unknown
      wren(); throwsId(() => chip.transact(OPS.pp), UnspecifiedBehavior, "prot.table");   // protection depends on CMP: cannot be decided
    }
  });
  both(["wrsr.lb-otp"], "LB3-LB1 are one-time-programmable: they only go 0 to 1", (p) => {
    const { chip, wren, finish, st } = mk(p);
    wren(); chip.transact([0x01, 0x00, 0x08]); finish(); assert.equal(st().value, S.LB1);
    wren(); chip.transact([0x01, 0x00, 0x00]); finish(); assert.equal(st().value, S.LB1);      // writing 0 does not clear it
  });

  // ---------------------------------------------------------------- reads and the busy chip
  both(["read.03", "read.0b", "read.rollover", "read.malformed"], "03h and 0Bh read, roll over to 0 after the last address; wrong lengths are unspecified", (p) => {
    const image = Uint8Array.from({ length: BYTES }, (_, i) => (i * 13 + 5) & 0xff);
    const { chip } = mk(p, { image });
    assert.deepEqual([...chip.transact([0x03, ...a3(0x000100)], { read: 3 }).out], [image[0x100], image[0x101], image[0x102]]);
    assert.deepEqual([...chip.transact([0x0b, ...a3(0x000100), 0x00], { read: 3 }).out], [image[0x100], image[0x101], image[0x102]]);
    assert.deepEqual([...chip.transact([0x03, ...a3(0x0ffffe)], { read: 4 }).out], [image[0xffffe], image[0xfffff], image[0], image[1]]);
    throwsId(() => chip.transact([0x03, 0, 0], { read: 1 }), UnspecifiedBehavior, "read.malformed");
    throwsId(() => chip.transact([0x0b, 0, 0, 0], { read: 1 }), UnspecifiedBehavior, "read.malformed");
  });
  both(["id.rdid-busy", "read.busy", "cmd.busy", "array.during-cycle", "sr.read-during-cycle"], "during a program/erase cycle: RDSR works, RDID and reads are ignored, other commands and array access are unspecified", (p) => {
    const { chip, wren, finish } = mk(p);
    wren(); chip.transact(OPS.pp);
    assert.equal(chip.transact([0x05], { read: 1 }).out[0] & S.WIP, S.WIP);
    for (const tx of [[0x9f], [0x03, ...a3(0)], [0x0b, ...a3(0), 0]]) {
      const r = chip.transact(tx, { read: 2 });
      assert.equal(r.outcome, "ignored-busy"); assert.equal(r.out, null);
    }
    throwsId(() => chip.transact([0x06]), UnspecifiedBehavior, "cmd.busy");
    throwsId(() => chip.transact([0x04]), UnspecifiedBehavior, "cmd.busy");
    throwsId(() => chip.peek(0x1000), UnspecifiedBehavior, "array.during-cycle");
    finish(); assert.equal(chip.peek(0x1000)[0], 0xaa);
  });
  both(["id.rdid-busy-wrsr", "read.busy"], "during a WRSR cycle: reads are ignored; RDID is unspecified (the datasheets name only program/erase)", (p) => {
    const { chip, wren } = mk(p);
    wren(); chip.transact([0x01, 0x04, 0x00]);
    assert.equal(chip.transact([0x03, ...a3(0)], { read: 1 }).outcome, "ignored-busy");
    throwsId(() => chip.transact([0x9f], { read: 3 }), UnspecifiedBehavior, "id.rdid-busy-wrsr");
  });

  // ---------------------------------------------------------------- 4Bh Read Unique ID (4Bh Stage A extension)
  // The ID bytes below are a TEST FIXTURE (the real value is per device and in neither datasheet). Everything else is from P p54 / p21, U p43-44 / p13.
  const UID = [0x13, 0x57, 0x9b, 0xdf, 0x02, 0x46, 0x8a, 0xce, 0xf1, 0xe2, 0xd3, 0xc4, 0xb5, 0xa6, 0x97, 0x88];
  const RUID = [0x4b, 0, 0, 0, 0];
  both(["ruid.command", "ruid.length-order"], "4Bh: opcode, four dummy bytes, then the 128-bit ID, first transmitted byte first, any length up to 16 bytes", (p) => {
    const { chip } = mk(p, { uid: UID });
    const all = chip.transact(RUID, { read: 16 });
    assert.equal(all.outcome, "executed");
    assert.deepEqual([...all.out], UID);
    assert.deepEqual([...all.unknown], new Array(16).fill(0));
    for (const n of [1, 2, 8, 15]) assert.deepEqual([...chip.transact(RUID, { read: n }).out], UID.slice(0, n), `${n} bytes`);
    assert.equal(chip.transact(RUID, { read: 0 }).out.length, 0, "no data bytes: the command is just accepted");
    // the first bit transmitted is bit 127 (the MSB of byte 0), the last is bit 0
    const bits = [...chip.transact(RUID, { read: 16 }).out].map((b) => b.toString(2).padStart(8, "0")).join("");
    assert.equal(bits.length, 128); assert.equal(bits.slice(0, 8), "00010011"); assert.equal(bits.slice(-8), "10001000");
  });
  both(["ruid.constant", "ruid.no-cycle"], "4Bh is a read: same ID every time, across program, erase, WRSR, chip erase and power cycles; no cycle, WEL and status untouched", (p) => {
    const { chip, clock, wren, finish, st } = mk(p, { uid: UID, image: zeros() });
    const read = () => [...chip.transact(RUID, { read: 16 }).out];
    assert.deepEqual(read(), UID); assert.deepEqual(read(), UID, "repeated reads");
    assert.equal(chip.busyUntil(), null, "no cycle: WIP never set"); assert.equal(st().value, 0, "status unchanged");
    wren(); assert.deepEqual(read(), UID);
    assert.equal(st().value, S.WEL, "a read leaves WEL as it was"); assert.equal(chip.busyUntil(), null);
    chip.transact([0x04]);
    wren(); chip.transact(OPS.pp); finish(); assert.deepEqual(read(), UID, "after a program");
    wren(); chip.transact(OPS.se); finish(); assert.deepEqual(read(), UID, "after an erase");
    wren(); chip.transact([0x60]); finish(); assert.deepEqual(read(), UID, "after a chip erase");
    wren(); chip.transact([0x01, 0x1c, 0x42]); finish(); assert.deepEqual(read(), UID, "after a write-status");
    chip.powerCycle(); assert.deepEqual(read(), UID, "after a power cycle");
    clock.advance(1e6); assert.deepEqual(read(), UID, "later");
  });
  both(["ruid.value"], "4Bh without a supplied ID: the value is reported unknown (mask FF), the command structure is still enforced, and it is never the legacy FM1- pattern", (p) => {
    const { chip } = mk(p);
    const r = chip.transact(RUID, { read: 16 });
    assert.equal(r.outcome, "executed");
    assert.deepEqual([...r.unknown], new Array(16).fill(0xff), "every bit unknown");
    assert.notDeepEqual([...r.out.slice(0, 4)], [0x46, 0x4d, 0x31, 0x2d], "the emulator's original FM1- pattern is not a datasheet value");
    throwsId(() => chip.transact([0x4b], { read: 16 }), UnspecifiedBehavior, "ruid.malformed");
    assert.throws(() => new ChipModel({ profile: p, clock: new ManualClock(), uid: [1, 2, 3] }), RangeError);
    assert.throws(() => new ChipModel({ profile: p, clock: new ManualClock(), uid: new Array(16).fill(256) }), RangeError);
  });
  both(["ruid.malformed", "ruid.beyond-128-bits"], "4Bh with the wrong number of dummy bytes, or more than 16 data bytes, is refused rather than guessed", (p) => {
    const { chip } = mk(p, { uid: UID });
    for (const tx of [[0x4b], [0x4b, 0], [0x4b, 0, 0], [0x4b, 0, 0, 0], [0x4b, 0, 0, 0, 0, 0], [0x4b, 0, 0, 0, 0, 0, 0]]) throwsId(() => chip.transact(tx, { read: 1 }), UnspecifiedBehavior, "ruid.malformed");
    for (const n of [17, 18, 32, 100]) throwsId(() => chip.transact(RUID, { read: n }), UnspecifiedBehavior, "ruid.beyond-128-bits");
    assert.deepEqual([...chip.transact(RUID, { read: 16 }).out], UID, "the refusals changed nothing");
  });
  both(["ruid.busy"], "4Bh during a program/erase/write-status cycle is refused (unspecified) and does not disturb the cycle", (p) => {
    const { chip, wren, finish, st } = mk(p, { uid: UID, image: zeros() });
    for (const tx of [OPS.pp, OPS.se, [0x01, 0x04, 0x00]]) {
      wren(); chip.transact(tx);
      throwsId(() => chip.transact(RUID, { read: 16 }), UnspecifiedBehavior, "ruid.busy");
      assert.notEqual(chip.busyUntil(), null, "the cycle is undisturbed");
      finish();
      assert.deepEqual([...chip.transact(RUID, { read: 16 }).out], UID, "readable again afterwards");
    }
    assert.equal(st().value & S.WIP, 0);
  });
  T("puya", ["ruid.dummy-values"], "4Bh: the dummy bytes carry no meaning (read as don't-care, an interpretation)", () => {
    const { chip } = mk("puya", { uid: UID });
    assert.deepEqual([...chip.transact([0x4b, 0xff, 0xaa, 0x55, 0x12], { read: 16 }).out], UID);
  });
  T("uc25hq80", ["ruid.dummy-values"], "4Bh: Table-7 lists 00H for the first three dummy bytes: another value there is unspecified and refused; the fourth is don't-care", () => {
    const { chip } = mk("uc25hq80", { uid: UID });
    for (const tx of [[0x4b, 1, 0, 0, 0], [0x4b, 0, 0x80, 0, 0], [0x4b, 0, 0, 0xff, 0]]) throwsId(() => chip.transact(tx, { read: 16 }), UnspecifiedBehavior, "ruid.dummy-values");
    assert.deepEqual([...chip.transact([0x4b, 0, 0, 0, 0xa5], { read: 16 }).out], UID, "the fourth dummy byte is not constrained");
    assert.deepEqual([...chip.transact(RUID, { read: 16 }).out], UID);
  });

  // ---------------------------------------------------------------- scope limits
  both(["cmd.unknown", "nm.vwren", "nm.asi", "nm.suspend-resume", "nm.deep-power-down", "nm.reset", "nm.security", "nm.unique-sfdp", "nm.multi-io", "nm.electronic-id", "nm.burst-wrap", "nm.power-loss"],
    "everything outside the model's scope is refused, not guessed", (p) => {
      const { chip, wren } = mk(p);
      const ids = { 0x50: "nm.vwren", 0x25: "nm.asi", 0x75: "nm.suspend-resume", 0xb0: "nm.suspend-resume", 0x7a: "nm.suspend-resume", 0x30: "nm.suspend-resume",
        0xb9: "nm.deep-power-down", 0xab: "nm.deep-power-down", 0x66: "nm.reset", 0x99: "nm.reset", 0x44: "nm.security", 0x42: "nm.security", 0x48: "nm.security",
        0x5a: "nm.unique-sfdp", 0x3b: "nm.multi-io", 0xeb: "nm.multi-io", 0x32: "nm.multi-io", 0x90: "nm.electronic-id", 0x94: "nm.electronic-id",
        0x77: "nm.burst-wrap", 0xff: "nm.burst-wrap", 0xee: "cmd.unknown" };
      for (const [op, id] of Object.entries(ids)) throwsId(() => chip.transact([Number(op)]), NotModeled, id);
      wren(); chip.transact(OPS.pp);
      throwsId(() => chip.powerCycle(), NotModeled, "nm.power-loss");
    });
  T("puya", ["nm.puya-config-register"], "Puya's Configure Register commands (15h, 31h) are refused", () => {
    const { chip } = mk("puya");
    for (const op of [0x15, 0x31]) throwsId(() => chip.transact([op], { read: 1 }), NotModeled, "nm.puya-config-register");
  });
  T("uc25hq80", ["nm.puya-config-register"], "15h and 31h are not UC25HQ80 commands (Table-7): refused as unknown", () => {
    const { chip } = mk("uc25hq80");
    for (const op of [0x15, 0x31]) throwsId(() => chip.transact([op], { read: 1 }), NotModeled, "cmd.unknown");
  });

  // ---------------------------------------------------------------- the two profiles side by side
  test("chip model: documented differences between Puya P25Q80H and UC25HQ80", () => {
    const run = (p) => {
      const f = mk(p), out = {};
      out.id = [...f.chip.transact([0x9f], { read: 3 }).out];
      f.wren(); f.chip.transact(OPS.pp); out.welInCycleUnknown = (f.st().unknown & S.WEL) !== 0; f.finish();
      for (const n of ["pp", "se", "ce"]) out[n] = [TIMING[p].typical[n], TIMING[p].maximum[n]];
      return out;
    };
    const a = run("puya"), b = run("uc25hq80");
    assert.notDeepEqual(a.id, b.id); assert.deepEqual([a.id[1], a.id[2]], [b.id[1], b.id[2]]);   // same memory type and capacity bytes
    assert.deepEqual([a.welInCycleUnknown, b.welInCycleUnknown], [false, true]);
    assert.deepEqual([a.pp, b.pp], [[2000, 3000], [1500, 3000]]);
    assert.deepEqual([a.se, b.se], [[8000, 20000], [7000, 10000]]);
    assert.deepEqual([a.ce, b.ce], [[8000, 20000], [7000, 10000]]);
    // identical where the datasheets agree: the protection tables, the status layout and the command set
    assert.deepEqual(PROFILES.puya.protection.cmp0.map((r) => [r.pattern, r.range]), PROFILES.uc25hq80.protection.cmp0.map((r) => [r.pattern, r.range]));
    assert.deepEqual(PROFILES.puya.protection.cmp1.map((r) => [r.pattern, r.range]), PROFILES.uc25hq80.protection.cmp1.map((r) => [r.pattern, r.range]));
  });
  test("chip model: the profile IDs match the selectable flash IDs of the harness (Component 2)", () => {
    assert.deepEqual(PROFILES.puya.jedec, FLASH_IDS.puya.bytes);
    assert.deepEqual(PROFILES.uc25hq80.jedec, FLASH_IDS.uc25hq80.bytes);
  });

  // ---------------------------------------------------------------- traceability (registered last)
  test("chip model: every modelled behaviour has page-level datasheet citations and at least one test, per profile", () => {
    const LEVELS = new Set(["verified", "interpretation", "unspecified", "not-modeled"]), PAGES = { puya: 70, uc25hq80: 61 };
    const problems = [];
    for (const [id, b] of Object.entries(BEHAVIORS)) {
      assert.ok(b.summary, `${id} has a summary`);
      for (const p of NAMES) {
        const e = b[p];
        if (!e) { if (coverage[p].has(id)) problems.push(`${p}: ${id} is tested but has no ${p} entry`); continue; }
        if (!LEVELS.has(e.level)) problems.push(`${p}: ${id} has level ${e.level}`);
        if (!e.cites?.length) problems.push(`${p}: ${id} has no citation`);
        for (const c of e.cites ?? []) {
          if (c.doc !== p || !DOCS[p] || !Number.isInteger(c.page) || c.page < 1 || c.page > PAGES[p] || !c.section) problems.push(`${p}: ${id} has a malformed citation ${JSON.stringify(c)}`);
        }
        if (e.level === "interpretation" && !e.note) problems.push(`${p}: ${id} is an interpretation and must say how it is read (note)`);
        if (!coverage[p].has(id)) problems.push(`${p}: ${id} has no test`);
      }
      if (!b.puya && !b.uc25hq80) problems.push(`${id} applies to no profile`);
    }
    for (const p of NAMES) for (const id of coverage[p]) if (!BEHAVIORS[id]) problems.push(`${p}: tests cover unknown behaviour ${id}`);
    assert.deepEqual(problems, []);
  });
}

// ---------------------------------------------------------------- stand-alone runner
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const tests = [];
  registerChipTests((name, fn) => tests.push({ name, fn }));
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn({ full: true }); console.log(`ok   ${name}`); }
    catch (error) { failed++; console.log(`FAIL ${name}\n     ${String(error.stack ?? error).split("\n").slice(0, 6).join("\n     ")}`); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (!failed) console.log(`PASS: ${tests.length} chip-model tests`);
  process.exit(failed ? 1 : 0);
}
