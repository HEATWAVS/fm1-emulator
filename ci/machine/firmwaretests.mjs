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

  testChip("firmware (live): quadro-fm1 under legacy / Puya / UC25HQ80: boots on all; saves on legacy and Puya, not on the UC25HQ80 ID; KNOWN LIMITATION: its stored bytes differ from legacy because 4Bh answers FF, not the original FM1- pattern", () => {
    const L = run("quadro-fm1", {}, 4000), P = run("quadro-fm1", { flashChip: "puya" }, 4000), U = run("quadro-fm1", { flashChip: "uc25hq80" }, 4000);
    for (const r of [L, P, U]) assert.equal(r.halted, false);
    assert.equal(L.writes, 3); assert.equal(P.writes, 3);
    assert.equal(U.writes, 0, "quadro-fm1 1.0 does not recognise B3 60 14 (its changelog adds the UC25HQ80 later): documented ID-dependent behaviour");
    assert.deepEqual(P.sectors, L.sectors, "the same sector is written");
    assert.deepEqual(P.events, { unspecified: 0, notModeled: 1, lastNotModeled: 0x4b }, "the one unmodelled command is Read Unique ID");
    assert.deepEqual(U.events, { unspecified: 0, notModeled: 0, lastNotModeled: 0 });
    assert.notEqual(P.flash, L.flash, "KNOWN LIMITATION (D42): firmware takes its 'no unique ID' path under a profile, so the stored bytes differ from the original model's. If 4Bh is ever modelled this test must be revisited");
    assert.equal(P.lcd, L.lcd, "the screen is the same");
  });

  testChip("firmware (live): fm1-field makes 3 flash changes (one sector) under the Puya profile only, right after reading the unique ID (4Bh answered FF = 'no unique ID'); legacy and UC25HQ80 write nothing", () => {
    const L = run("fm1-field", {}, 4000), P = run("fm1-field", { flashChip: "puya" }, 4000), U = run("fm1-field", { flashChip: "uc25hq80" }, 4000);
    assert.deepEqual([L.writes, P.writes, U.writes], [0, 3, 0]);
    assert.equal(P.events.lastNotModeled, 0x4b);
    assert.equal(P.lcd, L.lcd);
    for (const r of [L, P, U]) assert.equal(r.halted, false);
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
