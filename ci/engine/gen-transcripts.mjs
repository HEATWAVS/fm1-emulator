// Deterministic oracle transcripts: drives the Stage A reference model (ci/machine/chipmodel.mjs) through systematic and
// seeded-random scenarios and records every result. The Rust test (fm1-soc/tests/chip_oracle.rs) replays them.
// Usage: node ci/engine/gen-transcripts.mjs <out.txt> [--no-partial]   (deterministic: the same file every run; used by build.mjs --test)
// --no-partial: every transaction ends on a byte boundary (what the machine's byte-wide SPI0 can do); the oracle's answers are recomputed for it.
// The live-engine replay (ci/machine/chiplivetests.mjs) uses this form; the Rust host tests use the default form.
// 4Bh Read Unique ID is modelled by the reference model but NOT yet by the Rust engine, so the default transcripts never contain it (the engine answers FF and
// counts it). --with-ruid appends scenarios that do, for the Rust port to be checked against (their S line carries uid=<32 hex digits>; absent = no fixture).
// Line formats (see chip_oracle.rs): S/E scenario brackets; T transaction + result; P power cycle; A array check; D array hash; W WIP.
import { writeFileSync } from "node:fs";
const { ChipModel, ManualClock, UnspecifiedBehavior, NotModeled } = await import("../machine/chipmodel.mjs");
const { PROFILES, SR } = await import("../machine/chipspec.mjs");

const BYTES = 1 << 20;
const hex = (u) => (u && u.length ? Buffer.from(u).toString("hex") : "-");
const pat = () => { const a = new Uint8Array(BYTES); for (let i = 0; i < BYTES; i++) a[i] = ((i * 131 + (i >> 8) * 17) ^ 0x5a) & 0xff; return a; };
const fnv = (a) => { let h = 0x811c9dc5; for (let i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, "0"); };

const lines = [];
const stats = { scenarios: 0, transactions: 0, ok: 0, err: {}, arrayChecks: 0, hashes: 0, wipChecks: 0, power: 0 };
let sc = null;

function begin(name, profile, timing, { hz = 100_000_000, wp = true, image = "ff", uid = null } = {}) {
  const clock = new ManualClock();
  const chip = new ChipModel({ profile, clock, timing, wp, image: image === "pat" ? pat() : null, uid: uid ? Array.from(Buffer.from(uid, "hex")) : null });
  sc = { name, chip, clock, dirty: [], profile, timing, hz, image };
  lines.push(`S ${name} ${profile} ${timing} ${hz} ${wp ? 1 : 0} ${image}${uid ? ` uid=${uid}` : ""}`);
  stats.scenarios++;
  return sc;
}
function end() {
  idle();
  flushDirty();
  const a = sc.chip.peek(0, BYTES);
  lines.push(`D ${fnv(a)}`); stats.hashes++;
  lines.push("E");
}
/** one transaction. adv = microseconds to advance first. */
const NO_PARTIAL = process.argv.includes("--no-partial");
function t(tx, { read = 0, partial: partialWanted = 0, adv = 0 } = {}) {
  const partial = NO_PARTIAL ? 0 : partialWanted;
  if (adv) sc.clock.advance(adv);
  let res;
  try {
    const r = sc.chip.transact(tx, { read, partialBits: partial });
    res = `OK ${hex(r.out)} ${hex(r.unknown)}`; stats.ok++;
  } catch (e) {
    if (e instanceof UnspecifiedBehavior || e instanceof NotModeled) { res = `ERR ${e.name} ${e.id}`; stats.err[e.id] = (stats.err[e.id] || 0) + 1; } else throw e;
  }
  lines.push(`T ${adv} ${partial} ${read} ${hex(tx)} => ${res}`);
  stats.transactions++;
  return res;
}
const wren = (adv = 0) => t([0x06], { adv });
const rdsr = () => { t([0x05], { read: 1 }); t([0x35], { read: 1 }); };
const addr3 = (a) => [(a >> 16) & 0xff, (a >> 8) & 0xff, a & 0xff];
function idle() { const e = sc.chip.busyUntil(); if (e !== null) { const d = e - sc.clock.now(); if (d > 0) { sc.clock.advance(d); lines.push(`T ${d} 0 0 - => ADV`); } } }
function wip() { const w = sc.chip.busyUntil() !== null; lines.push(`W ${w ? 1 : 0}`); stats.wipChecks++; }
function a(addr, len) {
  if (sc.chip.busyUntil() !== null) return;                         // the model refuses to show the array mid-cycle
  addr = Math.max(0, Math.min(addr, BYTES - len));
  lines.push(`A ${addr} ${len} ${hex(sc.chip.peek(addr, len))}`); stats.arrayChecks++;
}
const dirty = (lo, hi) => sc.dirty.push([lo, hi]);
function flushDirty() {
  if (sc.chip.busyUntil() !== null) return;
  for (const [lo, hi] of sc.dirty.splice(0)) { const len = hi - lo + 1; if (len <= 256) a(lo, len); else { a(lo, 8); a(hi - 7, 8); a(lo + (len >> 1) - 4, 8); } }
}
function power() { const r = (() => { try { sc.chip.powerCycle(); return "OK"; } catch (e) { if (e instanceof NotModeled) return `ERR NotModeled ${e.id}`; throw e; } })(); lines.push(`P => ${r}`); stats.power++; }

let seed = 1;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const ri = (n) => Math.floor(rnd() * n);
const pick = (arr) => arr[ri(arr.length)];

const BOUNDS = [0, 0xfff, 0x1000, 0x1fff, 0x2000, 0x3fff, 0x4000, 0x7fff, 0x8000, 0xffff, 0x10000, 0x1ffff, 0x20000, 0x3ffff, 0x40000, 0x7ffff, 0x80000, 0xbffff, 0xc0000, 0xdffff, 0xe0000, 0xeffff, 0xf0000, 0xf7fff, 0xf8000, 0xfbfff, 0xfc000, 0xfdfff, 0xfe000, 0xfefff, 0xff000, 0xfffff];
const SPEC = (p) => PROFILES[p].timingUs;
const kinds = ["pp", "se", "be32", "be64", "pe", "ce", "wrsr"];

// ------------------------------------------------------------------ systematic scenarios (every profile and timing)
for (const profile of ["puya", "uc25hq80"]) {
  for (const timing of ["typical", "maximum"]) {
    const T = (n) => `${n}-${profile}-${timing}`;
    // identity and status
    begin(T("identity"), profile, timing);
    t([0x9f], { read: 3 }); t([0x9f], { read: 0 }); t([0x9f], { read: 2 }); t([0x9f], { read: 4 }); t([0x9f], { read: 5 });
    rdsr(); t([0x05], { read: 3 }); t([0x35], { read: 3 }); end();

    // write enable latch
    begin(T("wel"), profile, timing);
    rdsr(); wren(); rdsr(); t([0x04]); rdsr(); wren(); wren(); rdsr(); t([0x06, 0x00]); rdsr(); t([0x04, 0x01]); rdsr();
    t([0x06], { partial: 3 }); rdsr(); wren(); t([0x04], { partial: 1 }); rdsr();
    t([0x02, 0, 0, 0, 0x12]); rdsr();                                   // program without WEL
    t([0x20, 0, 0, 0]); t([0x60]); t([0xc7]); t([0x01, 0x00]); rdsr();
    wren(); power(); rdsr(); end();

    // page program: basic, wrap, long, partial, AND semantics, timing at the cycle edge
    for (const image of ["ff", "pat"]) {
      begin(T("program-" + image), profile, timing, { image });
      wren(); t([0x02, 0x01, 0x00, 0x00, 0xaa, 0x55]); dirty(0x10000, 0x10001); wip(); rdsr();
      const end1 = sc.chip.busyUntil() - sc.clock.now();
      sc.clock.advance(end1 - 1); lines.push(`T ${end1 - 1} 0 0 - => ADV`); wip(); rdsr();
      sc.clock.advance(1); lines.push(`T 1 0 0 - => ADV`); wip(); rdsr(); flushDirty();
      wren(); t([0x02, 0x01, 0x00, 0x00, 0x0f, 0xf0]); idle(); dirty(0x10000, 0x10001); flushDirty();     // AND with the old bytes
      wren(); t([0x02, 0x01, 0x00, 0xfe, 1, 2, 3, 4, 5, 6]); idle(); dirty(0x100f0, 0x100ff); dirty(0x10000, 0x10010); flushDirty();   // wraps in the page
      wren(); t([0x02, 0x02, 0x00, 0x80, ...Array.from({ length: 256 }, (_, i) => i)]); idle(); dirty(0x20000, 0x200ff); flushDirty();   // exactly 256 from the middle: wraps
      wren(); t([0x02, 0x03, 0x00, 0x10, ...Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff)]); idle(); dirty(0x30000, 0x300ff); flushDirty();   // more than 256: last 256 kept
      wren(); t([0x02, 0x04, 0x00, 0xff, 0x77]); idle(); dirty(0x40000, 0x400ff); flushDirty();
      wren(); t([0x02, 0x05, 0x00, 0x00]); rdsr(); idle();                // no data byte
      wren(); t([0x02, 0x05, 0x00]); rdsr(); idle();
      wren(); t([0x02, 0x06, 0x00, 0x00, 0x11], { partial: 4 }); rdsr(); idle(); dirty(0x60000, 0x600ff); flushDirty();      // CS# mid-byte
      wren(); t([0x02, 0x10, 0x00, 0x00, 0x11]); t([0x02, 0x10, 0x00, 0x00, 0x22], { adv: 1 }); rdsr(); idle();   // second program while busy
      wren(); t([0x02, 0x10, 0x00, 0x00, 0x33]); rdsr(); flushDirty(); end();
      void 0;
    }

    // erase: every size, every position within the unit, boundaries, length errors, missing WEL, mid-byte
    begin(T("erase"), profile, timing, { image: "pat" });
    for (const [op, size] of [[0x81, 256], [0x20, 4096], [0x52, 32768], [0xd8, 65536]]) {
      for (const off of [0, 1, size - 1, (size >> 1) + 3]) {
        const base = 0x20000 + 0x10000 * (op >> 5 & 3) ;
        const addr = base + off;
        wren(); t([op, ...addr3(addr)]); wip(); rdsr(); idle(); const lo = addr - (addr % size); dirty(lo - 4, lo + 3); dirty(lo + size - 4, lo + size + 3); flushDirty(); rdsr();
      }
      wren(); t([op, ...addr3(0x70000)], { partial: 2 }); idle(); rdsr(); dirty(0x70000, 0x70010); flushDirty();
      wren(); t([op, 0x07, 0x00]); idle(); rdsr(); wren(); t([op, ...addr3(0x70000), 0x00]); idle(); rdsr(); flushDirty();
      t([op, ...addr3(0x70000)]); rdsr(); flushDirty();                     // no WEL
      wren(); t([op, 0xf0, 0x00, 0x00]); rdsr(); idle();                    // beyond 1 MiB
    }
    wren(); t([0x60]); wip(); idle(); rdsr(); flushDirty(); end();
    begin(T("chip-erase"), profile, timing, { image: "pat" });
    wren(); t([0xc7]); wip(); rdsr(); a(0, 4); idle(); rdsr(); a(0, 4); a(0xfffff - 3, 4);
    wren(); t([0x60, 0x00]); rdsr(); wren(); t([0xc7], { partial: 5 }); rdsr(); idle(); end();

    // timing of every cycle kind at 1 us either side of its end (typical and maximum come from the model itself)
    for (const k of kinds) {
      begin(T("edge-" + k), profile, timing, { image: "pat" });
      wren();
      if (k === "pp") t([0x02, 0x01, 0x00, 0x00, 0x0f]); else if (k === "se") t([0x20, 0x01, 0x00, 0x00]); else if (k === "be32") t([0x52, 0x01, 0x00, 0x00]);
      else if (k === "be64") t([0xd8, 0x01, 0x00, 0x00]); else if (k === "pe") t([0x81, 0x01, 0x00, 0x00]); else if (k === "ce") t([0xc7]); else t([0x01, 0x00, 0x00]);
      const d = sc.chip.busyUntil() - sc.clock.now();
      wip(); rdsr();
      for (const dt of [d - 1, 1, 1]) { sc.clock.advance(dt); lines.push(`T ${dt} 0 0 - => ADV`); wip(); rdsr(); }
      flushDirty(); end();
    }

    // commands during a cycle
    begin(T("busy"), profile, timing, { image: "pat" });
    wren(); t([0x20, 0x01, 0x00, 0x00]);
    for (const tx of [[0x06], [0x04], [0x02, 0x03, 0x00, 0x00, 0x11], [0x20, 0x02, 0, 0], [0x60], [0x01, 0x00], [0x35], [0x05]]) { t(tx, { read: tx[0] === 0x35 || tx[0] === 0x05 ? 1 : 0, adv: 1 }); }
    t([0x9f], { read: 3, adv: 1 }); t([0x9f], { read: 5, adv: 1 }); t([0x03, 0x01, 0x00, 0x00], { read: 4, adv: 1 }); t([0x0b, 0x01, 0x00, 0x00, 0x00], { read: 4, adv: 1 });
    rdsr(); idle(); rdsr(); flushDirty();
    wren(); t([0x01, 0x00, 0x00]); t([0x9f], { read: 3, adv: 1 }); t([0x05], { read: 1, adv: 1 }); t([0x06], { adv: 1 }); idle(); rdsr(); end();

    // reads
    for (const image of ["pat"]) {
      begin(T("read"), profile, timing, { image });
      t([0x03, 0, 0, 0], { read: 8 }); t([0x0b, 0, 0, 0, 0], { read: 8 }); t([0x03, 0x0f, 0xff, 0xfc], { read: 12 }); t([0x0b, 0x0f, 0xff, 0xfc, 0], { read: 12 });
      t([0x03, 0x01, 0x23, 0x45], { read: 300 }); t([0x03, 0, 0], { read: 0 }); t([0x03], { read: 0 }); t([0x0b, 0, 0, 0], { read: 0 }); t([0x03, 0x10, 0, 0], { read: 2 });
      t([0x0b, 0x10, 0, 0, 0], { read: 2 }); t([0x03, 0, 0, 0], { read: 0 }); end();
    }

    // write status register
    begin(T("wrsr"), profile, timing);
    wren(); t([0x01, 0x3c]); wip(); rdsr(); idle(); rdsr();                                // one byte: BP bits
    wren(); t([0x01, 0x00, 0x00]); idle(); rdsr();
    wren(); t([0x01, 0x00, 0x42]); idle(); rdsr();                                         // CMP + QE, high byte
    wren(); t([0x01, 0x00]); idle(); rdsr();                                               // one byte after high bits were set
    wren(); t([0x01, 0xff, 0xff]); idle(); rdsr(); power(); rdsr();                        // everything (SRP0, LB, ...)
    wren(); t([0x01, 0x00, 0x00]); idle(); rdsr();                                         // OTP bits stay
    wren(); t([0x01]); rdsr(); wren(); t([0x01, 1, 2, 3]); rdsr(); wren(); t([0x01, 0x00], { partial: 3 }); rdsr(); idle(); rdsr(); end();
    for (const wp of [true, false]) {
      begin(T("srp-" + (wp ? "wp-high" : "wp-low")), profile, timing, { wp });
      wren(); t([0x01, 0x80, 0x00]); idle(); rdsr();                                       // SRP1:SRP0 = 0:1 (hardware protected via WP#)
      wren(); t([0x01, 0x1c, 0x00]); rdsr(); idle(); rdsr();
      wren(); t([0x01, 0x00, 0x00]); rdsr(); idle(); rdsr(); power(); rdsr();
      wren(); t([0x01, 0x00, 0x01]); idle(); rdsr();                                       // SRP1 only: lock-down until power cycle
      wren(); t([0x01, 0x1c, 0x00]); rdsr(); idle(); rdsr(); wren(); rdsr(); power(); rdsr(); wren(); t([0x01, 0x04, 0x00]); idle(); rdsr(); end();
      begin(T("srp-otp-" + (wp ? "h" : "l")), profile, timing, { wp });
      wren(); t([0x01, 0x80, 0x01]); idle(); rdsr(); wren(); t([0x01, 0x00, 0x00]); rdsr(); idle(); rdsr(); end();
    }

    // opcodes outside the model, and the Puya configure register
    begin(T("opcodes"), profile, timing);
    for (const op of [0x15, 0x31, 0x50, 0x25, 0x75, 0xb0, 0x7a, 0x30, 0xb9, 0xab, 0x66, 0x99, 0x44, 0x42, 0x48, 0x5a, 0x3b, 0xbb, 0x6b, 0xeb, 0xa2, 0x32, 0x90, 0x92, 0x94, 0x77, 0xff, 0x00, 0x7f, 0xe5]) {
      t([op]); t([op, 1, 2, 3, 4]); rdsr();
    }
    wren(); t([0x20, 0x01, 0, 0]); t([0x50], { adv: 1 }); t([0xb9], { adv: 1 }); idle(); rdsr(); end();
  }
}

// ------------------------------------------------------------------ protection sweep: every BP4..BP0 x CMP, both chips, both timings
for (const profile of ["puya", "uc25hq80"]) {
  for (const timing of ["typical", "maximum"]) {
    for (let cmp = 0; cmp < 2; cmp++) {
      for (let bp = 0; bp < 32; bp++) {
        begin(`prot-${profile}-${timing}-cmp${cmp}-bp${bp.toString(2).padStart(5, "0")}`, profile, timing, { image: "pat" });
        wren(); t([0x01, bp << 2, cmp << 6]); idle(); rdsr();
        for (const ad of BOUNDS) {
          wren(); t([0x02, ...addr3(ad - (ad % 256) + 0x00 + (ad % 256)), 0x0f, 0x0f]); idle(); a(ad, 2); a(ad - (ad % 256), 2); rdsr();
        }
        for (const ad of BOUNDS.filter((_, i) => i % 3 === 0)) {
          wren(); t([0x20, ...addr3(ad)]); idle(); { const lo = ad - (ad % 4096); a(lo, 4); a(lo + 4092, 4); } rdsr();
        }
        for (const [op, size] of [[0x81, 256], [0x52, 32768], [0xd8, 65536]]) for (const ad of [0, 0x8000, 0xf0000, 0xff000, 0xfffff, 0x7ffff]) {
          wren(); t([op, ...addr3(ad)]); idle(); { const lo = ad - (ad % size); a(lo, 4); a(lo + size - 4, 4); } rdsr();
        }
        wren(); t([0x60]); idle(); a(0, 4); a(0xfffff - 3, 4); a(0x80000, 4); rdsr();
        wren(); t([0xc7]); idle(); rdsr(); end();
      }
    }
  }
}

// ------------------------------------------------------------------ seeded random sequences
const NOTMOD = [0x15, 0x31, 0x50, 0x25, 0x75, 0xb0, 0x7a, 0x30, 0xb9, 0xab, 0x66, 0x99, 0x44, 0x42, 0x48, 0x5a, 0x3b, 0xbb, 0x6b, 0xeb, 0xa2, 0x32, 0x90, 0x92, 0x94, 0x77, 0xff, 0x00, 0x13, 0xe5];
function randAddr() { const r = rnd(); if (r < 0.04) return 0x100000 + ri(0x1000); if (r < 0.4) return pick(BOUNDS); if (r < 0.6) return pick(BOUNDS) - ri(300) > 0 ? pick(BOUNDS) - ri(300) : 0; return ri(BYTES); }
function randOp(profile) {
  const r = rnd();
  const ad = randAddr();
  if (r < 0.18) return wren();
  if (r < 0.22) return t([0x04]);
  if (r < 0.26) return t([0x06, ri(256)]);
  if (r < 0.36) { t([pick([0x05, 0x35])], { read: 1 + ri(2) }); return; }
  if (r < 0.40) return t([0x9f], { read: ri(5) });
  if (r < 0.46) { const o = pick([0x03, 0x0b]); return t([o, ...addr3(ad), ...(o === 0x0b ? [0] : [])], { read: ri(10) }); }
  if (r < 0.60) {
    const n = pick([0, 1, 1, 2, 5, 17, 60, 255, 256, 257, 300]);
    const tx = [0x02, ...addr3(ad), ...Array.from({ length: n }, () => ri(256))];
    if (ad < BYTES) dirty(ad - (ad % 256), ad - (ad % 256) + 255);
    return t(tx, { partial: rnd() < 0.1 ? 1 + ri(7) : 0 });
  }
  if (r < 0.74) {
    const [op, size] = pick([[0x81, 256], [0x20, 4096], [0x20, 4096], [0x52, 32768], [0xd8, 65536]]);
    const tx = rnd() < 0.1 ? [op, ...addr3(ad).slice(0, 1 + ri(2))] : rnd() < 0.05 ? [op, ...addr3(ad), 0] : [op, ...addr3(ad)];
    if (ad < BYTES) { const lo = ad - (ad % size); dirty(lo, lo + size - 1); }
    return t(tx, { partial: rnd() < 0.05 ? 1 + ri(7) : 0 });
  }
  if (r < 0.78) { const tx = rnd() < 0.1 ? [pick([0x60, 0xc7]), 0] : [pick([0x60, 0xc7])]; dirty(0, 0xfffff); return t(tx, { partial: rnd() < 0.05 ? 1 + ri(7) : 0 }); }
  if (r < 0.90) {
    const kind = rnd();
    const lo = (ri(32) << 2) | (rnd() < 0.1 ? 0x80 : 0);
    const hi = (rnd() < 0.3 ? 0x40 : 0) | (rnd() < 0.05 ? 0x03 : 0) | (rnd() < 0.03 ? 0x38 : 0) | (rnd() < 0.05 ? 0x02 : 0);
    const tx = kind < 0.3 ? [0x01, lo] : kind < 0.93 ? [0x01, lo, hi] : kind < 0.97 ? [0x01] : [0x01, lo, hi, 0];
    return t(tx, { partial: rnd() < 0.04 ? 1 + ri(7) : 0 });
  }
  if (r < 0.95) return t([pick(NOTMOD), ...Array.from({ length: ri(4) }, () => ri(256))]);
  if (r < 0.98) return power();
  return t([0x01, 0x00, 0x00]);
}
for (const profile of ["puya", "uc25hq80"]) {
  for (const timing of ["typical", "maximum"]) {
    for (const image of ["ff", "pat"]) {
      for (let k = 0; k < 6; k++) {
        seed = 0x1234567 + k * 7919 + (profile === "puya" ? 1 : 3) * 104729 + (timing === "typical" ? 0 : 55) + (image === "ff" ? 0 : 17);
        const wp = rnd() < 0.5;
        begin(`rand-${profile}-${timing}-${image}-${k}`, profile, timing, { wp, image, hz: k % 2 ? 24_000_000 : 100_000_000 });
        for (let i = 0; i < 260; i++) {
          // time: none, a little, to just before/at/after the end of the running cycle, or far
          const mode = rnd();
          const e = sc.chip.busyUntil();
          let adv = 0;
          if (mode < 0.3) adv = 0; else if (mode < 0.5) adv = 1 + ri(600); else if (e !== null && mode < 0.8) adv = Math.max(0, e - sc.clock.now() + pick([-1, 0, 0, 1])); else if (mode < 0.9) adv = 25_000; else adv = ri(30);
          if (adv) { sc.clock.advance(adv); lines.push(`T ${adv} 0 0 - => ADV`); }
          randOp(profile);
          if (rnd() < 0.4) { t([pick([0x05, 0x35])], { read: 1 }); }
          if (rnd() < 0.15) wip();
          if (rnd() < 0.2) flushDirty();
        }
        end();
      }
    }
  }
}

// ------------------------------------------------------------------ 4Bh Read Unique ID scenarios (opt-in: --with-ruid)
if (process.argv.includes("--with-ruid")) {
  const UIDHEX = "13579bdf02468acef1e2d3c4b5a69788";
  const RUID = [0x4b, 0, 0, 0, 0];
  for (const profile of ["puya", "uc25hq80"]) {
    begin(`ruid-${profile}`, profile, "typical", { uid: UIDHEX, image: "pat" });
    for (const n of [16, 1, 2, 8, 15, 0, 16]) t(RUID, { read: n });
    t([0x4b, 0xff, 0xaa, 0x55, 0x12], { read: 16 }); t([0x4b, 0, 0, 0, 0xa5], { read: 16 }); t([0x4b, 1, 0, 0, 0], { read: 4 }); t([0x4b, 0, 0x80, 0, 0], { read: 4 }); t([0x4b, 0, 0, 0xff, 0], { read: 4 });
    // only shapes the byte stream can express: with CS# rising before the fourth dummy byte, any byte after it would be a dummy slot, not a data byte
    for (const [tx, r] of [[[0x4b], 1], [[0x4b, 0], 1], [[0x4b, 0, 0], 0], [[0x4b, 0, 0, 0], 0]]) t(tx, { read: r });
    for (const n of [17, 32, 100]) t(RUID, { read: n });
    wren(); t(RUID, { read: 16 }); rdsr(); t([0x04]); rdsr();
    for (const tx of [[0x02, 0x01, 0x00, 0x00, 0x0f], [0x20, 0x02, 0x00, 0x00], [0x01, 0x04, 0x00]]) { wren(); t(tx); t(RUID, { read: 16 }); t(RUID, { read: 16, adv: 1 }); idle(); t(RUID, { read: 16 }); rdsr(); }
    wren(); t([0x60]); idle(); t(RUID, { read: 16 }); power(); t(RUID, { read: 16 }); rdsr(); flushDirty(); end();
    begin(`ruid-nouid-${profile}`, profile, "maximum", { image: "ff" });
    t(RUID, { read: 16 }); t(RUID, { read: 3 }); t([0x4b], { read: 0 }); t(RUID, { read: 17 }); rdsr(); end();
  }
}

writeFileSync(process.argv[2], lines.join("\n") + "\n");
console.log(`wrote ${process.argv[2]}: ${lines.length} lines`);
console.log(JSON.stringify(stats, null, 1));
