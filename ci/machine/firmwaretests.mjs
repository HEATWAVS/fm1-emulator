// Firmware behaviour under the flash-chip profiles (Component 4, Stage C4): tests that pin the findings of ci/machine/firmware-survey.mjs
// for the firmware where the profiles visibly differ from the original model. Full tier; needs the chip-profile engine (SKIPPED without it).
// Each test says WHY the behaviour is what it is: documented chip behaviour, firmware reacting to the JEDEC ID, or a known limitation of the model.
import assert from "node:assert/strict";
import { Fm1Machine } from "./machine.mjs";

export function registerFirmwareTests(testChip, { chipEngine, catalogPkg }) {
  const run = (id, options, ms) => {
    const m = Fm1Machine.boot(chipEngine, catalogPkg(id), { usb: false, ...options });
    m.run(ms);
    const o = m.observe();
    return { m, flash: m.flashHash(), lcd: o.lcdHash, writes: o.flashRevision, halted: o.halted, events: m.flashChipInfo ? m.flashEvents() : null, sectors: m.changedSectors().map((s) => s.at) };
  };

  // The 4Bh unique-ID fixtures below are TEST FIXTURES, not device IDs: the legacy model's FM1- pattern (to compare against legacy), an arbitrary value, and
  // all-00 / all-FF (a part that "does not answer": fm1-base's wifi.c treats an ID of identical bytes as none).
  const PATTERN = "464d312d".repeat(4), OTHER = "13579bdf02468acef1e2d3c4b5a69788";
  testChip("firmware (live): quadro-fm1 under legacy / Puya / UC25HQ80: boots on all; saves on legacy and Puya, not on the UC25HQ80 ID; its stored bytes follow the unique ID it reads (4Bh)", () => {
    const L = run("quadro-fm1", {}, 4000), P = run("quadro-fm1", { flashChip: "puya" }, 4000), U = run("quadro-fm1", { flashChip: "uc25hq80" }, 4000);
    const F = run("quadro-fm1", { flashChip: "puya", flashUid: PATTERN }, 4000), O = run("quadro-fm1", { flashChip: "puya", flashUid: OTHER }, 4000), O2 = run("quadro-fm1", { flashChip: "puya", flashUid: OTHER }, 4000);
    const Z = run("quadro-fm1", { flashChip: "puya", flashUid: "00".repeat(16) }, 4000), N = run("quadro-fm1", { flashChip: "puya", flashUid: "ff".repeat(16) }, 4000);
    for (const r of [L, P, U, F, O, Z, N]) assert.equal(r.halted, false);
    assert.equal(L.writes, 3); assert.equal(P.writes, 3);
    assert.equal(U.writes, 0, "quadro-fm1 1.0 does not recognise B3 60 14 (its changelog adds the UC25HQ80 later): documented ID-dependent behaviour");
    assert.deepEqual(P.sectors, L.sectors, "the same sector is written");
    assert.deepEqual(P.events, { unspecified: 0, notModeled: 0, lastNotModeled: 0 }, "4Bh is modelled now: no unmodelled or unspecified command");
    assert.equal(P.m.flashUidUnknownReads(), 1, "without a fixture the one 4Bh read is answered FF and counted as unknown");
    assert.equal(U.m.flashUidUnknownReads(), 0);
    assert.notEqual(P.flash, L.flash, "KNOWN LIMITATION: with no unique ID configured the firmware takes its 'no unique ID' path, so its stored bytes differ from the original model's FM1- pattern (FF is not equivalent to FM1-)");
    assert.equal(F.flash, L.flash, "configured with the original model's pattern, the stored bytes are exactly legacy's");
    assert.equal(F.m.flashUidUnknownReads(), 0);
    assert.notEqual(O.flash, F.flash, "another ID gives other stored bytes");
    assert.notEqual(O.flash, P.flash);
    assert.equal(O2.flash, O.flash, "deterministic for a given ID");
    assert.equal(Z.flash, P.flash, "an ID of identical bytes (all 00) is treated as 'no unique ID', as the firmware source says");
    assert.equal(N.flash, P.flash, "likewise all FF");
    for (const r of [P, F, O]) assert.equal(r.lcd, L.lcd, "the screen is the same");
  });

  testChip("firmware (live): fm1-field makes 3 flash changes (one sector) under the Puya profile only when it finds no unique ID; with an ID configured it writes nothing, as legacy does", () => {
    const L = run("fm1-field", {}, 4000), P = run("fm1-field", { flashChip: "puya" }, 4000), U = run("fm1-field", { flashChip: "uc25hq80" }, 4000);
    const F = run("fm1-field", { flashChip: "puya", flashUid: PATTERN }, 4000), O = run("fm1-field", { flashChip: "puya", flashUid: OTHER }, 4000), Z = run("fm1-field", { flashChip: "puya", flashUid: "00".repeat(16) }, 4000);
    assert.deepEqual([L.writes, P.writes, U.writes], [0, 3, 0]);
    assert.equal(P.m.flashUidUnknownReads(), 1);
    assert.deepEqual(P.events, { unspecified: 0, notModeled: 0, lastNotModeled: 0 });
    assert.deepEqual([F.writes, O.writes], [0, 0], "with a unique ID the firmware writes nothing");
    assert.equal(F.flash, L.flash, "and the flash is exactly legacy's");
    assert.equal(Z.writes, 3, "an ID of identical bytes counts as none");
    assert.equal(P.lcd, L.lcd);
    for (const r of [L, P, U, F, O, Z]) assert.equal(r.halted, false);
  });

  testChip("firmware (live): coqui's first-run sample install takes real chip time under a profile (about 3.9 s Puya typical vs 2.5 s legacy by engine clock) and ends with byte-identical flash", () => {
    const at = (options, ms) => run("coqui", options, ms);
    const L = at({}, 5000), P = at({ flashChip: "puya" }, 5000), U = at({ flashChip: "uc25hq80" }, 5000);
    for (const r of [L, P, U]) { assert.equal(r.halted, false); assert.equal(r.writes, 1229, "the whole install ran"); }
    assert.equal(P.flash, L.flash, "Puya: identical flash content after the install");
    assert.equal(U.flash, L.flash, "UC25HQ80: identical flash content after the install");
    // while it runs, the install is visibly slower: at 1 s legacy has written far more than Puya
    const early = (options) => run("coqui", options, 1000).writes;
    assert.ok(early({}) > 1000 && early({ flashChip: "puya" }) < 500, "legacy writes instantly; the Puya profile paces writes with the datasheet cycle times");
  });

  testChip("firmware (live): firmware that never writes flash in 3 s (Felucca, elixir) boots identically (screen and flash) under legacy, Puya and UC25HQ80", () => {
    for (const id of ["felucca", "elixir"]) {
      const L = run(id, {}, 3000), P = run(id, { flashChip: "puya" }, 3000), U = run(id, { flashChip: "uc25hq80" }, 3000);
      for (const r of [L, P, U]) { assert.equal(r.halted, false, id); assert.equal(r.writes, 0, id); }
      assert.equal(P.lcd, L.lcd, id); assert.equal(U.lcd, L.lcd, id);
      assert.equal(P.flash, L.flash, id); assert.equal(U.flash, L.flash, id);
      assert.deepEqual(P.events, { unspecified: 0, notModeled: 0, lastNotModeled: 0 }, id);
    }
  });
}
