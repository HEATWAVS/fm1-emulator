#!/usr/bin/env node
// Firmware x flash-chip-profile survey (Component 4, Stage C4). Runs bundled firmware on the chip-profile engine under the original model
// ("legacy", the regression baseline), the Puya profile and the UC25HQ80 profile, with identical inputs, and records what happened.
//
//   node ci/machine/firmware-survey.mjs [--fw id,id,...] [--seconds 8] [--reps 2] [--out results.json] [--engine file.wasm]
//
// Two passes per firmware and configuration, both deterministic in what they emulate:
//   observation  8 s (default) of emulated time with a fixed input script, sampled every audio quantum (128 frames, 2.9 ms): boot and halt status, time to
//                first frame / first content / first flash change (engine clock), flash changes, WIP seen (sampled, so cycles shorter than a quantum can be missed),
//                chip counters (unspecified / unmodelled commands and the last unmodelled opcode), LCD and flash hashes.
//   cost         the same run with no sampling, wall-clock timed, configurations interleaved and repeated (`--reps`), the minimum kept.
// USB is off for every run (the chip engine has no USB host), JIT off (the interpreter is the deterministic reference), 100 MHz.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { loadEngine, EMULATOR_DIR } from "./engine.mjs";
import { Fm1Machine } from "./machine.mjs";
import { defaultEnginePath } from "../engine/verify.mjs";

export const DEFAULT_SET = ["felucca", "aurora", "melodee", "quadro-fm1", "coqui", "chipbox", "scintilla", "cord", "elixir", "beetle", "bytemania", "crepuscular-homunculus",
  "fm1-field", "frasil", "guru600", "jan3000-m-wave-firmware", "modelar"];
export const CONFIGS = [["legacy", {}], ["puya", { flashChip: "puya" }], ["uc25hq80", { flashChip: "uc25hq80" }],
  ["puya-max", { flashChip: "puya", flashTiming: "maximum" }], ["uc25hq80-max", { flashChip: "uc25hq80", flashTiming: "maximum" }]];
const QUANTUM_MS = 128 / 44.1;            // one fm1_render call of audio time

const INPUTS = [   // the same script for every run (audio-clock ms), as in the Stage B/C2 comparisons
  [2000, (m) => m.key(5, true)], [2400, (m) => m.key(5, false)], [3000, (m) => m.midi([0x90, 60, 100])], [3500, (m) => m.midi([0x80, 60, 0])],
  [4000, (m) => m.encoder(1, 1)], [4500, (m) => m.encoder(1, -1)], [5000, (m) => m.pot(500)], [6000, (m) => m.key(10, true)], [6300, (m) => m.key(10, false)],
  [6500, (m) => m.midi([0xb0, 1, 64])],
];

function catalogPackage(id) {
  const entry = JSON.parse(readFileSync(resolve(EMULATOR_DIR, "firmwares.json"), "utf8")).firmwares.find((f) => f.id === id && f.package);
  if (!entry) throw new Error(`no bundled firmware ${id}`);
  return new Uint8Array(readFileSync(resolve(EMULATOR_DIR, entry.package)));
}

/** One sampled run. Returns the record. */
export function observeRun(engine, pkg, options, seconds) {
  const m = Fm1Machine.boot(engine, pkg, { usb: false, ...options });
  const x = m.x, chip = !!m.flashChipInfo;
  const pending = [...INPUTS];
  const rec = { firstFrameMs: null, firstContentMs: null, firstFlashMs: null, lastFlashMs: null, wipSamples: 0, wipEpisodes: 0, wipMaxMs: 0, wipTotalMs: 0, samples: 0, maxColours: 0, audioPeak: 0 };
  let prevWip = false, wipStart = 0, lastEmu = 0, lastRev = 0;
  const quanta = Math.ceil((seconds * 1000) / QUANTUM_MS);
  for (let i = 0; i < quanta; i++) {
    const audioMs = i * QUANTUM_MS;
    while (pending.length && audioMs >= pending[0][0]) pending.shift()[1](m);
    m.run(QUANTUM_MS);
    if (x.fm1_halted()) break;
    const emu = x.fm1_ms(), rev = x.fm1_flash_revision();
    rec.samples++;
    if (rec.firstFrameMs === null && x.fm1_lcd_revision() > 0) rec.firstFrameMs = emu;
    if (rev !== lastRev) { if (rec.firstFlashMs === null) rec.firstFlashMs = emu; rec.lastFlashMs = emu; lastRev = rev; }
    if (chip) {
      const w = x.fm1_flash_wip() === 1;
      if (w) { rec.wipSamples++; rec.wipTotalMs += emu - lastEmu; }
      if (w && !prevWip) { rec.wipEpisodes++; wipStart = lastEmu; }
      if (!w && prevWip) rec.wipMaxMs = Math.max(rec.wipMaxMs, emu - wipStart);
      prevWip = w;
    }
    lastEmu = emu;
    if (i % 35 === 0) {                      // about every 100 ms: the picture
      const o = m.observe();
      rec.maxColours = Math.max(rec.maxColours, o.lcdColours);
      rec.audioPeak = Math.max(rec.audioPeak, o.audioPeak);
      if (rec.firstContentMs === null && o.lcdColours >= 2) rec.firstContentMs = emu;
    }
  }
  const o = m.observe();
  rec.maxColours = Math.max(rec.maxColours, o.lcdColours);
  rec.audioPeak = Math.max(rec.audioPeak, o.audioPeak);
  const halted = m.halted;
  let verdict = "booted";
  if (halted) verdict = "crashed"; else if (rec.maxColours < 2) verdict = "blank"; else if (o.lcdColours < 2) verdict = "display-lost";
  return {
    verdict, haltedAtMs: halted ? o.emulatedMs : null, emulatedMs: o.emulatedMs, idleMs: o.idleMs,
    ...rec, flashChanges: o.flashRevision, flashSectorsChanged: m.changedSectors().length, lcdHash: o.lcdHash, flashHash: m.flashHash(),
    events: chip ? m.flashEvents() : null, wipEnd: chip ? m.flashWip() : false,
  };
}

/** One unsampled, wall-clock-timed run of `seconds` of emulated time. */
export function costRun(engine, pkg, options, seconds) {
  const m = Fm1Machine.boot(engine, pkg, { usb: false, ...options });
  const pending = [...INPUTS];
  const t0 = performance.now();
  let t = 0;
  while (t < seconds * 1000 && !m.halted) {
    const next = pending.length ? Math.min(pending[0][0], seconds * 1000) : seconds * 1000;
    if (t >= next && pending.length) { pending.shift()[1](m); continue; }
    m.run(Math.max(QUANTUM_MS, next - t)); t = m.frames * 1000 / 44100;
  }
  const wallMs = performance.now() - t0;
  const x = m.x;
  return { wallMs, emulatedMs: x.fm1_ms(), idleMs: x.fm1_idle_ms(), flashChanges: x.fm1_flash_revision(), halted: m.halted };
}

if (process.argv[1] && basename(process.argv[1]) === "firmware-survey.mjs") {
  const argv = process.argv.slice(2), opt = { fw: DEFAULT_SET.join(","), seconds: "8", reps: "2", out: null, engine: null };
  for (let i = 0; i < argv.length; i += 2) { const k = argv[i].replace(/^--/, ""); if (!(k in opt)) { console.error(`unknown option ${argv[i]}`); process.exit(2); } opt[k] = argv[i + 1]; }
  const seconds = Number(opt.seconds), reps = Number(opt.reps);
  const enginePath = opt.engine ? resolve(opt.engine) : defaultEnginePath();
  const engine = await loadEngine({ wasmPath: enginePath, name: basename(enginePath) });
  const ids = opt.fw.split(",");
  const results = { engine: { file: enginePath, sha256: engine.wasmSha256 }, seconds, reps, firmware: {} };
  for (const id of ids) {
    const pkg = catalogPackage(id);
    const r = results.firmware[id] = { observe: {}, cost: {} };
    for (const [name, options] of CONFIGS) {
      if (name.endsWith("-max") && !(r.observe[name.replace("-max", "")]?.flashChanges > 0)) continue;       // maximum timing only where a profile run writes flash
      r.observe[name] = observeRun(engine, pkg, options, seconds);
    }
    const costNames = CONFIGS.map(([n]) => n).filter((n) => r.observe[n]);
    for (const n of costNames) r.cost[n] = [];
    for (let rep = 0; rep < reps; rep++) for (const [n, options] of CONFIGS) if (r.cost[n]) r.cost[n].push(costRun(engine, pkg, options, seconds));
    const L = r.observe.legacy;
    console.log(`${id.padEnd(24)} ` + Object.entries(r.observe).map(([n, o]) => `${n}:${o.verdict}${o.haltedAtMs !== null ? "@" + o.haltedAtMs : ""} w${o.flashChanges}`).join("  "));
    void L;
  }
  if (opt.out) writeFileSync(resolve(opt.out), JSON.stringify(results, null, 1));
}
