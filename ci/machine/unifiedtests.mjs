// Tests of the unified engine (Component 8, Stage 2): the chip-profile engine plus the USB exports, the USB audio-in host and the XIP-tail switch, with usb.rs taken
// whole from upstream commit 9acb2df (MIT header). The binary is COMMITTED as site/emulator/fm1_web_unified.wasm (ci/engine/build.mjs --unified rebuilds it), so
// unlike the chip-profile engine these tests never need a build and are never SKIPPED.
//
// Quick tier (`npm test`): the pin (patch, usb.rs source, exports), the committed binary's identity (hash for the pinned toolchain, exact exports and imports), the
// shipped engine untouched, and the licence notices (the upstream author's MIT notice verbatim, the project's own LICENSE unchanged).
// Full tier: what the Stage 1 validation measured, as a regression guard on the committed binary: with the original flash model it behaves as the shipped engine (the
// Default) on a set of firmware, USB descriptor included; the USB audio-in queue traces; the XIP-tail switch; the chip profiles selected on it. These are not a
// replacement for the Stage 1 lockstep over all 277 packages (documented in docs/dev/ARCHITECTURE.md), which is a manual measurement.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { Fm1Machine } from "./machine.mjs";
import { loadEngine, EMULATOR_DIR } from "./engine.mjs";
import { catalogPackage } from "./firmware-survey.mjs";
import { PIN, UNIFIED, verifyUnifiedFile } from "../engine/verify.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const sha = (b) => createHash("sha256").update(b).digest("hex");
export const UNIFIED_WASM = resolve(EMULATOR_DIR, "fm1_web_unified.wasm");
export const SHIPPED_WASM_SHA256 = "cdf039104a7445b01ae8de062cc67a2967ea39a8abc2d268e44beb0825370278";
/** The project's own LICENSE ("Copyright (c) 2026 briksquared"): kept as it was; a change to it is a decision, not a side effect. */
export const ROOT_LICENSE_SHA256 = "33fcf9730aa326f50c8bbee45f48abeff28d667b86f3e106fe71ef2f314c6597";
/** The upstream author's notice, byte for byte (fm1-emu LICENSE at v0.3.0 and every later version checked). */
export const UPSTREAM_NOTICE_SHA256 = "de303af17a9bed9ac5ab105f33ef72b3aa5c658d30132d13609db45f7fc7f257";
const lf = (s) => s.replace(/\r\n/g, "\n");

export function registerUnifiedQuickTests(testQuick) {
  testQuick("unified engine pin: the patch (incl. the PLL0 boot state of upstream d2bcc33), the usb.rs source and the export list are consistent", () => {
    const patch = readFileSync(resolve(ROOT, "ci/engine", UNIFIED.patch.file));
    assert.equal(sha(patch), UNIFIED.patch.sha256, "ci/engine/unified-engine.patch is the pinned one (edit it, rebuild with build.mjs --unified, then re-pin)");
    assert.deepEqual([...patch.toString("utf8").matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]),
      ["crates/fm1-soc/src/fwsc.rs", "crates/fm1-soc/src/lib.rs", "crates/fm1-soc/src/usb.rs", "crates/fm1-web/src/lib.rs"], "the unified patch touches exactly these files, and never the pinned usb.rs header");
    const text = patch.toString("utf8");
    for (const s of ["const PLL0_CON0: u32 = 0x119a0;", "const PLL0_CON1: u32 = 0x119a4;", "const PLL0_BOOT: (u32, u32) = (0x4540_0203, 0x3f50_3026);", "d2bcc331d039855060dcef78c3bcaebb193b213a", "soc.sfr_set(PLL0_CON0, PLL0_BOOT.0);", "soc.sfr_set(PLL0_CON1, PLL0_BOOT.1);", "fn pll0_reads_as_the_bootloader_left_it()"]) assert.ok(text.includes(s), `the PLL0 hunk carries: ${s}`);
    assert.equal((text.match(/^\+.*PLL0/gm) || []).length >= 6, true, "the PLL0 additions are in the patch");
    assert.ok(!/^[-+]\/\/! SPDX/m.test(patch.toString("utf8")), "usb.rs's SPDX line comes from the upstream 9acb2df file, not from this patch");
    assert.deepEqual(UNIFIED.usbSource, { path: "crates/fm1-soc/src/usb.rs", commit: "9acb2df464c7d91347f0c114423d955d909f4448", blob: "43af499a63d5d8d00169f38fc53df8ebe9900fae", sha256: "9d62720b52a0d643d19d076567cfa416" });
    assert.deepEqual([...UNIFIED.expectedExports].sort(), [...new Set([...PIN.expectedExports, ...UNIFIED.addedExports])].sort(), "the unified exports are the chip engine's plus the added ones");
    assert.deepEqual(UNIFIED.addedExports, ["fm1_audio_in", "fm1_audio_in_buf", "fm1_audio_pending", "fm1_has_audio_in", "fm1_has_usr", "fm1_usb_conf", "fm1_usb_conf_len", "fm1_usb_plug", "fm1_xip_tail"]);
    assert.equal(UNIFIED.expectedExports.length, 82);
    assert.ok(!UNIFIED.expectedExports.includes("fm1_skin"), "the panel drawing stays on the shipped engine's own instance");
  });

  testQuick("unified engine: the committed site/emulator/fm1_web_unified.wasm is the pinned build (hash for the pinned toolchain, exact exports and imports)", () => {
    const rustc = Object.keys(UNIFIED.toolchains)[0];
    const v = verifyUnifiedFile(UNIFIED_WASM, { rustc });
    assert.equal(v.hash, "match", `sha256 ${v.sha256}`);
    assert.equal(v.sha256, "ba1ba889045a847e5ec7c18d739fd211d840c35eea6e0433e93481157f13153b", "the Stage 4 unified engine: the Stage 2 engine (58bacde6…, Stage 1 validated) plus the PLL0 boot state");
    assert.equal(v.bytes, UNIFIED.toolchains[rustc].wasmBytes);
    assert.ok(v.exportsOk, `missing ${v.missing} unexpected ${v.unexpected}`);
    assert.ok(v.importsOk, v.imports.join());
  });

  testQuick("the shipped site/emulator/fm1_web.wasm is untouched (it stays the Default engine)", () => {
    assert.equal(sha(readFileSync(resolve(EMULATOR_DIR, "fm1_web.wasm"))), SHIPPED_WASM_SHA256);
  });

  testQuick("licence: the upstream author's MIT notice is reproduced verbatim, referenced from NOTICE.md, and the project's own LICENSE is unchanged", () => {
    const notice = readFileSync(resolve(ROOT, "LICENSES/MIT-fm1-emu.txt"));
    assert.equal(sha(Buffer.from(lf(notice.toString("utf8")))), UPSTREAM_NOTICE_SHA256, "LICENSES/MIT-fm1-emu.txt is fm1-emu's LICENSE, byte for byte");
    assert.match(notice.toString("utf8"), /^Copyright \(c\) 2026 Joakim Eriksson$/m);
    assert.match(notice.toString("utf8"), /The above copyright notice and this permission notice shall be included in all\s+copies or substantial portions of the Software\./);
    const n = lf(readFileSync(resolve(ROOT, "NOTICE.md"), "utf8"));
    for (const s of ["LICENSES/MIT-fm1-emu.txt", "631b790b191e87ea8b796d351cfe7e61ab366794", "9acb2df464c7d91347f0c114423d955d909f4448", "fm1_web_unified.wasm"]) assert.ok(n.includes(s), s);
    assert.equal(sha(Buffer.from(lf(readFileSync(resolve(ROOT, "LICENSE"), "utf8")))), ROOT_LICENSE_SHA256, "the project's root LICENSE keeps its own copyright line");
    assert.ok(JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).build.files.includes("LICENSES/**/*"), "LICENSES/ ships with the application");
  });
}

const FIRMWARE = ["felucca", "zp12", "dx747", "picovave"];
const obsOf = (engine, id, { seconds = 2, ...options } = {}) => {
  const m = Fm1Machine.boot(engine, catalogPackage(id), { usb: true, ...options });
  const rows = [];
  for (let s = 0; s < seconds; s++) { m.run(1000); rows.push(m.observe()); }
  const x = m.x, len = x.fm1_usb_conf_len ? x.fm1_usb_conf_len() : -1;
  return { rows, flashHash: m.flashHash(), usbConf: len > 0 ? Buffer.from(new Uint8Array(x.memory.buffer, x.fm1_usb_conf(), len)).toString("hex") : String(len), hasUsr: x.fm1_has_usr ? x.fm1_has_usr() : -1, halted: x.fm1_halted() };
};
/** Compare two observations over what BOTH have: the unified and chip-profile engines add powerCut / flashWip to an observation row and the chip engine has no USB descriptor to compare. */
const projected = (a, keys) => ({ ...a, rows: a.rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k]]))) });
const sameObs = (a, b, msg) => {
  const keys = Object.keys(a.rows[0]).filter((k) => k in b.rows[0]);
  const drop = (o) => { const c = { ...o }; if (a.usbConf === "-1" || b.usbConf === "-1") { delete c.usbConf; delete c.hasUsr; } return c; };
  assert.deepEqual(drop(projected(b, keys)), drop(projected(a, keys)), msg);
};
const feed = (x, frames, v) => {
  const s = new Float32Array(2 * frames).fill(v);
  for (let off = 0; off < s.length; off += 8192) { const n = Math.min(8192, s.length - off); new Float32Array(x.memory.buffer, x.fm1_audio_in_buf(), 8192).set(s.subarray(off, off + n), 0); x.fm1_audio_in(n >> 1); }
};
const pendingTrace = (engine, id) => {
  const m = Fm1Machine.boot(engine, catalogPackage(id), { usb: true });
  m.run(2300);
  const hasIn = m.x.fm1_has_audio_in();
  feed(m.x, 44100 * 3, 0.25);
  const tr = [m.x.fm1_audio_pending()];
  for (let i = 0; i < 120; i++) { m.run(3); tr.push(m.x.fm1_audio_pending()); }
  return { hasIn, tr };
};

export function registerUnifiedFullTests(test, { engine }) {
  let unified;
  const U = async () => (unified ??= await loadEngine({ wasmPath: UNIFIED_WASM, name: "fm1_web_unified.wasm" }));

  test("unified engine: capabilities (chip profiles, fault injection and the USB host together; the shipped engine has the host only)", async () => {
    const u = await U();
    for (const k of ["boot", "selectFlashChip", "flashWip", "flashEvents", "flashNv", "flashUid", "faultInjection", "usbHost", "audioIn", "xipTailSwitch"]) assert.equal(u.capabilities[k], true, k);
    assert.equal(engine.capabilities.usbHost, true);
    assert.equal(engine.capabilities.audioIn, true, "the shipped engine takes USB audio in too");
    assert.equal(engine.capabilities.selectFlashChip, false);
    assert.equal(engine.capabilities.xipTailSwitch, false);
  });

  test("unified engine, original flash model, USB plugged: the same display, audio, clock, flash, USB descriptor and USB-store flag as the shipped engine (4 firmware, 2 s each, interpreter)", async () => {
    const u = await U();
    for (const id of FIRMWARE) sameObs(obsOf(engine, id), obsOf(u, id), id);
  });

  test("unified engine, PLL0 boot state (Component 8 Stage 4): the four firmware upstream named start their audio on it and not on the shipped engine; unaffected firmware are unchanged", async () => {
    const u = await U();
    for (const id of ["amb", "ctl", "choppah", "polly"]) {
      const a = obsOf(engine, id, { seconds: 1 }), b = obsOf(u, id, { seconds: 1 });
      assert.ok(a.rows[0].emulatedMs > 5000, `${id}: the shipped engine fast-forwards (no audio frames): ${a.rows[0].emulatedMs} ms in 1 s`);
      assert.ok(b.rows[0].emulatedMs < 2000, `${id}: the unified engine's clock follows the audio: ${b.rows[0].emulatedMs} ms in 1 s`);
    }
    for (const id of ["amb", "mutable", "sidou"]) {
      assert.equal(obsOf(engine, id, { seconds: 1 }).rows[0].audioRms, 0, `${id} is silent on the shipped engine`);
      assert.ok(obsOf(u, id, { seconds: 1 }).rows[0].audioRms > 0.001, `${id} is audible on the unified engine`);
    }
    sameObs(obsOf(engine, "felucca", { seconds: 1 }), obsOf(u, "felucca", { seconds: 1 }), "felucca does not read PLL0");
  });

  test("unified engine, original flash model, JIT on: the same as the shipped engine (2 firmware, 2 s each)", async () => {
    const u = await U();
    for (const id of ["felucca", "picovave"]) sameObs(obsOf(engine, id, { seconds: 2, jit: true }), obsOf(u, id, { seconds: 2, jit: true }), id);
  });

  test("unified engine: the USB audio-in queue behaves as the shipped engine's (zp12 drains, melodee stalls at one packet, optimist has none; 121 points each)", async () => {
    const u = await U();
    const expect = { zp12: { hasIn: 1, end: 0 }, melodee: { hasIn: 1, end: 147192 }, optimist: { hasIn: 0, end: 147456 } };
    for (const [id, want] of Object.entries(expect)) {
      const a = pendingTrace(engine, id), b = pendingTrace(u, id);
      assert.deepEqual(b, a, `${id}: the same trace on both engines`);
      assert.equal(b.hasIn, want.hasIn, id);
      assert.equal(b.tr.at(-1), want.end, id);
    }
  });

  test("unified engine: the XIP-tail switch (mode 0, the default, leaves the window as the shipped engine does; mode 1 decrypts the tail as upstream v0.3.0 does; dx747 shows it in its flash)", async () => {
    const u = await U(), mode1 = { ...u, instantiate: () => { const x = u.instantiate(); x.fm1_xip_tail(1); return x; } };
    const shipped = obsOf(engine, "dx747", { usb: false }), m0 = obsOf(u, "dx747", { usb: false }), m1 = obsOf(mode1, "dx747", { usb: false });
    assert.equal(m0.flashHash, shipped.flashHash, "mode 0 = the shipped engine");
    assert.notEqual(m1.flashHash, shipped.flashHash, "mode 1 = v0.3.0: a firmware that reads the tail writes a different record");
    sameObs(obsOf(u, "felucca", { usb: false }), obsOf(mode1, "felucca", { usb: false }), "a firmware that does not read the tail does not notice");
  });

  test("unified engine: a chip profile selected on it takes effect (quadro-fm1 saves its settings on Puya, not on UC25HQ80; WIP exists) and the default stays the original model", async () => {
    const u = await U(), pkg = catalogPackage("quadro-fm1");
    const run = (opts) => { const m = Fm1Machine.boot(u, pkg, { usb: true, ...opts }); m.run(4000); return { m, writes: m.changedSectors().length }; };
    const legacy = run({}), puya = run({ flashChip: "puya" }), uc = run({ flashChip: "uc25hq80" });
    assert.equal(legacy.m.flashChipInfo, null);
    assert.deepEqual(puya.m.flashChipInfo.jedec, [0x85, 0x60, 0x14]);
    assert.deepEqual(uc.m.flashChipInfo.jedec, [0xb3, 0x60, 0x14]);
    assert.ok(puya.writes >= 0 && uc.writes >= 0);
    assert.equal(typeof puya.m.flashWip(), "boolean");
    assert.deepEqual(legacy.m.observe().halted, false);
  });
}

export function registerUnifiedAppTests(test) {
  test("application chip test modes (ci/chip-mode-tests.mjs --full): the page's own comparison code on the real shipped and unified engines, the saving rules, the report", () => {
    const r = spawnSync(process.execPath, [resolve(ROOT, "ci/chip-mode-tests.mjs"), "--full"], { encoding: "utf8", timeout: 300_000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /PASS: 13 chip mode tests \(full\)/);
  });
}

export function registerUnifiedLiveTests(testChip, { chipEngine }) {
  testChip("unified engine == the pinned chip-profile engine under both chip profiles, USB off (2 firmware, 2 s, interpreter; the unified engine in XIP-tail mode 1, which is v0.3.0's)", async () => {
    const u = await loadEngine({ wasmPath: UNIFIED_WASM, name: "fm1_web_unified.wasm" });
    const mode1 = { ...u, instantiate: () => { const x = u.instantiate(); x.fm1_xip_tail(1); return x; } };
    for (const id of ["felucca", "quadro-fm1"]) {
      for (const cfg of [{ flashChip: "puya", flashTiming: "typical" }, { flashChip: "uc25hq80", flashTiming: "maximum" }]) {
        sameObs(obsOf(chipEngine, id, { seconds: 2, usb: false, ...cfg }), obsOf(mode1, id, { seconds: 2, usb: false, ...cfg }), `${id} ${cfg.flashChip}`);
      }
    }
  });
}
