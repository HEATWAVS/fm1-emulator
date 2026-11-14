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
//   --flash-id ID       make the flash chip report the older (puya = 85 60 14, alias old) or newer
//                       (uc25hq80 = B3 60 14, alias new) hardware's JEDEC ID. ID only, not chip emulation.
//                       Default: not set, the engine's own ID, unchanged from before.
//   --flash-chip CHIP   run a datasheet-based flash chip model: puya (alias old) or uc25hq80 (alias new) -- status register, WEL,
//                       WIP, protection, page wrap, cycle timing. Needs a chip-profile engine (node ci/engine/build.mjs); used
//                       automatically from ci/engine/out/ unless --engine is given. legacy = the original model (same as omitting it).
//                       Cannot be combined with --flash-id. Default: not set, the shipped engine's original flash model, unchanged.
//   --flash-uid HEX     the chip's 128-bit unique ID that 4Bh returns: 32 hex digits, byte 0 first. A TEST FIXTURE (the real value is per device and in
//                       neither datasheet; none is supplied). Needs --flash-chip. Without it 4Bh answers FF and counts the read as unknown.
//   --flash-timing T    typical (default with --flash-chip) | maximum: the datasheet cycle times. Needs --flash-chip.
//   --fault JSON        arm one single-shot flash power cut (Component 5): {"op":"program|erase4k|erase32k|erase64k|erase|chip-erase|any","nth":1,"at":{"afterCycles":N}}
//                       (at: atAccept:true | fraction | afterUs | afterCycles). Needs --flash-chip and a fault-injection engine (ci/engine/build.mjs). The machine then stops at the cut with
//                       verdict power-cut (NOT crashed); the JSON report gains a `fault` section with the audit record and the indeterminate ranges. No outcome is applied: that is an explicit
//                       policy of the scenario runner (ci/machine/faultscenario.mjs), never a CLI default. Default: not set, nothing changes.
//   --engine FILE       use this engine .wasm instead of site/emulator/fm1_web.wasm (read only; e.g. a chip-profile engine)
//   --seconds N         emulated seconds to watch (default 3)
//   --clock MHZ         emulated CPU clock (default 100)
//   --expect VERDICT    booted (default) | crashed | power-cut | blank | display-lost
//   --save-flash FILE   write the flash sectors that differ from the package to FILE afterwards
//   --json              print one JSON document instead of text
// Exit code: 0 the verdict matched --expect, 1 it did not, 2 bad usage or the package would not boot.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { loadEngine, EMULATOR_DIR } from "./engine.mjs";
import { Fm1Machine, BootError, corruptedSectors } from "./machine.mjs";
import { FlashChipError } from "./flashchip.mjs";
import { FaultHarnessError } from "./fault.mjs";
import { defaultEnginePath } from "../engine/verify.mjs";
import { watch, VERDICTS } from "./monitor.mjs";
import { packRecords, unpackRecords, mergeSectors } from "./flash.mjs";

function usage(message) {
  console.error(`fm1 machine runner: ${message}\nsee the header of ci/machine/cli.mjs for options`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const opts = { corrupt: [] };
const valued = { "--package": "package", "--fw": "fw", "--flash": "flash", "--seconds": "seconds", "--clock": "clock", "--expect": "expect", "--save-flash": "saveFlash", "--flash-id": "flashId", "--flash-chip": "flashChip", "--flash-timing": "flashTiming", "--flash-uid": "flashUid", "--fault": "fault", "--engine": "engine" };
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

function parseFaultJson(text) {
  try { return JSON.parse(text); } catch (e) { return usage(`--fault is not JSON: ${e.message}`); }
}
const hexOf = (u8) => Buffer.from(u8).toString("hex");
function describeFault(machine) {
  const s = machine.faultState(), r = s.record;
  return {
    trigger: s.trigger, status: s.status, powerCut: s.powerCut, halted: s.halted, cycles: s.cycles,
    counters: { accepted: s.accepted, completed: s.completed, interrupted: s.interrupted, indeterminateReads: s.reads },
    indeterminate: s.indeterminate,
    record: r && { source: r.source, op: r.op, ordinal: r.ordinal, nth: r.nth, acceptedAtCycle: r.acceptedAtCycle, requestedCutCycle: r.requestedCutCycle, actualCutCycle: r.actualCutCycle, endWouldBeAtCycle: r.endWouldBeAtCycle, ranges: r.ranges, bytesAtRisk: r.before.length, ...(r.before.length <= 256 ? { beforeHex: hexOf(r.before), ifCompletedHex: hexOf(r.ifCompleted) } : {}) },
  };
}

let result;
try {
  // --engine names an engine file; asking for a chip profile without one uses the engine ci/engine/build.mjs built (if there is one)
  const enginePath = opts.engine ? resolve(opts.engine) : opts.flashChip && existsSync(defaultEnginePath()) ? defaultEnginePath() : null;
  const engine = enginePath ? await loadEngine({ wasmPath: enginePath, name: basename(enginePath) }) : await loadEngine();
  const pkg = new Uint8Array(readFileSync(packagePath));
  let sectors = opts.flash ? unpackRecords(new Uint8Array(readFileSync(resolve(opts.flash)))) : [];
  if (opts.corrupt.length) sectors = mergeSectors(sectors, corruptedSectors(engine, pkg, opts.corrupt, { mhz }));
  const machine = Fm1Machine.boot(engine, pkg, { mhz, sectors, flashId: opts.flashId ?? null, flashChip: opts.flashChip ?? null, flashTiming: opts.flashTiming ?? null, flashUid: opts.flashUid ?? null, fault: opts.fault ? parseFaultJson(opts.fault) : null });
  const report = watch(machine, { seconds });
  const changed = machine.changedSectors();
  if (opts.saveFlash) writeFileSync(resolve(opts.saveFlash), packRecords(changed));
  const { samples, ...summary } = report;
  result = {
    engine: { name: engine.name, wasmSha256: engine.wasmSha256, capabilities: engine.capabilities },
    package: { path: packagePath, sha256: createHash("sha256").update(pkg).digest("hex") },
    options: { seconds, mhz, corrupt: opts.corrupt, flashFile: opts.flash ?? null, ...(opts.flashId ? { flashId: opts.flashId } : {}), ...(opts.flashChip ? { flashChip: opts.flashChip } : {}), ...(opts.flashTiming ? { flashTiming: opts.flashTiming } : {}), ...(opts.flashUid ? { flashUid: opts.flashUid } : {}), ...(opts.fault ? { fault: machine.faultInfo } : {}) },
    // only present when --flash-id was given (so default output is unchanged): { method, address, previous, current, name }
    ...(opts.flashId ? { flashId: machine.flashIdInfo } : {}),
    // only present when --flash-chip was given: { chip, timing, jedec }, plus the chip's own counters
    ...(machine.flashChipInfo ? { flashChip: { ...machine.flashChipInfo, events: machine.flashEvents() } } : {}),
    // only present when --fault was given: the engine's own account of the cut (never an outcome)
    ...(machine.faultInfo ? { fault: describeFault(machine) } : {}),
    expected: expect,
    pass: report.verdict === expect,
    ...summary,
    flash: { hash: machine.flashHash(), changedSectors: changed.map((s) => `0x${s.at.toString(16)}`) },
  };
} catch (error) {
  if (error instanceof FlashChipError || error instanceof FaultHarnessError) usage(`${error.message} [${error.code}]`);
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
  if (result.flashChip) console.log(`  flash chip: ${result.flashChip.chip} (${result.flashChip.jedec.map((b) => b.toString(16).padStart(2, "0")).join(" ")}), ${result.flashChip.timing} timing; commands ignored as unspecified ${result.flashChip.events.unspecified}, opcodes outside the model ${result.flashChip.events.notModeled}`);
  if (result.flashId) console.log(`  flash ID: ${result.flashId.name} (${result.flashId.current.map((b) => b.toString(16).padStart(2, "0")).join(" ")}), ID selection only`);
  if (result.haltedAtMs !== null) console.log(`  CPU halted at engine clock ${result.haltedAtMs} ms`);
  if (result.fault) console.log(`  fault: ${result.fault.status}; ${result.fault.record ? `cut requested at cycle ${result.fault.record.requestedCutCycle}, fired at ${result.fault.record.actualCutCycle}, ${result.fault.record.bytesAtRisk} bytes at risk (indeterminate, no outcome applied)` : "no cut happened"}`);
  console.log(`  flash sectors differing from the package: ${result.flash.changedSectors.length ? result.flash.changedSectors.join(" ") : "none"}`);
}
process.exit(result.pass ? 0 : 1);
