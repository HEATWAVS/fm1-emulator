// Live chip conformance tests (Component 4, Stage C3): the chip of the REAL chip-profile engine (ci/engine/build.mjs), driven over the
// SoC's SPI0 and chip-select registers by chiplive.mjs, for both the Puya P25Q80H reference profile and the UC25HQ80.
// Expected values are the datasheets' literal figures (the printed protection tables and timing tables exported by chiptests.mjs, which
// are typed from the datasheets with page numbers), not read back from chipspec.mjs or the Rust tables. Page numbers: Puya V1.7 "P",
// UC25HQ80 v1.2 "U".
// Full tier only; reported SKIPPED, never passed, when the chip engine has not been built. Test names start "chip live [<profile>]".
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LiveChip, SETTLE_US, FLASH_BYTES, pat } from "./chiplive.mjs";
import { Fm1Machine } from "./machine.mjs";
import { TIMING, PRINTED, PUYA_CE_RUNS, UC_CE_RUNS, UC_CE_CONFLICT, MID } from "./chiptests.mjs";
import { watch } from "./monitor.mjs";

const PROFILES = ["puya", "uc25hq80"];
const a3 = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const SR = { WIP: 0x1, WEL: 0x2, SRP0: 0x80, SRP1: 0x100, QE: 0x200, LB1: 0x800, LB2: 0x1000, LB3: 0x2000, CMP: 0x4000 };
const NO_EVENTS = { unspecified: 0, notModeled: 0, lastNotModeled: 0 };
const fnv = (a) => { let h = 0x811c9dc5; for (let i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, "0"); };
// Printed protection rows (typed from the datasheets): the range protected for BP4..BP0 = `bits` and CMP, null = none.
const rowMatches = (label, bits) => [...label].every((ch, i) => ch === "x" || ch === bits[i]);
const protectedRange = (cmp, bits) => { const hits = PRINTED[cmp ? "cmp1" : "cmp0"].filter(([l]) => rowMatches(l, bits)); assert.equal(hits.length, 1, `exactly one printed row for CMP=${cmp} BP=${bits}`); return hits[0][1]; };
const overlaps = (range, lo, hi) => range !== null && lo <= range[1] && hi >= range[0];

export function registerLiveChipTests(testChip, { chipEngine, pkg, quadro }) {
  const open = (profile, { timing = "typical", fill = "ff", options = {} } = {}) => {
    const c = LiveChip.boot(chipEngine, pkg, { flashChip: profile, flashTiming: timing, ...options });
    return fill ? c.fill(fill) : c;
  };
  const T = (profile, name, fn) => testChip(`chip live [${profile}]: ${name}`, () => fn(profile));
  const both = (name, fn) => { for (const p of PROFILES) T(p, name, fn); };
  const restore = (c, lo, hi) => { const m = c.mem(); for (let i = lo; i <= hi; i++) m[i] = pat(i); };
  // state of a flash range against the "pat" fill: "same" (untouched), "erased" (all FF) or "other"
  const state = (c, lo, hi) => {
    const m = c.mem(); let same = true, erased = true;
    for (let i = lo; i <= hi; i++) { if (m[i] !== pat(i)) same = false; if (m[i] !== 0xff) erased = false; }
    return same ? "same" : erased ? "erased" : "other";
  };

  // ------------------------------------------------------------------------------------------------ identity
  both("9Fh answers the profile's JEDEC ID, repeatedly; the status register reads 0 on power-up", (p) => {
    const c = open(p);
    assert.deepEqual(c.id(), [MID[p], 0x60, 0x14]);                       // Puya p50 (85 60 14); UC Table-8.0 p14 (B3 60 14)
    assert.deepEqual(c.tx([0x9f], 1), [MID[p]]);
    assert.equal(c.status(), 0);
    assert.equal(c.wip(), false);
    assert.deepEqual(c.events(), NO_EVENTS, "nothing was refused");
  });

  // ------------------------------------------------------------------------------------------------ 1. WEL enforcement
  both("WEL: program, every erase and WRSR are not accepted without WREN: array, status and WIP untouched, nothing refused", (p) => {   // P p22, U p14 / p8
    const cases = [["pp", [0x02, ...a3(0x1000), 0x00], 0x1000, "ff"], ["pe", [0x81, ...a3(0x2050)], 0x2050, "zero"], ["se", [0x20, ...a3(0xa123)], 0xa123, "zero"],
      ["be32", [0x52, ...a3(0x12345)], 0x12345, "zero"], ["be64", [0xd8, ...a3(0x34567)], 0x34567, "zero"], ["ce60", [0x60], 0x80000, "zero"], ["ceC7", [0xc7], 0x80000, "zero"], ["wrsr", [0x01, 0x1c, 0x42], 0, null]];
    for (const [name, tx, at, fill] of cases) {
      const c = open(p, { fill });
      const before = c.mem()[at];
      c.tx(tx);
      assert.equal(c.wip(), false, `${name}: no cycle started`);
      assert.equal(c.status(), 0, `${name}: status unchanged`);
      c.settle();
      assert.equal(c.status(), 0, `${name}: still unchanged after time passes`);
      if (fill) assert.equal(c.mem()[at], before, `${name}: array untouched`);
      assert.deepEqual(c.events(), NO_EVENTS, `${name}: a command without WEL is simply not accepted`);
    }
  });

  both("WEL: WREN sets it, WRDI clears it, it is visible in 05h, and it clears when a cycle completes", (p) => {                            // P p22 10.2/10.3, U p14/p15
    const c = open(p);
    c.wren(); assert.equal(c.status(), SR.WEL);
    c.tx([0x04]); assert.equal(c.status(), 0);
    c.wren(); c.wren(); assert.equal(c.status(), SR.WEL, "WREN twice is still one latch");
    c.tx([0x02, ...a3(0x100), 0x55]);
    assert.equal(c.wip(), true);
    if (p === "puya") assert.equal(c.status(), SR.WIP | SR.WEL, "Puya: WEL stays 1 until the cycle completes (P p36, p39); the UC25HQ80 resets it at an unspecified time before");
    c.settle();
    assert.equal(c.status(), 0, "WIP and WEL both clear when the cycle completes");
    assert.equal(c.mem()[0x100], 0x55);
    c.wren(); c.tx([0x01, 0x04, 0x00]); c.settle(); assert.equal(c.status() & 0x1c, 0x04, "a write-status cycle with WEL runs and clears WEL");
    assert.equal(c.status() & SR.WEL, 0);
  });

  // ------------------------------------------------------------------------------------------------ 2. page program
  both("page program: wraps inside its 256-byte page, keeps the last 256 bytes, ANDs with the old data, never touches the next page", (p) => {   // P p39, U p28
    const c = open(p, { fill: "pat" });
    c.run([0x02, ...a3(0x10100 + 0xfe), 0x00, 0x00, 0x00, 0x00]);                      // 4 bytes from page offset 0xFE: 0xFE,0xFF then wraps to 0x00,0x01
    const m = c.mem(), base = 0x10100;
    assert.deepEqual([m[base + 0xfe], m[base + 0xff], m[base], m[base + 1]], [0, 0, 0, 0], "wrapped inside the page");
    assert.equal(m[base + 2], pat(base + 2), "the byte after the wrapped data is untouched");
    assert.equal(m[base + 0x100], pat(base + 0x100), "the next page is untouched");
    assert.equal(m[base - 1], pat(base - 1), "the previous page is untouched");
    c.run([0x02, ...a3(0x20000 + 0x80), ...Array.from({ length: 256 }, (_, i) => i)]);  // exactly 256 bytes from the middle of the page: all land, wrapped
    for (let i = 0; i < 256; i++) assert.equal(m[0x20000 + ((0x80 + i) & 0xff)], pat(0x20000 + ((0x80 + i) & 0xff)) & i, `256-byte wrap, byte ${i}`);
    c.run([0x02, ...a3(0x30000), ...Array.from({ length: 300 }, (_, i) => (i * 3) & 0xff)]);   // 300 bytes: only the last 256 (bytes 44..299) are programmed
    for (let o = 0; o < 256; o++) { const i = o >= 44 ? o : o + 256; assert.equal(m[0x30000 + o], pat(0x30000 + o) & ((i * 3) & 0xff), `last-256 rule, offset ${o} holds data byte ${i}`); }   // (where they land is the interpretation P p39 / U p28: wrapped from the start address)
    c.run([0x02, ...a3(0x40010), 0xf0]);                                               // a short program leaves the rest of the page alone
    assert.equal(m[0x40010], pat(0x40010) & 0xf0);
    for (const o of [0x0f, 0x11, 0x00, 0xff]) assert.equal(m[0x40000 + o], pat(0x40000 + o), `offset ${o} untouched`);
    c.run([0x02, ...a3(0x40010), 0x0f]);                                               // programming only clears bits: old AND new
    assert.equal(m[0x40010], pat(0x40010) & 0xf0 & 0x0f);
    assert.deepEqual(c.events(), NO_EVENTS);
  });

  both("reads: 03h and 0Bh return the array, 0Bh after one dummy byte, and the address rolls over to 0 after the last byte", (p) => {      // P p28, U p18
    const c = open(p, { fill: "pat" });
    const want = (a, n) => Array.from({ length: n }, (_, i) => pat((a + i) % FLASH_BYTES));
    assert.deepEqual(c.tx([0x03, ...a3(0x12345)], 8), want(0x12345, 8));
    assert.deepEqual(c.tx([0x0b, ...a3(0x12345), 0x00], 8), want(0x12345, 8));
    assert.deepEqual(c.tx([0x03, 0x0f, 0xff, 0xfe], 4), want(0xffffe, 4), "rolls over to address 0");
    assert.deepEqual(c.tx([0x0b, 0x0f, 0xff, 0xff, 0x00], 3), want(0xfffff, 3));
    assert.deepEqual(c.events(), NO_EVENTS);
  });

  // ------------------------------------------------------------------------------------------------ 4. every erase command
  both("erase: 81h, 20h, 52h, D8h erase exactly their page / 4 KiB / 32 KiB / 64 KiB unit, wherever in the unit the address is", (p) => {   // P p36-37, U p25-27
    for (const [op, size] of [[0x81, 256], [0x20, 4096], [0x52, 32768], [0xd8, 65536]]) {
      for (const off of [0, 1, size - 1, (size >> 1) + 3]) {
        const c = open(p, { fill: "pat" }), unit = 0x50000 + 2 * size, before = c.mem().slice();
        c.run([op, ...a3(unit + off)]);
        const m = c.mem();
        for (let i = 0; i < FLASH_BYTES; i++) {
          const expected = i >= unit && i < unit + size ? 0xff : before[i];
          if (m[i] !== expected) assert.fail(`op ${op.toString(16)} at unit+${off}: byte ${i.toString(16)} is ${m[i].toString(16)}, expected ${expected.toString(16)}`);
        }
        assert.equal(c.status(), 0);
      }
    }
  });

  both("chip erase: 60h and C7h erase the whole array", (p) => {                                                                            // P p38, U p27-28
    for (const op of [0x60, 0xc7]) {
      const c = open(p, { fill: "pat" });
      c.wren(); c.tx([op]);
      assert.equal(c.wip(), true);
      c.settle();
      assert.ok(c.mem().every((b) => b === 0xff), `op ${op.toString(16)}`);
      assert.equal(c.status(), 0);
    }
  });

  // ------------------------------------------------------------------------------------------------ 3. protection, SRP; 4. chip-erase differences
  const BOUNDS = [0, 0xfff, 0x1000, 0x1fff, 0x2000, 0x3fff, 0x4000, 0x7fff, 0x8000, 0xffff, 0x10000, 0x1ffff, 0x20000, 0x3ffff, 0x40000, 0x7ffff, 0x80000, 0xbffff, 0xc0000, 0xdffff, 0xe0000, 0xeffff, 0xf0000, 0xf7fff, 0xf8000, 0xfbfff, 0xfc000, 0xfdfff, 0xfe000, 0xfefff, 0xff000, 0xfffff];
  both("protection: all 64 BP4-BP0/CMP combinations, program and 4 KiB/32 KiB/64 KiB/page erase probed at every protected-area boundary", (p) => {   // P p15-16, U p10-11
    const c = open(p, { fill: "pat" });
    for (const cmp of [0, 1]) for (let n = 0; n < 32; n++) {
      const bits = n.toString(2).padStart(5, "0"), range = protectedRange(cmp, bits);
      c.wrsr(n << 2, cmp << 6);
      assert.equal(c.status(), (n << 2) | (cmp << 14), `CMP=${cmp} BP=${bits} status`);
      for (const ad of BOUNDS) {
        const page = ad - (ad % 256), prot = overlaps(range, page, page + 255);
        c.run([0x02, ...a3(ad), 0x00]);
        assert.equal(c.mem()[ad], prot ? pat(ad) : 0x00, `CMP=${cmp} BP=${bits}: program at ${ad.toString(16)} ${prot ? "ignored" : "runs"}`);
        restore(c, ad, ad);
      }
      for (const [op, size] of [[0x20, 4096], [0x52, 32768], [0xd8, 65536], [0x81, 256]]) for (const ad of BOUNDS.filter((_, i) => i % 4 === 1)) {
        const lo = ad - (ad % size), prot = overlaps(range, lo, lo + size - 1);
        c.run([op, ...a3(ad)]);
        assert.equal(state(c, lo, lo + size - 1), prot ? "same" : "erased", `CMP=${cmp} BP=${bits}: erase ${op.toString(16)} at ${ad.toString(16)} ${prot ? "ignored" : "runs"}`);
        restore(c, lo, lo + size - 1);
      }
      assert.deepEqual(c.events(), NO_EVENTS, "protected commands are ignored silently, never reported as unspecified");
    }
  });

  both("chip erase vs protection: Puya runs exactly when nothing is protected (14 of 64); the UC25HQ80 runs at 1, refuses the 14 where its own pages disagree, ignores the rest", (p) => {   // P p24 p38, U p9 p28
    const c = open(p, { fill: "pat" });
    let ran = 0, conflicts = 0;
    for (const cmp of [0, 1]) for (let n = 0; n < 32; n++) {
      const bits = n.toString(2).padStart(5, "0"), key = `${cmp}:${bits}`;
      c.wrsr(n << 2, cmp << 6);
      const before = c.events();
      c.fill("pat");
      c.wren(); c.tx([0x60]);
      const started = c.wip();
      c.settle();
      const erased = c.mem().every((b) => b === 0xff), after = c.events();
      const runs = p === "puya" ? PUYA_CE_RUNS.has(key) : UC_CE_RUNS.has(key), conflict = p === "uc25hq80" && UC_CE_CONFLICT.has(key);
      assert.equal(erased, runs, `${key}: chip erase ${runs ? "runs" : "does not run"}`);
      assert.equal(started, runs, `${key}: WIP only when it runs`);
      assert.equal(after.unspecified - before.unspecified, conflict ? 1 : 0, `${key}: ${conflict ? "the UC25HQ80's contradiction is refused and counted" : "decided, nothing counted"}`);
      ran += runs; conflicts += conflict;
    }
    assert.equal(ran, p === "puya" ? 14 : 1);
    assert.equal(conflicts, p === "puya" ? 0 : 14);
  });

  both("SRP: 0:0 software, 0:1 hardware (WP# decides), 1:0 power-supply lock-down until power-up, 1:1 is unspecified", (p) => {                    // P p24 p27, U p9 p17
    const c = open(p);
    c.wrsr(SR.SRP0, 0x00);                                                                 // SRP1:SRP0 = 0:1
    assert.equal(c.status(), SR.SRP0);
    c.wp(false);                                                                           // WP# low: hardware protected, WRSR is not executed
    c.wren(); c.tx([0x01, 0x1c, 0x00]); assert.equal(c.wip(), false, "no cycle");
    c.settle(); assert.equal(c.status() & 0xff & ~SR.WEL, SR.SRP0, "status unchanged");
    c.wp(true);                                                                            // WP# high: writable again
    c.wrsr(0x1c, 0x00); assert.equal(c.status(), 0x1c, "SRP0 cleared, BP2..BP0 set");
    c.wrsr(0x00, 0x01);                                                                    // SRP1 alone: 1:0 lock-down
    assert.equal(c.status(), SR.SRP1);
    c.wren(); c.tx([0x01, 0x1c, 0x00]); c.settle();
    assert.equal(c.status() & ~SR.WEL, SR.SRP1, "locked down: WRSR not executed");
    const c2 = c.powerCycle();
    assert.equal(c2.status(), 0, "lock-down returns to 0:0 at power-up (note 1)");
    c2.wrsr(0x1c, 0x00); assert.equal(c2.status(), 0x1c, "writable again after the power cycle");
    const c3 = open(p);
    c3.wrsr(SR.SRP0, 0x01);                                                                // 1:1 one-time-program protection (special order): the datasheets say nothing usable
    assert.equal(c3.status(), SR.SRP0 | SR.SRP1);
    const before = c3.events();
    c3.wren(); c3.tx([0x01, 0x00, 0x00]); c3.settle();
    assert.equal(c3.events().unspecified - before.unspecified, 1, "a WRSR in 1:1 is unspecified: ignored and counted, not guessed");
    assert.equal(c3.status() & ~SR.WEL, SR.SRP0 | SR.SRP1);
  });

  // ------------------------------------------------------------------------------------------------ 5. WIP and timing
  const KINDS = { pp: [0x02, ...a3(0x1000), 0x00], pe: [0x81, ...a3(0x2050)], se: [0x20, ...a3(0xa123)], be32: [0x52, ...a3(0x12345)], be64: [0xd8, ...a3(0x34567)], ce: [0x60], wrsr: [0x01, 0x00, 0x00] };
  for (const timing of ["typical", "maximum"]) {
    both(`timing (${timing}): WIP is set for exactly the datasheet time of each cycle kind, and polling 05h bit 0 measures it`, (p) => {   // P p10-11, U p53
      for (const [kind, tx] of Object.entries(KINDS)) {
        const us = TIMING[p][timing][kind], c = open(p, { timing, fill: "pat" });
        c.wren(); c.tx(tx);
        assert.equal(c.wip(), true, `${kind}: busy at once`);
        assert.equal(c.status() & SR.WIP, SR.WIP);
        c.advance(us - 1);
        assert.equal(c.wip(), true, `${kind}: still busy 1 us before ${us} us`);
        assert.equal(c.status() & SR.WIP, SR.WIP, `${kind}: 05h agrees`);
        c.advance(1);
        assert.equal(c.wip(), false, `${kind}: done at ${us} us`);
        assert.equal(c.status() & (SR.WIP | SR.WEL), 0, `${kind}: WIP and WEL clear`);
        const d = open(p, { timing, fill: "pat" });                                         // a firmware-style poll: 100 us steps until WIP clears
        d.wren(); d.tx(tx);
        let polls = 0;
        while (d.status() & SR.WIP) { d.advance(100); polls++; if (polls > 1000) assert.fail("never completed"); }
        assert.equal(polls * 100, us, `${kind}: a 100 us polling loop measures ${us} us`);
      }
    });
  }

  both("timing: typical is shorter than maximum for every kind; the typical/maximum figures are the datasheet's, per chip", (p) => {
    for (const k of Object.keys(KINDS)) assert.ok(TIMING[p].typical[k] <= TIMING[p].maximum[k], k);
    assert.equal(TIMING[p].typical.pp, p === "puya" ? 2000 : 1500);                       // Puya Table 5-4 tPP typ 2 ms; UC Table-18 tPP typ 1.5 ms
    assert.equal(TIMING[p].maximum.se, p === "puya" ? 20000 : 10000);
    const t = open(p, { timing: "typical" }), x = open(p, { timing: "maximum" });
    for (const c of [t, x]) { c.wren(); c.tx(KINDS.se); }
    t.advance(TIMING[p].typical.se); x.advance(TIMING[p].typical.se);
    assert.equal(t.wip(), false); assert.equal(x.wip(), true, "the same elapsed time: done under typical, still busy under maximum");
  });

  // ------------------------------------------------------------------------------------------------ 6. rejected writes, commands during a cycle, unspecified, not modelled
  both("rejected writes: wrong length, short address, beyond 1 MiB, no data byte: array and WIP untouched; unspecified ones are counted", (p) => {   // P p18 p39, U p12 p28
    const c = open(p, { fill: "pat" }), snap = () => fnv(c.mem());
    const h0 = snap();
    for (const tx of [[0x20, 0x01, 0x00, 0x00, 0x00], [0x20, 0x01, 0x00], [0x52, 0x01, 0x00, 0x00, 0xaa], [0xd8, 0x01], [0x81, 0x01, 0x00, 0x00, 0x00], [0x60, 0x00]]) {
      c.wren(); const before = c.events(); c.tx(tx);
      assert.equal(c.wip(), false, `${tx.map((b) => b.toString(16))}: no cycle`);
      c.tx([0x04]);
      assert.equal(snap(), h0, `${tx.map((b) => b.toString(16))}: array untouched`);
      if (tx[0] === 0x60) assert.equal(c.events().unspecified - before.unspecified, 0, "chip erase with an extra byte is rejected (length), not unspecified");
    }
    let ev = c.events();
    for (const [tx, id] of [[[0x02, 0x01, 0x00, 0x00], "no data byte"], [[0x20, 0xf0, 0x00, 0x00], "address beyond 1 MiB"], [[0x02, 0xf0, 0x00, 0x00, 0x11], "program beyond 1 MiB"]]) {
      c.wren(); c.tx(tx); assert.equal(c.wip(), false, id);
      const e = c.events(); assert.equal(e.unspecified - ev.unspecified, 1, `${id}: unspecified by the datasheets, counted`); ev = e;
      c.tx([0x04]);
    }
    assert.equal(snap(), h0);
    for (const tx of [[0x01], [0x01, 1, 2, 3]]) { c.wren(); c.tx(tx); assert.equal(c.wip(), false, `WRSR with ${tx.length - 1} data bytes is rejected`); c.tx([0x04]); }
    c.wren(); const b = c.events(); c.tx([0x06, 0x00]);                                  // WREN with an extra byte
    assert.equal(c.events().unspecified - b.unspecified, 1, "WREN with extra bytes is unspecified");
  });

  both("commands during a cycle: RDSR works, reads and RDID are not answered (FF), anything else is unspecified and has no effect", (p) => {      // P p18 p23, U p6 p16
    const c = open(p, { fill: "pat" });
    c.wren(); c.tx([0x20, ...a3(0x1000)]);
    const e0 = c.events();
    assert.deepEqual(c.tx([0x03, ...a3(0x50000)], 4), [0xff, 0xff, 0xff, 0xff], "an array read during a cycle is not answered");
    assert.deepEqual(c.tx([0x9f], 3), [0xff, 0xff, 0xff], "RDID during an erase is not decoded");
    assert.equal(c.status() & SR.WIP, SR.WIP, "RDSR is allowed at any time");
    assert.deepEqual(c.events(), e0, "none of those is an event");
    c.tx([0x06]); c.tx([0x02, ...a3(0x70000), 0x00]); c.tx([0x20, ...a3(0x90000)]); c.tx([0x01, 0x00]);
    assert.equal(c.events().unspecified - e0.unspecified, 4, "write commands during a cycle: unspecified, counted");
    c.settle();
    assert.equal(c.mem()[0x70000], pat(0x70000), "the program during the cycle did nothing");
    assert.equal(state(c, 0x90000, 0x90fff), "same", "the second erase did nothing");
    assert.equal(state(c, 0x1000, 0x1fff), "erased", "the first erase completed");
  });

  both("opcodes outside the model (4Bh unique ID, SFDP, REMS, quad...) answer FF, change nothing, and are counted with the opcode", (p) => {
    const c = open(p, { fill: "pat" }), h = fnv(c.mem());
    c.wren();
    let n = 0;
    for (const op of [0x4b, 0x5a, 0x90, 0xab, 0xb9, 0x66, 0x99, 0xeb, 0x3b, 0x75, 0x7a, 0x44, 0x25, 0x50, 0x77]) {
      assert.deepEqual(c.tx([op, 0, 0, 0, 0], 4), [0xff, 0xff, 0xff, 0xff], `${op.toString(16)} answers FF`);
      const e = c.events();
      assert.equal(e.notModeled, ++n); assert.equal(e.lastNotModeled, op); assert.equal(e.unspecified, 0);
    }
    assert.equal(fnv(c.mem()), h, "the array is untouched");
    assert.equal(c.status(), SR.WEL, "WEL, set before, is untouched");
    assert.equal(c.wip(), false);
    if (p === "puya") { c.tx([0x15], 1); c.tx([0x31, 0x00]); assert.equal(c.events().notModeled, n + 2, "Puya's configure register (15h/31h) is not modelled"); }
  });

  // ------------------------------------------------------------------------------------------------ 7. status register and power-cycle persistence
  both("status register: writable and read-only bits, LB bits are one-time-programmable, 05h/35h split", (p) => {                                // P p23-26, U p8-9
    const c = open(p);
    c.wrsr(0xff, 0xff);
    assert.equal(c.status(), 0x7bfc, "SRP0 BP4-0 (S7..S2) and SRP1 QE LB3-1 CMP (S8 S9 S11-S14) take the write; S0 S1 S10 S15 do not");
    assert.deepEqual([c.tx([0x05], 1)[0], c.tx([0x35], 1)[0]], [0xfc, 0x7b]);
    assert.deepEqual(c.tx([0x05], 3), [0xfc, 0xfc, 0xfc], "status can be read continuously");
    const e = open(p);                                                                     // (the chip above is now in SRP 1:1; a fresh one for the LB check)
    e.wrsr(0xff, 0x7a);                                                                    // everything writable except SRP1
    assert.equal(e.status(), 0x7afc);
    e.wrsr(0x00, 0x00);                                                                    // SRP0 is 1 and WP# is high, so the write is allowed
    assert.equal(e.status(), SR.LB1 | SR.LB2 | SR.LB3, "LB3-LB1 are one-time-programmable: still set");
    const d = open(p);
    d.wrsr(0x00, 0x42);
    assert.equal(d.status(), 0x4200, "CMP and QE set by a two-byte write");
    d.wrsr(0x00);                                                                          // a one-byte write
    assert.equal(d.status() & 0xff, 0x00);
    if (p === "puya") assert.equal(d.status(), 0, "Puya p26: a one-byte WRSR clears CMP, QE and SRP1; the UC25HQ80's datasheet does not say");
  });

  both("power cycle: the non-volatile bits (BP, CMP, SRP0, QE, LB) and the array survive; WEL does not; protection still protects afterwards", (p) => {   // P p22 p24, U p9 p15
    const c = open(p, { fill: "pat" });
    c.wrsr(0x04 | 0x80, 0x40 | 0x02 | 0x08);                                              // BP0 (+SRP0), CMP, QE, LB1
    // CMP=1 with BP=00001 protects 000000-0EFFFF: only 0F0000-0FFFFF stays writable
    assert.equal(c.status(), 0x4a84, "status as written");
    c.wren(); assert.equal(c.status() & SR.WEL, SR.WEL);
    const d = c.powerCycle();
    assert.equal(d.status(), 0x4a84, "the non-volatile bits are kept, WEL is gone");
    d.run([0x02, ...a3(0x10000), 0x00]); assert.equal(d.mem()[0x10000], pat(0x10000), "still protected after the power cycle (CMP=1, BP=00001: 000000-0EFFFF)");
    d.run([0x02, ...a3(0xf0000), 0x00]); assert.equal(d.mem()[0xf0000], 0x00, "the unprotected top 64 KiB still programs");
    d.run([0x01, 0x00, 0x00]);                                                             // SRP0 = 1 with WP# high (the default): WRSR is allowed
    assert.equal(d.status(), SR.LB1, "everything clears except LB1: one-time-programmable, even after a power cycle");
    assert.deepEqual(d.events(), NO_EVENTS);
    // a different chip swapped in while the unit is off has its own (fresh) status
    const swapped = d.powerCycle({ flashChip: p === "puya" ? "uc25hq80" : "puya" });
    assert.equal(swapped.status(), 0, "another chip starts with status 0");
    assert.deepEqual(swapped.id(), [p === "puya" ? 0xb3 : 0x85, 0x60, 0x14]);
    // two more power cycles: the array is carried each time
    const e = d.powerCycle().powerCycle();
    assert.equal(e.mem()[0xf0000], 0x00, "the program made before the cycles is still there");
    assert.equal(e.mem()[0x10000], pat(0x10000), "and the ignored one still is not");
  });

  both("power cycle: a cycle still running when the unit is switched off is treated as completing (power loss mid-cycle is Component 5)", (p) => {
    const c = open(p, { fill: "pat" });
    c.wren(); c.tx([0x01, 0x1c, 0x00]);                                                    // a write-status cycle in progress
    assert.equal(c.wip(), true);
    const d = c.powerCycle();
    assert.equal(d.status(), 0x1c, "the write completed (not modelled as lost)");
    assert.equal(d.wip(), false);
  });

  // ------------------------------------------------------------------------------------------------ 8. legacy regression (the original instantaneous model)
  testChip("chip live [legacy]: the default is the original model: instant, never busy, program ignores WEL, no wrap, fake 4Bh, no protection", () => {
    // Expectations are read from the original crates/fm1-soc/src/spiflash.rs (upstream v0.3.0), which the default path still runs.
    const c = LiveChip.boot(chipEngine, pkg).fill("pat");
    assert.deepEqual(c.id(), [0x85, 0x60, 0x14], "FM-1 board default ID");
    assert.equal(c.status(), 0, "05h: WEL false -> 0, 35h: always 0");
    c.tx([0x02, ...a3(0x1000), 0x00]);                                                      // program with no WREN: the original model programs anyway
    assert.equal(c.mem()[0x1000], 0x00);
    c.wren(); assert.equal(c.tx([0x05], 1)[0], 0x02, "05h shows WEL only"); assert.equal(c.tx([0x35], 1)[0], 0x00);
    c.tx([0x02, ...a3(0x20000 + 0xfe), 0x00, 0x00, 0x00, 0x00]);
    assert.deepEqual([0xfe, 0xff].map((o) => c.mem()[0x20000 + o]).concat([c.mem()[0x20100], c.mem()[0x20101]]), [0, 0, 0, 0], "no page wrap: the bytes run into the next page");
    assert.equal(c.mem()[0x20000], pat(0x20000), "nothing wrapped to the start of the page");
    assert.equal(c.tx([0x05], 1)[0], 0x00, "WEL cleared when the program ended");
    c.tx([0x20, ...a3(0x30000)]);                                                          // erase without WREN: needs WEL
    assert.equal(state(c, 0x30000, 0x30fff), "same");
    c.wren(); c.tx([0x20, ...a3(0x30000)]);                                                // with WREN: instant, no cycle
    assert.equal(state(c, 0x30000, 0x30fff), "erased", "erased before any time passes");
    assert.equal(c.wip(), false); assert.equal(c.tx([0x05], 1)[0] & 1, 0, "never busy");
    for (const tx of [[0x52, ...a3(0x40000)], [0x81, ...a3(0x40000)], [0x60], [0xc7], [0x01, 0xff, 0xff]]) { c.wren(); c.tx(tx); }
    assert.equal(state(c, 0x40000, 0x4ffff), "same", "52h, 81h, 60h, C7h and 01h do nothing in the original model");
    assert.deepEqual(c.tx([0x4b, 0, 0, 0, 0], 8), [0x46, 0x4d, 0x31, 0x2d, 0x46, 0x4d, 0x31, 0x2d], "4Bh returns the original model's FM1- pattern");
    assert.deepEqual(c.tx([0x0b, ...a3(0x50000), 0x00], 4), [0, 1, 2, 3].map((i) => pat(0x50000 + i)), "reads work");
    assert.deepEqual(c.events(), NO_EVENTS, "no chip profile: no events");
    assert.equal(c.x.fm1_flash_nv_status(), 0);
    assert.equal(c.x.fm1_flash_timing(0), 1, "timing needs a profile");
    assert.equal(c.x.fm1_flash_revision() > 0, true, "revision counts the erase and programs as before");
    // the machine-level default is unchanged too
    const m = Fm1Machine.boot(chipEngine, pkg, { usb: false });
    assert.equal(m.flashChipInfo, null);
    assert.equal(m.powerCycle().flashChipInfo, null);
  });

  // ------------------------------------------------------------------------------------------------ quadro-fm1's 4Bh
  testChip("chip live [puya]: the unsupported opcode quadro-fm1 issues under the Puya profile is 4Bh (read unique ID), at boot, once; the model answers FF and counts it", () => {
    const m = Fm1Machine.boot(chipEngine, quadro, { flashChip: "puya", usb: false });
    assert.deepEqual(m.flashEvents(), NO_EVENTS, "nothing before the firmware runs");
    let at = null;
    for (let i = 0; i < 20 && at === null; i++) { m.run(3); if (m.flashEvents().notModeled) at = m.observe().audioMs; }
    assert.ok(at !== null && at <= 30, `issued during start-up (audio ${at} ms)`);
    m.run(1000);
    const e = m.flashEvents();
    assert.deepEqual(e, { unspecified: 0, notModeled: 1, lastNotModeled: 0x4b }, "once, opcode 4Bh, nothing else unmodelled or unspecified in the first second");
    assert.equal(m.flashChipInfo.chip, "puya");
    const u = Fm1Machine.boot(chipEngine, quadro, { flashChip: "uc25hq80", usb: false });
    u.run(1000);
    assert.deepEqual(u.flashEvents(), NO_EVENTS, "quadro-fm1 1.0 does not recognise B3 60 14, so it never reads the unique ID there");
  });

  // ------------------------------------------------------------------------------------------------ full oracle replay through the live engine
  both("oracle replay: every transaction of the Stage A model's transcripts (byte-aligned form), replayed over the live engine's SPI0, gives the same answers, array and WIP", (p) => {
    const dir = mkdtempSync(join(tmpdir(), "fm1-oracle-"));
    try {
      const file = join(dir, "oracle.txt");
      const r = spawnSync(process.execPath, [resolve(import.meta.dirname, "../engine/gen-transcripts.mjs"), file, "--no-partial"], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      const rep = replay(readFileSync(file, "utf8"), p);
      assert.deepEqual(rep.mismatches, [], `mismatches (first ${rep.mismatches.length}) in ${rep.scenarios} scenarios`);
      assert.ok(rep.scenarios >= 190 && rep.transactions > 20_000 && rep.arrayChecks > 10_000, JSON.stringify(rep));
      assert.ok(rep.errs.unspecified > 500 && rep.errs.notModeled > 100, "the transcripts exercise unspecified and unmodelled cases");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  /** Replays the scenarios of `text` for `profile` through two persistent machines (100 MHz and 24 MHz), resetting the chip per scenario. */
  function replay(text, profile) {
    const machines = {};
    const machine = (hz) => machines[hz] ??= LiveChip.boot(chipEngine, pkg, { mhz: hz / 1e6, flashChip: profile });
    const rep = { scenarios: 0, transactions: 0, arrayChecks: 0, hashes: 0, wipChecks: 0, power: 0, mismatches: [], errs: { unspecified: 0, notModeled: 0 } };
    let c = null, name = "", usTotal = 0, skip = false, lastEvents = null;
    const bad = (ln, what) => { if (rep.mismatches.length < 15) rep.mismatches.push(`${name} line ${ln}: ${what}`); };
    const unhex = (h) => (h === "-" ? [] : h.match(/../g).map((b) => parseInt(b, 16)));
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i], ln = i + 1, f = line.split(" ");
      switch (f[0]) {
        case "S": {
          skip = f[2] !== profile;
          name = f[1];
          if (skip) break;
          c = machine(Number(f[4]));
          c.x.fm1_flash_chip(profile === "puya" ? 1 : 2); c.x.fm1_flash_timing(f[3] === "typical" ? 0 : 1);
          c.wp(f[5] === "1");
          c.fill(f[6] === "pat" ? "pat" : "ff");
          lastEvents = c.events(); usTotal = 0; rep.scenarios++;
          break;
        }
        case "E": c = null; break;
        case "T": {
          if (skip) break;
          const adv = Number(f[1]);
          c.advance(adv);
          const res = line.split(" => ")[1];
          if (res === "ADV") break;
          const read = Number(f[3]), tx = unhex(f[4]);
          rep.transactions++;
          const out = c.tx(tx, read), ev = c.events(), r = res.split(" ");
          const dU = ev.unspecified - lastEvents.unspecified, dN = ev.notModeled - lastEvents.notModeled;
          lastEvents = ev;
          if (r[0] === "OK") {
            if (dU || dN) bad(ln, `oracle OK but the chip counted ${dU} unspecified / ${dN} unmodelled`);
            const eout = unhex(r[1]), eunk = unhex(r[2]), status = tx[0] === 0x05 || tx[0] === 0x35;
            if (read > 0 && eout.length) for (let k = 0; k < read; k++) if (((out[k] ^ eout[k]) & (status ? ~eunk[k] & 0xff : 0xff)) !== 0) { bad(ln, `tx ${f[4]} byte ${k}: ${out[k].toString(16)} vs oracle ${eout[k].toString(16)}`); break; }
          } else {
            const nm = r[2].startsWith("nm.") || r[2] === "cmd.unknown";
            rep.errs[nm ? "notModeled" : "unspecified"]++;
            if ((nm ? dN : dU) !== 1 || (nm ? dU : dN) !== 0) bad(ln, `oracle refuses (${r[2]}) but the chip counted ${dU} unspecified / ${dN} unmodelled`);
            else if (nm && ev.lastNotModeled !== tx[0]) bad(ln, `unmodelled opcode ${tx[0].toString(16)} reported as ${ev.lastNotModeled.toString(16)}`);
          }
          break;
        }
        case "P": {
          if (skip) break;
          rep.power++;
          if (line.endsWith("=> OK")) { c.x.fm1_flash_nv_restore(c.x.fm1_flash_nv_status() >>> 0); lastEvents = c.events(); }     // power off and on: non-volatile bits kept, WEL cleared
          break;                                                                                // (a power cycle mid-cycle is the oracle's nm.power-loss refusal: nothing to replay)
        }
        case "A": {
          if (skip) break;
          const a = Number(f[1]), l = Number(f[2]);
          rep.arrayChecks++;
          if (Buffer.compare(Buffer.from(c.mem().subarray(a, a + l)), Buffer.from(unhex(f[3]))) !== 0) bad(ln, `array ${a.toString(16)}+${l}`);
          break;
        }
        case "D": {
          if (skip) break;
          rep.hashes++;
          if (fnv(c.mem()) !== f[1]) bad(ln, `final array hash ${fnv(c.mem())} vs oracle ${f[1]}`);
          break;
        }
        case "W": {
          if (skip) break;
          rep.wipChecks++;
          if (c.wip() !== (f[1] === "1")) bad(ln, `WIP ${c.wip()} vs oracle ${f[1]}`);
          break;
        }
        case "": break;
        default: throw new Error(`unknown transcript line ${line}`);
      }
    }
    return rep;
  }
}
