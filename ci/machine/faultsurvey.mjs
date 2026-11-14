#!/usr/bin/env node
// Firmware x flash-chip x interruption-point x synthetic-outcome fault survey (Component 5, Stage 5E). Reuses the firmware survey's firmware set, packages and fixed input script
// (firmware-survey.mjs) and the scenario runner (faultscenario.mjs); it is a planner, a sharded runner and a summariser, not a second engine of its own.
//
//   node ci/machine/faultsurvey.mjs all [--jobs 12] [--out docs/dev/fault-survey.json] [--fw id,id] [--chips puya,uc25hq80] [--engine file.wasm]
//   node ci/machine/faultsurvey.mjs unit --fw ID --chip CHIP --out FILE       (one firmware x chip: what `all` runs in each job)
//   node ci/machine/faultsurvey.mjs replay --in results.json --out FILE [--slice i/n]   (re-run stored rows, compare their report hashes)
//   node ci/machine/faultsurvey.mjs summary --in results.json                  (markdown tables)
//
// WHAT IT IS. For every unit (firmware x chip profile, typical timing) it runs: CONTROLS (no fault; a fresh reboot; two ordinary flash faults that are not power cuts), DISCOVERY (which
// program/erase cycles the firmware itself issues under the fixed input script, by cutting at its k-th cycle for a fixed list of k), FIRMWARE-ISSUED scenarios (for each cycle kind found:
// the first and the last probed cycle, five interruption points, three bounding outcome policies; plus the full policy set at the middle point) and HARNESS-ISSUED scenarios (all five
// cycle kinds, at an address the firmware itself uses where it uses one, three interruption points, four policies). Every scenario reboots with an EXPLICIT synthetic outcome and watches
// the firmware for `rebootMs`, recording what the EMULATOR shows: verdict, whether the screen matches a fresh boot, reads of unknown bytes, whether the unknown range was erased again.
//
// WHAT IT IS NOT. It is not exhaustive (the coverage is the fixed matrix in CONFIG, recorded in the results), and nothing here says what a physical chip holds after a power cut: the
// datasheets do not specify it. An outcome is a named synthetic input; a firmware that boots under one is not shown to recover on hardware, and one that fails under one is not shown to
// fail on hardware. The firmware set is the 17 bundled packages of the firmware survey; discovery and sweeps run only the 8 s fixed input script, so cycles a firmware issues only under
// other use (saving a patch on request, say) are not reached.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { loadEngine } from "./engine.mjs";
import { Fm1Machine, corruptedSectors } from "./machine.mjs";
import { watch } from "./monitor.mjs";
import { DEFAULT_SET, INPUTS, catalogPackage } from "./firmware-survey.mjs";
import { runFaultScenario } from "./faultscenario.mjs";
import { DISCLAIMER } from "./faultpolicy.mjs";
import { defaultEnginePath } from "../engine/verify.mjs";

export const SURVEY_VERSION = 1;
const POLICIES = {
  old: { kind: "old" }, new: { kind: "new" }, ff: { kind: "ff" }, zero: { kind: "zero" }, "prefix@0.5": { kind: "prefix", fraction: 0.5 },
  "random#1": { kind: "random", seed: 1 }, "random#2": { kind: "random", seed: 2 }, "bit-mix#1": { kind: "bit-mix", seed: 1 }, "bit-mix#2": { kind: "bit-mix", seed: 2 },
};
const POINTS = { accept: { atAccept: true }, "f0.25": { fraction: 0.25 }, "f0.5": { fraction: 0.5 }, "f0.75": { fraction: 0.75 }, "f0.999": { fraction: 0.999 } };

/** The fixed coverage of this survey (recorded in the results). Nothing outside it is claimed. */
export const CONFIG = {
  chips: ["puya", "uc25hq80"], timing: "typical",
  driveMs: 8000, rebootMs: 3000, inputs: true,                                  // the firmware survey's 8 s input script, before the cut and again after the reboot
  probeNth: [1, 2, 3, 4, 6, 10, 20, 50, 100, 300, 1000],                         // the firmware's own cycles probed (cut at the accept of its k-th in-scope cycle)
  firmwarePoints: ["accept", "f0.25", "f0.5", "f0.75", "f0.999"], firmwarePolicies: ["old", "new", "ff"],
  policySweepPoint: "f0.5", policySweepExtra: ["zero", "prefix@0.5", "random#1", "random#2", "bit-mix#1", "bit-mix#2"],
  harnessKinds: ["program", "erase4k", "erase32k", "erase64k", "chip-erase"], harnessPoints: ["accept", "f0.5", "f0.999"], harnessPolicies: ["old", "new", "ff", "random#1"],
  harnessExtraPoint: "f0.5", harnessExtraPolicies: ["zero", "prefix@0.5", "bit-mix#1", "random#2"],        // every policy also meets every harness-issued kind, at the middle point
  harnessWarmupMs: 1500, harnessDefaultAddress: 0x74000,
  ordinaryFaults: ["erase:0x20000", "zero:0x4000"],
  replay: { everyNth: 25 },
};

const policyName = (p) => (p.seed !== undefined ? `${p.kind}#${p.seed}` : p.fraction !== undefined ? `${p.kind}@${p.fraction}` : p.kind);
const sha16 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export function unitList(fw = DEFAULT_SET, chips = CONFIG.chips) { return fw.flatMap((f) => chips.map((c) => ({ fw: f, chip: c }))); }

/** One row of the results from a scenario report (compact; `cfg` is everything needed to re-run it). */
export function rowOf(id, meta, report, control) {
  const r = report.reboot, rec = report.record;
  const carried = r ? r.indeterminateCarriedIn.reduce((n, [lo, hi]) => n + hi - lo + 1, 0) : 0;
  const end = r && r.indeterminateAtEnd ? r.indeterminateAtEnd.reduce((n, [lo, hi]) => n + hi - lo + 1, 0) : null;
  return {
    id, ...meta, cfg: report.config,
    stop: { outcome: report.stop.outcome, status: report.stop.status, requestedCutCycle: rec?.requestedCutCycle ?? null, actualCutCycle: rec?.actualCutCycle ?? null, op: rec?.op ?? null, bytesAtRisk: rec?.bytesAtRisk ?? 0, ranges: rec?.ranges.length ?? 0, firstRange: rec?.ranges[0] ?? null },
    reboot: r && {
      verdict: r.verdict, haltedAtMs: r.haltedAtMs, trap: r.trap ?? null,
      screenMatchesFreshBoot: r.lcdHash === null ? null : r.lcdHash === control.lcdHash,
      lcdColours: r.lcdColours, unknownReads: r.indeterminateReads, unknownBytesCarriedIn: carried, unknownBytesAtEnd: end,
      rangeErasedAgain: end === null ? null : end < carried, firmwareFlashChanges: r.flashChangesByFirmware,
      outcomeHash: r.outcome.hash, lcdHash: r.lcdHash, flashHash: r.flashHash,
    },
    reportSha256: report.reportSha256,
  };
}

function controlsOf(engine, pkg, chip, fw) {
  const out = {};
  const boot = (sectors) => Fm1Machine.boot(engine, pkg, { usb: false, flashChip: chip, flashTiming: CONFIG.timing, sectors });
  const m1 = boot(null);
  const w1 = watch(m1, { seconds: CONFIG.driveMs / 1000, inputs: INPUTS });
  const s1 = m1.faultState();
  out.noFault = { verdict: w1.verdict, halted: m1.halted, powerCut: m1.powerCut, status: m1.status, accepted: s1.accepted, completed: s1.completed, flashRevision: w1.final.flashRevision, lcdHash: w1.final.lcdHash };
  const m2 = boot(null);
  const w2 = watch(m2, { seconds: CONFIG.rebootMs / 1000, inputs: INPUTS });
  out.freshBoot = { verdict: w2.verdict, lcdHash: w2.final.lcdHash, lcdColours: w2.final.lcdColours, flashChanges: w2.activity.flashChanges };
  out.ordinary = {};
  for (const spec of CONFIG.ordinaryFaults) {
    const sectors = corruptedSectors(engine, pkg, [spec], { usb: false });
    const m = boot(sectors);
    let verdict, trap = null;
    try { verdict = watch(m, { seconds: CONFIG.rebootMs / 1000, inputs: INPUTS }).verdict; } catch (e) { if (!(e instanceof WebAssembly.RuntimeError)) throw e; verdict = "engine-trap"; trap = String(e.message).slice(0, 60); }
    out.ordinary[spec] = { verdict, trap, halted: trap ? null : m.halted, powerCut: trap ? null : m.powerCut };
  }
  return out;
}

/** Everything for one firmware x chip: controls, discovery, firmware-issued and harness-issued scenarios. */
export function runUnit(engine, fw, chip) {
  const pkg = catalogPackage(fw);
  const unit = `${fw}/${chip}`;
  const rows = [];
  const controls = controlsOf(engine, pkg, chip, fw);
  const control = controls.freshBoot;
  // ---- discovery: the firmware's own cycles
  const cycles = [];
  for (const k of CONFIG.probeNth) {
    const r = runFaultScenario(engine, pkg, { chip, timing: CONFIG.timing, fault: { op: "any", nth: k, at: { atAccept: true } }, inputs: CONFIG.inputs, maxMs: CONFIG.driveMs });
    if (r.stop.outcome !== "power-cut") break;                   // the firmware issues fewer than k cycles in the window
    cycles.push({ nth: k, op: r.record.op, ordinal: r.record.ordinal, acceptedAtMs: +(r.record.acceptedAtCycle / 100000).toFixed(3), bytesAtRisk: r.record.bytesAtRisk, firstRange: r.record.ranges[0] });
  }
  // ---- firmware-issued sweeps: per cycle kind found, its first and its last probed cycle
  const byKind = new Map();
  for (const c of cycles) { if (!byKind.has(c.op)) byKind.set(c.op, []); byKind.get(c.op).push(c); }
  const run = (id, meta, cfg) => rows.push(rowOf(id, meta, runFaultScenario(engine, pkg, { chip, timing: CONFIG.timing, rebootMs: CONFIG.rebootMs, inputs: CONFIG.inputs, ...cfg }), control));
  for (const [op, list] of [...byKind.entries()].sort()) {
    const reps = [...new Set([list[0], list[list.length - 1]])];
    reps.forEach((c, ri) => {
      for (const pn of CONFIG.firmwarePoints) {
        const policies = [...CONFIG.firmwarePolicies, ...(pn === CONFIG.policySweepPoint && ri === 0 ? CONFIG.policySweepExtra : [])];
        for (const pol of policies) {
          run(`${unit}/fw/${op}@${c.nth}/${pn}/${pol}`, { unit, firmware: fw, chip, origin: "firmware", kind: op, cycle: c.nth, point: pn, policy: pol },
            { fault: { op: "any", nth: c.nth, at: POINTS[pn] }, policy: POLICIES[pol], maxMs: CONFIG.driveMs });
        }
      }
    });
  }
  // ---- harness-issued sweeps: every kind, at an address the firmware uses where it uses one
  const used = cycles.find((c) => c.firstRange);
  const address = used ? used.firstRange[0] - (used.firstRange[0] % 4096) : CONFIG.harnessDefaultAddress;
  for (const kind of CONFIG.harnessKinds) {
    for (const pn of CONFIG.harnessPoints) {
      for (const pol of [...CONFIG.harnessPolicies, ...(pn === CONFIG.harnessExtraPoint ? CONFIG.harnessExtraPolicies : [])]) {
        run(`${unit}/hx/${kind}/${pn}/${pol}`, { unit, firmware: fw, chip, origin: "harness", kind, cycle: null, point: pn, policy: pol, address: kind === "chip-erase" ? null : address },
          { fault: { op: kind, nth: 1, at: POINTS[pn] }, policy: POLICIES[pol], inject: { kind, address, warmupMs: CONFIG.harnessWarmupMs } });
      }
    }
  }
  return { unit, firmware: fw, chip, controls, cycles, rows };
}

/**
 * Compare every reboot with the same scenario under the `old` bound (the interrupted cycle left the flash exactly as it was before it): does the firmware show the same screen and end with
 * the same flash? The baseline that separates "the outcome mattered" from "the firmware does that anyway after this cut point". Rows without an `old` partner (and the `old` rows) get null.
 */
export function annotateAgainstOld(rows) {
  const key = (r) => `${r.unit}/${r.origin}/${r.kind}/${r.cycle}/${r.point}`;
  const old = new Map(rows.filter((r) => r.policy === "old" && r.reboot).map((r) => [key(r), r.reboot]));
  for (const r of rows) {
    if (!r.reboot) continue;
    const b = r.policy === "old" ? null : old.get(key(r));
    const usable = b && b.lcdHash !== null && r.reboot.lcdHash !== null;
    r.reboot.screenSameAsOldBound = usable ? r.reboot.lcdHash === b.lcdHash : null;
    r.reboot.flashSameAsOldBound = usable ? r.reboot.flashHash === b.flashHash : null;
  }
  return rows;
}

/** Group counts of a set of rows: how many cuts fired, and what the emulator showed after the reboot. */
function tally(rows) {
  const t = { scenarios: rows.length, cutFired: 0, notTriggered: 0, haltedBeforeCut: 0, verdicts: {}, screenMatchesFreshBoot: 0, readUnknownBytes: 0, rangeErasedAgain: 0, firmwareWroteAfterReboot: 0, engineTraps: 0, comparedWithOld: 0, sameScreenAsOld: 0, sameFlashAsOld: 0 };
  for (const r of rows) {
    if (r.stop.outcome === "power-cut") t.cutFired++; else if (r.stop.outcome === "halted") t.haltedBeforeCut++; else t.notTriggered++;
    if (!r.reboot) continue;
    t.verdicts[r.reboot.verdict] = (t.verdicts[r.reboot.verdict] ?? 0) + 1;
    if (r.reboot.verdict === "engine-trap") t.engineTraps++;
    if (r.reboot.screenMatchesFreshBoot) t.screenMatchesFreshBoot++;
    if (r.reboot.unknownReads > 0) t.readUnknownBytes++;
    if (r.reboot.rangeErasedAgain) t.rangeErasedAgain++;
    if (r.reboot.firmwareFlashChanges > 0) t.firmwareWroteAfterReboot++;
    if (r.reboot.screenSameAsOldBound !== undefined && r.reboot.screenSameAsOldBound !== null) {
      t.comparedWithOld++;
      if (r.reboot.screenSameAsOldBound) t.sameScreenAsOld++;
      if (r.reboot.flashSameAsOldBound) t.sameFlashAsOld++;
    }
  }
  return t;
}
const groupBy = (rows, key) => { const m = {}; for (const r of rows) (m[key(r)] ??= []).push(r); return Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, tally(v)])); };

export function summarize(results) {
  const rows = results.rows;
  return {
    total: tally(rows),
    byChipAndKind: groupBy(rows, (r) => `${r.chip} / ${r.origin} / ${r.kind}`),
    byPolicy: groupBy(rows, (r) => r.policy),
    byPoint: groupBy(rows, (r) => `${r.origin} / ${r.point}`),
    byFirmware: groupBy(rows, (r) => r.firmware),
    byChip: groupBy(rows, (r) => r.chip),
  };
}

function markdownTable(title, groups) {
  const cols = ["scenarios", "cutFired", "notTriggered", "haltedBeforeCut", "booted", "crashed", "blank", "display-lost", "engine-trap", "screenMatchesFreshBoot", "comparedWithOld", "sameScreenAsOld", "sameFlashAsOld", "readUnknownBytes", "rangeErasedAgain", "firmwareWroteAfterReboot"];
  const lines = [`### ${title}`, "", `| group | ${cols.join(" | ")} |`, `|---|${cols.map(() => "---:").join("|")}|`];
  for (const [k, t] of Object.entries(groups)) lines.push(`| ${k} | ${cols.map((c) => (t[c] ?? t.verdicts[c] ?? 0)).join(" | ")} |`);
  return lines.join("\n");
}

/** Markdown tables of a results file (numbers only: they describe the emulator, never a physical chip). */
export function summaryMarkdown(results) {
  const s = summarize(results);
  return [markdownTable("By chip profile", s.byChip), markdownTable("By chip profile, origin and interrupted cycle kind", s.byChipAndKind), markdownTable("By synthetic outcome policy", s.byPolicy),
    markdownTable("By interruption point", s.byPoint), markdownTable("By firmware", s.byFirmware)].join("\n\n");
}

/** Rows to re-run for the determinism check: one per (origin, kind, policy) and every Nth row. A fixed rule, recorded in the results. */
export function replaySelection(rows, everyNth = CONFIG.replay.everyNth) {
  const seen = new Set(), picked = [];
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  sorted.forEach((r, i) => {
    const key = `${r.origin}/${r.kind}/${r.policy}`;
    if (!seen.has(key) || i % everyNth === 0) { seen.add(key); picked.push(r.id); }
  });
  return picked;
}

function replayRows(engine, rows) {
  const out = [];
  for (const row of rows) {
    const r = runFaultScenario(engine, catalogPackage(row.firmware), row.cfg);
    out.push({ id: row.id, expected: row.reportSha256, got: r.reportSha256, same: r.reportSha256 === row.reportSha256 });
  }
  return out;
}

async function openEngine(opt) {
  const enginePath = opt.engine ? resolve(opt.engine) : defaultEnginePath();
  return loadEngine({ wasmPath: enginePath, name: basename(enginePath) });
}

function parseArgs(argv) {
  const opt = { jobs: "12", out: null, fw: null, chips: null, chip: null, engine: null, in: null, slice: null };
  const mode = argv[0];
  for (let i = 1; i < argv.length; i += 2) { const k = argv[i].replace(/^--/, ""); if (!(k in opt)) { console.error(`unknown option ${argv[i]}`); process.exit(2); } opt[k] = argv[i + 1]; }
  return { mode, opt };
}

function runJob(args) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [import.meta.filename, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => (code === 0 ? res() : rej(new Error(`job ${args.join(" ")} exited ${code}: ${err.slice(-500)}`))));
  });
}

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } }));
}

if (process.argv[1] && basename(process.argv[1]) === "faultsurvey.mjs") {
  const { mode, opt } = parseArgs(process.argv.slice(2));
  if (mode === "unit") {
    const engine = await openEngine(opt);
    writeFileSync(resolve(opt.out), JSON.stringify(runUnit(engine, opt.fw, opt.chip)));
  } else if (mode === "all") {
    const fw = opt.fw ? opt.fw.split(",") : DEFAULT_SET, chips = opt.chips ? opt.chips.split(",") : CONFIG.chips;
    const units = unitList(fw, chips);
    const dir = resolve(tmpdir(), `fm1-fault-survey-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const enginePath = opt.engine ? resolve(opt.engine) : defaultEnginePath();
    const engine = await openEngine(opt);
    const t0 = Date.now();
    await pool(units, Number(opt.jobs), async (u, i) => {
      await runJob(["unit", "--fw", u.fw, "--chip", u.chip, "--out", resolve(dir, `u${i}.json`), "--engine", enginePath]);
      console.log(`unit ${i + 1}/${units.length} ${u.fw}/${u.chip} done (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    });
    const unitResults = units.map((_, i) => JSON.parse(readFileSync(resolve(dir, `u${i}.json`), "utf8")));
    const rows = annotateAgainstOld(unitResults.flatMap((u) => u.rows).sort((a, b) => (a.id < b.id ? -1 : 1)));
    const results = {
      version: SURVEY_VERSION, disclaimer: DISCLAIMER, config: CONFIG, engine: { sha256: engine.wasmSha256 }, units: Object.fromEntries(unitResults.map((u) => [u.unit, { controls: u.controls, cycles: u.cycles, rows: u.rows.length }])),
      rows,
    };
    // determinism: re-run a fixed selection of rows in fresh processes and compare their report hashes
    const ids = replaySelection(rows), byId = new Map(rows.map((r) => [r.id, r]));
    const slices = Math.min(Number(opt.jobs), Math.max(1, Math.ceil(ids.length / 6)));
    const chunks = Array.from({ length: slices }, (_, s) => ids.filter((_, i) => i % slices === s));
    const inFile = resolve(dir, "replay-in.json");
    writeFileSync(inFile, JSON.stringify({ rows: ids.map((id) => byId.get(id)) }));
    await pool(chunks, slices, async (c, s) => { await runJob(["replay", "--in", inFile, "--slice", `${s}/${slices}`, "--out", resolve(dir, `r${s}.json`), "--engine", enginePath]); });
    const replayed = chunks.flatMap((_, s) => JSON.parse(readFileSync(resolve(dir, `r${s}.json`), "utf8")));
    results.replay = { rule: "one row per (origin, kind, policy) plus every 25th row of the id-sorted list, re-run in a fresh process", rows: replayed.length, identical: replayed.filter((r) => r.same).length, mismatches: replayed.filter((r) => !r.same).map((r) => r.id) };
    results.summary = summarize(results);
    const out = resolve(opt.out ?? "fault-survey.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(results));
    rmSync(dir, { recursive: true, force: true });
    console.log(`wrote ${out}: ${rows.length} scenarios, ${units.length} units, replay ${results.replay.identical}/${results.replay.rows} identical, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  } else if (mode === "replay") {
    const engine = await openEngine(opt);
    const { rows } = JSON.parse(readFileSync(resolve(opt.in), "utf8"));
    const [s, n] = opt.slice ? opt.slice.split("/").map(Number) : [0, 1];
    writeFileSync(resolve(opt.out), JSON.stringify(replayRows(engine, rows.filter((_, i) => i % n === s))));
  } else if (mode === "summary") {
    console.log(summaryMarkdown(JSON.parse(readFileSync(resolve(opt.in), "utf8"))));
  } else {
    console.error("usage: faultsurvey.mjs all | unit | replay | summary (see the header)");
    process.exit(2);
  }
}
