#!/usr/bin/env node
// Self-test of the headless machine harness against the bundled engine and firmware.
//   node ci/machine/selftest.mjs
// Not part of `npm test` yet (that is a separate, deliberate step). About 40 seconds.
//
// Tests marked KNOWN LIMITATION record what this engine does NOT model. They pass while the
// limitation is real; if an engine ever starts modelling the thing, they fail and tell you the
// harness can now test it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEngine, EMULATOR_DIR } from "./engine.mjs";
import { Fm1Machine, BootError, corruptedSectors, requires } from "./machine.mjs";
import { watch } from "./monitor.mjs";
import { FLASH_SIZE, SECTOR, packRecords, unpackRecords, parseCorruption, corruptSectors, diffSectors } from "./flash.mjs";

const engine = await loadEngine();
const fw = (name) => new Uint8Array(readFileSync(resolve(EMULATOR_DIR, "../fw", name)));
const FELUCCA = fw("felucca-1.8.2-beta.fwsc");
const AURORA = new Uint8Array(readFileSync(resolve(EMULATOR_DIR, "../archive/AURORA/aurora-0.9.1.fwsc")));
const MELODEE = fw("melodee-1.6.1.fwsc");
const hex = (n) => `0x${n.toString(16)}`;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("engine capabilities are detected from its exports", () => {
  const c = engine.capabilities;
  for (const k of ["boot", "flashRead", "flashBase", "flashRestore", "flashRevision", "input", "lcd"]) assert.ok(c[k], `${k}`);
  // Not exposed by this engine: a test needing them must be skipped loudly, never passed.
  assert.equal(c.selectFlashId, false);
  assert.equal(c.flashFaultInjection, false);
  assert.equal(c.resetCounter, false);
  assert.throws(() => requires(engine, "selectFlashId"), /lacks: selectFlashId/);
});

for (const [name, pkg] of [["Felucca", FELUCCA], ["AURORA", AURORA], ["Melodee", MELODEE]]) {
  test(`${name} boots headless and shows a screen`, () => {
    const r = watch(Fm1Machine.boot(engine, pkg), { seconds: 3 });
    assert.equal(r.verdict, "booted", JSON.stringify({ ...r, samples: undefined }));
    assert.ok(r.final.lcdColours >= 2);
  });
}

test("a run is repeatable: same screen, same flash, same clock", () => {
  const run = () => { const m = Fm1Machine.boot(engine, FELUCCA); const r = watch(m, { seconds: 2 }); return [r.final.lcdHash, m.flashHash(), r.emulatedMs]; };
  assert.deepEqual(run(), run());
});

test("flash reads back: 1 MiB, populated, equal to the package base before the firmware runs", () => {
  const m = Fm1Machine.boot(engine, FELUCCA);
  const flash = m.flash();
  assert.equal(flash.length, FLASH_SIZE);
  assert.ok(flash.some((b) => b !== 0xff), "flash holds the firmware");
  assert.deepEqual(m.changedSectors(), []);
});

test("an injected sector reaches the machine and is reported as changed", () => {
  const sectors = corruptedSectors(engine, FELUCCA, ["zero:0x20000"]);
  assert.deepEqual(sectors.map((s) => s.at), [0x20000]);
  const m = Fm1Machine.boot(engine, FELUCCA, { sectors });
  assert.ok(m.flash().subarray(0x20000, 0x21000).every((b) => b === 0));
  assert.deepEqual(m.changedSectors().map((s) => s.at), [0x20000]);
});

test("corrupting the start of the app area blanks the screen (no crash)", () => {
  const sectors = corruptedSectors(engine, FELUCCA, ["zero:0x4000"]);
  assert.equal(watch(Fm1Machine.boot(engine, FELUCCA, { sectors }), { seconds: 2 }).verdict, "blank");
});

test("erasing a code sector halts the CPU", () => {
  const sectors = corruptedSectors(engine, FELUCCA, ["erase:0x20000"]);
  const r = watch(Fm1Machine.boot(engine, FELUCCA, { sectors }), { seconds: 3 });
  assert.equal(r.verdict, "crashed");
  assert.ok(r.haltedAtMs > 0);
});

test("seeded bit flips are deterministic and change flash", () => {
  const flash = Fm1Machine.boot(engine, FELUCCA).flash();
  const a = corruptSectors(flash, ["flip:0x20000:4096:8:7"]), b = corruptSectors(flash, ["flip:0x20000:4096:8:7"]);
  assert.deepEqual(a, b);
  assert.equal(a.length, 1);
  assert.notDeepEqual(a[0].data, flash.slice(0x20000, 0x21000));
  assert.notDeepEqual(corruptSectors(flash, ["flip:0x20000:4096:8:8"]), a, "another seed flips other bits");
});

test("power cycle carries flash over; corruption while 'off' is applied", () => {
  const sectors = corruptedSectors(engine, FELUCCA, ["zero:0x20000"]);
  const first = Fm1Machine.boot(engine, FELUCCA, { sectors });
  const again = first.powerCycle();
  assert.equal(again.flashHash(), first.flashHash());
  assert.deepEqual(again.changedSectors().map((s) => s.at), [0x20000]);
  const worse = first.powerCycle({ corrupt: ["zero:0x30000"] });
  assert.deepEqual(worse.changedSectors().map((s) => s.at), [0x20000, 0x30000]);
});

test("KNOWN LIMITATION: the boot-area sector (0x0) is not used, so corrupting it changes nothing", () => {
  const base = watch(Fm1Machine.boot(engine, FELUCCA), { seconds: 2 });
  const sectors = corruptedSectors(engine, FELUCCA, ["zero:0x0"]);
  const hit = watch(Fm1Machine.boot(engine, FELUCCA, { sectors }), { seconds: 2 });
  assert.equal(hit.verdict, "booted");
  assert.equal(hit.final.lcdHash, base.final.lcdHash, "a bootloader-aware engine would differ here: bricking can now be tested");
});

test("KNOWN LIMITATION: the chip-key sector (0xFF000) is blank and unused", () => {
  const m = Fm1Machine.boot(engine, FELUCCA);
  assert.ok(m.flash().subarray(0xff000, 0x100000).every((b) => b === 0xff), "a real unit keeps its key here");
  const base = watch(m, { seconds: 2 });
  const sectors = corruptedSectors(engine, FELUCCA, ["zero:0xff000"]);
  const hit = watch(Fm1Machine.boot(engine, FELUCCA, { sectors }), { seconds: 2 });
  assert.equal(hit.final.lcdHash, base.final.lcdHash);
});

test("flash record files round-trip and reject malformed input", () => {
  const sectors = [{ at: 0x5000, data: new Uint8Array(SECTOR).fill(7) }, { at: 0x1000, data: new Uint8Array(SECTOR).fill(9) }];
  assert.deepEqual(unpackRecords(packRecords(sectors)), sectors);
  assert.throws(() => unpackRecords(new Uint8Array(10)), /whole number/);
  assert.throws(() => packRecords([{ at: 5, data: new Uint8Array(SECTOR) }]), /bad sector offset/);
  assert.throws(() => packRecords([sectors[0], sectors[0]]), /twice/);
  assert.deepEqual(diffSectors(new Uint8Array(FLASH_SIZE), new Uint8Array(FLASH_SIZE)), []);
});

test("corruption specs are validated", () => {
  assert.deepEqual(parseCorruption("zero:0x1000"), { kind: "zero", at: 0x1000, len: SECTOR });
  assert.throws(() => parseCorruption("melt:0"), /unknown corruption/);
  assert.throws(() => parseCorruption("flip:1:2"), /usage flip/);
  assert.throws(() => corruptSectors(new Uint8Array(FLASH_SIZE), ["zero:0x200000"]), /outside the 1 MiB/);
});

test("a file that is not a firmware package is rejected, not booted", () => {
  assert.throws(() => Fm1Machine.boot(engine, new Uint8Array(5000).fill(1)), (e) => e instanceof BootError && e.code === "package-rejected");
});

let failed = 0;
for (const { name, fn } of tests) {
  const t0 = performance.now();
  try {
    await fn();
    console.log(`ok   ${name}  (${Math.round(performance.now() - t0)} ms)`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n     ${String(error.stack ?? error).split("\n").slice(0, 6).join("\n     ")}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed — engine ${engine.name} sha256 ${engine.wasmSha256.slice(0, 16)}…`);
process.exit(failed ? 1 : 0);
