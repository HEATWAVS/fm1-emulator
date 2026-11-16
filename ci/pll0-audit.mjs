#!/usr/bin/env node
// The evidence behind site/emulator/pll0-firmware.json (Component 8, Stage 6): which bundled packages start their audio engine on the unified engine (PLL0 boot state, upstream fm1-emu d2bcc33)
// and never start it on the shipped Default engine. Packages are matched by SHA-256, never by name.
//
//   node ci/pll0-audit.mjs --check     re-measure all bundled packages on both engines and fail unless the committed file says exactly what was measured (about 6 minutes, 10 worker threads)
//   node ci/pll0-audit.mjs --write     regenerate the committed file from a fresh measurement
//
// The measure: the frames fm1_render reports as real audio (the firmware's I2S DMA delivered them), summed over 689 renders of 128 frames (2 s of audio time) with the page's own loop (interpreter, USB plugged, the
// original flash model, 100 MHz). It is "the audio engine started", not "sound was heard": a firmware can start its audio engine and stay silent until it is played.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const EMU = resolve(ROOT, "site/emulator");
export const DATA_PATH = resolve(EMU, "pll0-firmware.json");
const QUANTUM = 128, RATE = 44100, SECONDS = 2, QUANTA = Math.ceil((SECONDS * RATE) / QUANTUM), REQUESTED = QUANTA * QUANTUM;
const sha = (b) => createHash("sha256").update(b).digest("hex");

if (!isMainThread) {
  const { loadEngine } = await import(new URL("./machine/engine.mjs", import.meta.url));
  const engines = { shipped: await loadEngine(), unified: await loadEngine({ wasmPath: resolve(EMU, "fm1_web_unified.wasm"), name: "unified" }) };
  for (const e of workerData.entries) {
    const pkg = new Uint8Array(readFileSync(resolve(EMU, e.package))), row = { id: e.id };
    for (const [name, eng] of Object.entries(engines)) {
      try {
        const x = eng.instantiate();
        x.fm1_jit(0, 16); x.fm1_ahead?.(1024);
        const p = x.fm1_alloc(pkg.length); new Uint8Array(x.memory.buffer, p, pkg.length).set(pkg);
        if (x.fm1_boot_fwsc(p, pkg.length, 0, 0, 100) !== 0) { row[name] = { error: "package rejected" }; continue; }
        eng.applyPackageResources(x, pkg.buffer.slice(pkg.byteOffset, pkg.byteOffset + pkg.byteLength));
        x.fm1_usb_plug?.();
        let real = 0;
        for (let i = 0; i < QUANTA; i++) { if (x.fm1_halted()) break; real += x.fm1_render(QUANTUM, 4_000_000); }
        row[name] = { real };
      } catch (err) { row[name] = { error: String(err).slice(0, 120) }; }
    }
    parentPort.postMessage(row);
  }
} else {
  const mode = process.argv.includes("--write") ? "write" : process.argv.includes("--check") ? "check" : null;
  if (!mode) { console.error("usage: node ci/pll0-audit.mjs --check | --write"); process.exit(2); }
  const catalogue = JSON.parse(readFileSync(resolve(EMU, "firmwares.json"), "utf8")).firmwares.filter((e) => e.package);
  const N = 10, shards = Array.from({ length: N }, () => []);
  catalogue.forEach((e, i) => shards[i % N].push({ id: e.id, package: e.package }));
  const rows = [];
  await Promise.all(shards.map((s) => new Promise((done) => { const w = new Worker(new URL(import.meta.url), { workerData: { entries: s } }); w.on("message", (r) => rows.push(r)); w.on("error", (e) => { console.error("worker error", String(e)); done(); }); w.on("exit", done); })));
  const bad = rows.filter((r) => r.shipped?.error || r.unified?.error);
  if (bad.length || rows.length !== catalogue.length) { console.error(`measurement incomplete: ${rows.length}/${catalogue.length} packages, ${bad.length} errors`); process.exit(1); }
  const started = (x) => x.real > 0;
  // the packages whose audio engine starts on the unified engine and not on the shipped one (the PLL0 effect); the reverse never happened
  const reverse = rows.filter((r) => started(r.shipped) && !started(r.unified)).map((r) => r.id);
  const affected = rows.filter((r) => !started(r.shipped) && started(r.unified)).sort((a, b) => a.id.localeCompare(b.id));
  const unequal = rows.filter((r) => !affected.includes(r) && r.shipped.real !== r.unified.real).map((r) => r.id);
  const entries = affected.map((r) => {
    const e = catalogue.find((c) => c.id === r.id), hash = sha(readFileSync(resolve(EMU, e.package)));
    if (hash !== e.sha256) { console.error(`${e.id}: package hash ${hash} differs from the catalogue's ${e.sha256}`); process.exit(1); }
    return { id: e.id, name: e.name, version: String(e.version ?? ""), sha256: hash, shippedRealFrames: r.shipped.real, unifiedRealFrames: r.unified.real };
  });
  const data = {
    note: "Bundled packages whose audio engine starts on the unified engine (PLL0 boot state, upstream fm1-emu d2bcc33) and never starts on the shipped Default engine. Matched by package SHA-256 only, never by name. Evidence-based like ci/boot-quarantine.json: verify or regenerate with node ci/pll0-audit.mjs --check / --write. Starting the audio engine is not the same as producing audible sound.",
    audited: "2026-11-16",
    unifiedEngineSha256: createHash("sha256").update(readFileSync(resolve(EMU, "fm1_web_unified.wasm"))).digest("hex"),
    measure: `frames fm1_render reports as real audio, summed over ${QUANTA} renders of ${QUANTUM} frames (${REQUESTED} requested, ${SECONDS} s of audio time); interpreter, USB plugged, original flash model, 100 MHz; shippedRealFrames and unifiedRealFrames are those sums`,
    packagesAudited: rows.length,
    requestedFrames: REQUESTED,
    entries,
  };
  console.log(`${rows.length} packages: ${entries.length} start their audio engine only on the unified engine (${entries.map((e) => e.id).join(", ")}); the reverse: ${reverse.length ? reverse.join(", ") : "none"}; other packages with different frame counts: ${unequal.length ? unequal.join(", ") : "none"}`);
  if (reverse.length || unequal.length) { console.error("unexpected: the engines differ in audio frames for packages outside the list; the list is not the whole difference"); if (mode === "check") process.exit(1); }
  if (mode === "write") { writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + "\n"); console.log(`written ${DATA_PATH}`); }
  else {
    const committed = JSON.parse(readFileSync(DATA_PATH, "utf8"));
    const same = JSON.stringify(committed.entries) === JSON.stringify(entries) && committed.unifiedEngineSha256 === data.unifiedEngineSha256 && committed.packagesAudited === data.packagesAudited;
    console.log(same ? "pll0-firmware.json matches the measurement" : "pll0-firmware.json DOES NOT match the measurement (regenerate with --write and review the difference)");
    process.exit(same ? 0 : 1);
  }
}
