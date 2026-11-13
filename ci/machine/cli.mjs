#!/usr/bin/env node
// Headless FM-1 runner: boot a firmware package on the emulated hardware, watch it, report.
//
//   node ci/machine/cli.mjs --package build/fw.fwsc --expect booted
//   node ci/machine/cli.mjs --fw felucca --corrupt zero:0x4000 --expect blank --json
//
// Options
//   --package FILE      a .fwsc firmware package            (or)
//   --fw ID             a bundled firmware by catalog id (site/emulator/firmwares.json)
//   --flash FILE        start from saved flash sector records (see --save-flash)
//   --corrupt SPEC      corrupt flash before boot; repeatable: zero:ADDR[:LEN] erase:ADDR[:LEN] flip:ADDR:LEN:COUNT[:SEED]
//   --seconds N         emulated seconds to watch (default 3)
//   --clock MHZ         emulated CPU clock (default 100)
//   --expect VERDICT    booted (default) | crashed | blank | display-lost
//   --save-flash FILE   write the flash sectors that differ from the package to FILE afterwards
//   --json              print one JSON document instead of text
// Exit code: 0 the verdict matched --expect, 1 it did not, 2 bad usage or the package would not boot.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { loadEngine, EMULATOR_DIR } from "./engine.mjs";
import { Fm1Machine, BootError, corruptedSectors } from "./machine.mjs";
import { watch, VERDICTS } from "./monitor.mjs";
import { packRecords, unpackRecords, mergeSectors } from "./flash.mjs";

function usage(message) {
  console.error(`fm1 machine runner: ${message}\nsee the header of ci/machine/cli.mjs for options`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const opts = { corrupt: [] };
const valued = { "--package": "package", "--fw": "fw", "--flash": "flash", "--seconds": "seconds", "--clock": "clock", "--expect": "expect", "--save-flash": "saveFlash" };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--json") opts.json = true;
  else if (a === "--corrupt") { if (argv[i + 1] === undefined) usage("--corrupt needs a value"); opts.corrupt.push(argv[++i]); }
  else if (valued[a]) { if (argv[i + 1] === undefined) usage(`${a} needs a value`); opts[valued[a]] = argv[++i]; }
  else usage(`unknown option ${a}`);
}
if (!opts.package === !opts.fw) usage("give exactly one of --package or --fw");
const expect = opts.expect ?? "booted";
if (!VERDICTS.includes(expect)) usage(`--expect must be one of ${VERDICTS.join(", ")}`);
const seconds = Number(opts.seconds ?? 3), mhz = Number(opts.clock ?? 100);
if (!(seconds > 0) || !(mhz > 0)) usage("--seconds and --clock must be positive numbers");

let packagePath = opts.package && resolve(opts.package);
if (opts.fw) {
  const entry = JSON.parse(readFileSync(resolve(EMULATOR_DIR, "firmwares.json"), "utf8")).firmwares.find((f) => f.id === opts.fw && f.package);
  if (!entry) usage(`no bundled firmware with id "${opts.fw}"`);
  packagePath = resolve(EMULATOR_DIR, entry.package);
}

let result;
try {
  const engine = await loadEngine();
  const pkg = new Uint8Array(readFileSync(packagePath));
  let sectors = opts.flash ? unpackRecords(new Uint8Array(readFileSync(resolve(opts.flash)))) : [];
  if (opts.corrupt.length) sectors = mergeSectors(sectors, corruptedSectors(engine, pkg, opts.corrupt, { mhz }));
  const machine = Fm1Machine.boot(engine, pkg, { mhz, sectors });
  const report = watch(machine, { seconds });
  const changed = machine.changedSectors();
  if (opts.saveFlash) writeFileSync(resolve(opts.saveFlash), packRecords(changed));
  const { samples, ...summary } = report;
  result = {
    engine: { name: engine.name, wasmSha256: engine.wasmSha256, capabilities: engine.capabilities },
    package: { path: packagePath, sha256: createHash("sha256").update(pkg).digest("hex") },
    options: { seconds, mhz, corrupt: opts.corrupt, flashFile: opts.flash ?? null },
    expected: expect,
    pass: report.verdict === expect,
    ...summary,
    flash: { hash: machine.flashHash(), changedSectors: changed.map((s) => `0x${s.at.toString(16)}`) },
  };
} catch (error) {
  if (error instanceof BootError) {
    console.error(`fm1 machine runner: ${error.code}: ${error.message}`);
    process.exit(2);
  }
  usage(String(error.message ?? error));
}

if (opts.json) console.log(JSON.stringify(result, null, 2));
else {
  const f = result.final;
  console.log(`${result.pass ? "PASS" : "FAIL"}  verdict=${result.verdict} (expected ${expect})  after ${f.audioMs} ms of audio time (engine clock ${result.emulatedMs} ms)`);
  console.log(`  screen: ${f.lcdColours} colours, ${result.activity.screenChanges} changes | audio peak ${result.activity.audioPeak.toFixed(3)} | flash changes by firmware ${result.activity.flashChanges}`);
  if (result.haltedAtMs !== null) console.log(`  CPU halted at engine clock ${result.haltedAtMs} ms`);
  console.log(`  flash sectors differing from the package: ${result.flash.changedSectors.length ? result.flash.changedSectors.join(" ") : "none"}`);
}
process.exit(result.pass ? 0 : 1);
