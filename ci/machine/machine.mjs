// A headless FM-1: boots a real firmware package on the emulated CPU with no window and no
// audio device, advances emulated time, lets tests read and corrupt flash, and reports what the
// machine is doing. One Fm1Machine is one power-on; powerCycle() makes the next one, carrying the
// flash changes over exactly as the app saves them.
import { createHash } from "node:crypto";
import { FLASH_SIZE, SECTOR, diffSectors, corruptSectors } from "./flash.mjs";
import { FlashIdError, parseFlashId, applyFlashId, readFlashId } from "./flashid.mjs";
import { FlashChipError, resolveFlashChipOptions, applyFlashChip, applyFlashUid, parseFlashChip, parseFlashUid } from "./flashchip.mjs";
import { FaultHarnessError, requiresFaultEngine, parseFaultSpec, armFault, disarmFault, enableJournal, cutPower as cutPowerNow, restoreChip as restoreChipNow, indeterminateRanges, setIndeterminate, readState, readRecord, policyRecord } from "./fault.mjs";
import { materialize, applyToImage, validatePolicy } from "./faultpolicy.mjs";

export const SAMPLE_RATE = 44100;           // the engine renders at 44.1 kHz
const QUANTUM = 128;                         // frames per fm1_render call, as the app does
const sha = (u8) => createHash("sha256").update(u8).digest("hex");

export class BootError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Throw unless the engine has every named capability (so a test never passes by skipping). */
export function requires(engine, ...names) {
  const missing = names.filter((n) => !engine.capabilities[n]);
  if (missing.length) throw new Error(`engine "${engine.name}" lacks: ${missing.join(", ")}`);
}

export class Fm1Machine {
  constructor(engine, exports, pkg, options) {
    this.engine = engine;
    this.x = exports;
    this.pkg = pkg;
    this.options = options;
    this.audio = { sumSq: 0, n: 0, peak: 0 };
    this.frames = 0;                         // audio frames rendered: the harness's own clock
    this.faultInfo = null;                   // the canonical fault spec armed at boot ({ op, nth, at }), or null
    this.faultOutcome = null;                // after powerCycle() from a power cut: the explicit synthetic outcome applied to the rebooted flash
  }

  /**
   * Boot `pkg` (the bytes of a .fwsc). Options:
   *   mhz      emulated CPU clock (default 100, as the audit script uses)
   *   sectors  flash sector records applied before the first instruction runs
   *   jit      WebAssembly JIT; off by default (the interpreter is the deterministic reference)
   *   usb      plug the virtual USB host, as the app and the audit script do (default true)
   *   flashId  "puya" (older hardware, 85 60 14) or "uc25hq80" (newer, B3 60 14); see flashid.mjs.
   *            Unset (the default): nothing is touched and the engine's own ID is used, exactly as before.
   *            ID selection only: no other chip behaviour changes. Refused (FlashIdError) on an engine
   *            build without a validated layout, and on a non-FM-1 board.
   *   flashChip   "puya" | "uc25hq80" | "legacy" (flashchip.mjs): a datasheet-based chip model (status register, WEL, WIP,
   *            protection, page wrap, cycle timing). Needs a chip-profile engine (ci/engine/build.mjs; capability selectFlashChip).
   *            Unset (the default) = "legacy": the engine's original instantaneous model, nothing called, behaviour unchanged.
   *            Selected before the first instruction runs; there is no way to change it on a running machine.
   *   flashTiming "typical" (default with a chip) | "maximum": the datasheet cycle times. Only with a chip profile.
   *            flashChip cannot be combined with flashId. Bad or conflicting input is refused before anything boots.
   *   fault    a power-cut trigger { op, nth, at } (fault.mjs; Component 5): the flash chip loses power while the nth matching program/erase cycle runs, at a deterministic
   *            cycle after it was accepted. Needs a chip profile and a fault-injection engine. Single shot. Armed before the first instruction; NOT stored in `options`
   *            (a power cycle does not re-arm it). The trigger never contains an outcome policy.
   *   faultJournal  journal every in-scope cycle so cutPower() can interrupt one without a trigger (a `fault` turns it on). Needs the same.
   *   faultIndeterminate  [[lo, hi], ...] bytes physically unknown after an earlier cut, carried into this boot (powerCycle() passes it for you). Replaces the list; the flash is untouched.
   *   flashNvStatus  the chip's non-volatile status bits (value | unknown << 16, from fm1_flash_nv_status) as they were when the unit
   *            was switched off; powerCycle() passes it for you when the same chip profile is kept. Needs a chip profile and an engine
   *            with the flashNv capability. Not stored in `options`.
   *   flashUid  the chip's 128-bit unique ID that 4Bh (Read Unique ID) returns: 32 hex digits or 16 bytes in transmission order. A TEST FIXTURE: the
   *            value is per device and in neither datasheet, so there is none unless you give one (without it 4Bh answers FF and counts the read as unknown).
   *            Needs a chip profile and an engine with the flashUid capability; stored in `options`, so powerCycle() keeps it for the same chip.
   */
  static boot(engine, pkg, { mhz = 100, sectors = null, jit = false, usb = true, flashId = null, flashChip = null, flashTiming = null, flashNvStatus = null, flashUid = null, fault = null, faultJournal = false, faultIndeterminate = null } = {}) {
    requires(engine, "boot", "flashRead");
    const chipChoice = resolveFlashChipOptions({ flashChip, flashTiming, flashId });         // reject bad input before booting
    if (chipChoice.chip !== "legacy" && !engine.capabilities.selectFlashChip) {
      throw new FlashChipError("unsupported-engine", `engine "${engine.name}" has no flash chip profiles (build one with node ci/engine/build.mjs)`);
    }
    const uidHex = flashUid === null || flashUid === undefined ? null : parseFlashUid(flashUid);
    if (uidHex !== null) {
      if (chipChoice.chip === "legacy") throw new FlashChipError("uid-needs-chip", "flashUid applies to a chip profile; the legacy model's 4Bh answer is its own fixed pattern");
      if (!engine.capabilities.flashUid) throw new FlashChipError("unsupported-engine", `engine "${engine.name}" cannot take a unique-ID fixture (rebuild it: node ci/engine/build.mjs)`);
    }
    const nvGiven = flashNvStatus !== null && flashNvStatus !== undefined;
    if (nvGiven) {
      if (!Number.isInteger(flashNvStatus) || flashNvStatus < 0 || flashNvStatus > 0xffffffff) throw new FlashChipError("invalid-nv-status", `flashNvStatus must be an unsigned 32-bit integer, got ${JSON.stringify(flashNvStatus)}`);
      if (chipChoice.chip === "legacy") throw new FlashChipError("nv-needs-chip", "flashNvStatus applies to a chip profile; the legacy model has no status register");
      if (!engine.capabilities.flashNv) throw new FlashChipError("unsupported-engine", `engine "${engine.name}" cannot restore a chip's non-volatile status`);
    }
    // fault injection: validated before anything boots; needs a chip profile (the legacy model has no cycle to interrupt) and a fault-injection engine
    const faultSpec = fault === null || fault === undefined ? null : parseFaultSpec(fault);
    const carried = faultIndeterminate === null || faultIndeterminate === undefined ? null : faultIndeterminate;
    if (faultSpec || faultJournal || (carried && carried.length)) {
      requiresFaultEngine(engine);
      if (chipChoice.chip === "legacy") throw new FaultHarnessError("needs-chip", "fault injection applies to a chip profile (flashChip puya or uc25hq80); the legacy model has instantaneous cycles");
    }
    const preset = flashId === null || flashId === undefined ? null : parseFlashId(flashId);   // reject bad input before booting
    if (preset && !engine.flashIdLayout) {
      throw new FlashIdError("unsupported-engine", `engine "${engine.name}" (sha256 ${engine.wasmSha256.slice(0, 12)}…) has no validated flash-ID layout`);
    }
    const x = engine.instantiate();
    x.fm1_jit(jit ? 1 : 0, 16);
    x.fm1_ahead?.(1024);
    const put = (bytes) => {
      const p = x.fm1_alloc(bytes.length);
      new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes);
      return p;
    };
    if (x.fm1_boot_fwsc(put(pkg), pkg.length, 0, 0, mhz) !== 0) {
      throw new BootError("package-rejected", "not an FM-1 update package");
    }
    engine.applyPackageResources(x, pkg);
    if (sectors?.length) {
      requires(engine, "flashRestore");
      const bytes = new Uint8Array(sectors.length * (SECTOR + 4));
      sectors.forEach((s, i) => {
        new DataView(bytes.buffer).setUint32(i * (SECTOR + 4), s.at, true);
        bytes.set(s.data, i * (SECTOR + 4) + 4);
      });
      if (x.fm1_flash_restore(put(bytes), bytes.length) !== 0) throw new BootError("flash-rejected", "the engine refused the flash sectors");
    }
    if (usb) x.fm1_usb_plug?.();
    let flashIdInfo = null;
    if (preset) {                              // before the first instruction runs
      if (x.fm1_board() !== 0) throw new FlashIdError("unsupported-board", "flash ID selection is for the FM-1 board only");
      flashIdInfo = applyFlashId(x, engine.flashIdLayout, preset);
    }
    let flashChipInfo = null;
    if (chipChoice.chip !== "legacy") {          // likewise before the first instruction runs, and after any flash restore
      if (x.fm1_board() !== 0) throw new FlashChipError("unsupported-board", "flash chip profiles are for the FM-1 board only");
      flashChipInfo = applyFlashChip(x, chipChoice);
      if (nvGiven && x.fm1_flash_nv_restore(flashNvStatus >>> 0) !== 0) throw new FlashChipError("engine-refused", "the engine refused the chip's non-volatile status");
      if (uidHex !== null) applyFlashUid(x, uidHex);
      if (carried && carried.length) setIndeterminate(x, carried);       // bytes an earlier cut left unknown stay unknown (the flash itself is whatever the caller restored)
    }
    let faultInfo = null;
    if (faultJournal) enableJournal(x, true);
    if (faultSpec) faultInfo = armFault(x, faultSpec.canonical);
    const machine = new Fm1Machine(engine, x, pkg, { mhz, jit, usb, flashId: preset ? preset.name : null, flashChip: chipChoice.chip === "legacy" ? null : chipChoice.chip, flashTiming: chipChoice.timing, flashUid: uidHex });
    machine.flashIdInfo = flashIdInfo;         // null unless an ID was selected
    machine.flashChipInfo = flashChipInfo;     // null unless a chip profile was selected: { chip, timing, jedec }
    machine.faultInfo = faultInfo;             // null unless a trigger was armed: the canonical { op, nth, at }
    return machine;
  }

  /** The ID the engine's flash chip currently reports ({bytes, name, address}); needs a validated engine build. */
  flashId() { return readFlashId(this.x, this.engine.flashIdLayout); }

  /** The flash chip's WIP bit now (a program/erase/write-status cycle is running). Distinct from observe().flashBusy, which is chip-select. */
  flashWip() { requires(this.engine, "flashWip"); return this.x.fm1_flash_wip() === 1; }

  /** 4Bh Read Unique ID reads answered without a unique-ID fixture (the bytes were 0xFF and unknown). */
  flashUidUnknownReads() { requires(this.engine, "flashEvents"); return this.x.fm1_flash_events(3); }

  /** Commands the selected chip profile ignored because its datasheet is silent/contradictory, and opcodes outside the model. */
  flashEvents() {
    requires(this.engine, "flashEvents");
    return { unspecified: this.x.fm1_flash_events(0), notModeled: this.x.fm1_flash_events(1), lastNotModeled: this.x.fm1_flash_events(2) };   // lastNotModeled: that opcode (0 = none)
  }

  // ------------------------------------------------------------ running
  /**
   * Advance the machine by `ms` of emulated time. Stops early, and at once, when the CPU halts (HALTED: a CPU fault) or when the flash chip loses power in a cut (POWER CUT: the
   * machine lost power; a state of its own, never reported as a halt): the state is checked before EVERY quantum, so the quantum after the one in which the cut fired is never
   * rendered. A machine in either state does not run again: run() returns without rendering.
   */
  run(ms) {
    const x = this.x;
    const quanta = Math.ceil((ms * SAMPLE_RATE) / 1000 / QUANTUM);
    for (let i = 0; i < quanta; i++) {
      if (x.fm1_halted() || this.powerCut) break;
      x.fm1_render(QUANTUM, 4_000_000);
      const l = new Float32Array(x.memory.buffer, x.fm1_out_l(), QUANTUM);
      for (let k = 0; k < QUANTUM; k++) {
        const v = l[k];
        this.audio.sumSq += v * v;
        if (Math.abs(v) > this.audio.peak) this.audio.peak = Math.abs(v);
      }
      this.audio.n += QUANTUM;
      this.frames += QUANTUM;
    }
  }

  /** The CPU faulted (an ordinary crash). Never true for a power cut. */
  get halted() { return this.x.fm1_halted() === 1; }

  /** The flash chip lost power in a cut and the machine with it (terminal; distinct from `halted`). Always false on an engine without fault injection. */
  get powerCut() { return this.engine.capabilities.faultInjection ? this.x.fm1_power_cut() === 1 : false; }

  /** "power_cut" | "halted" | "running": the three ways a machine can be, kept apart. */
  get status() { return this.powerCut ? "power_cut" : this.halted ? "halted" : "running"; }

  /** What the machine looks like right now. Audio levels cover the time since the last observe(). */
  observe() {
    const x = this.x;
    const lcd = new Uint16Array(x.memory.buffer, x.fm1_lcd(), 240 * 240);
    const a = this.audio;
    const obs = {
      // audioMs is the harness's clock (what run() was asked for). emulatedMs is the engine's own
      // clock, which can be far ahead: it counts time the engine skipped while the firmware idled.
      audioMs: Math.round((this.frames * 1000) / SAMPLE_RATE),
      emulatedMs: x.fm1_ms(),
      idleMs: x.fm1_idle_ms?.() ?? 0,
      halted: this.halted,
      // only on a fault-injection engine, so every other engine's observation keeps exactly its old shape
      ...(this.engine.capabilities.faultInjection ? { powerCut: this.powerCut } : {}),
      board: x.fm1_board(),
      flashRevision: x.fm1_flash_revision(),
      flashBusy: x.fm1_flash_busy() === 1,
      // only on a chip-profile engine, so the default engine's observation keeps exactly its old shape
      ...(this.engine.capabilities.flashWip ? { flashWip: x.fm1_flash_wip() === 1 } : {}),
      lcdRevision: x.fm1_lcd_revision(),
      lcdColours: new Set(lcd).size,
      lcdHash: sha(new Uint8Array(lcd.buffer, lcd.byteOffset, lcd.byteLength)).slice(0, 16),
      audioRms: a.n ? Math.sqrt(a.sumSq / a.n) : 0,
      audioPeak: a.peak,
    };
    this.audio = { sumSq: 0, n: 0, peak: 0 };
    return obs;
  }

  /** The LCD as raw RGB565 pixels (240 x 240). */
  lcd() {
    const x = this.x;
    return new Uint16Array(x.memory.buffer, x.fm1_lcd(), 240 * 240).slice();
  }

  // ------------------------------------------------------------ flash
  /** The whole 1 MiB flash as it is now (a copy). */
  flash() {
    const x = this.x;
    return new Uint8Array(x.memory.buffer, x.fm1_flash(), x.fm1_flash_len()).slice();
  }

  /** The flash as the package installed it, before the firmware changed anything (a copy). */
  baseFlash() {
    requires(this.engine, "flashBase");
    const x = this.x;
    return new Uint8Array(x.memory.buffer, x.fm1_flash_base(), x.fm1_flash_len()).slice();
  }

  flashHash() { return sha(this.flash()).slice(0, 16); }

  /** Sectors that differ from the package's base flash: what the app would save. */
  changedSectors() { return diffSectors(this.flash(), this.baseFlash()); }

  // ------------------------------------------------------------ fault injection (Component 5, Stage 5D)
  // The engine records interruption, affected range and indeterminate state ONLY. Nothing here states what an interrupted range holds: flash() shows a labelled placeholder there
  // (the pre-image) and peekKnown() marks those bytes unknown. A synthetic outcome is an explicit policy given to powerCycle({ outcome }).
  #fault() {
    requiresFaultEngine(this.engine);
    if (!this.flashChipInfo) throw new FaultHarnessError("needs-chip", "fault injection applies to a chip profile (flashChip puya or uc25hq80)");
  }
  /** Arm one single-shot power cut on a running machine (see the `fault` boot option). Returns the canonical spec. */
  armFault(spec) { this.#fault(); this.faultInfo = armFault(this.x, spec); return this.faultInfo; }
  disarmFault() { this.#fault(); disarmFault(this.x); this.faultInfo = null; }
  /** Journal every in-scope cycle so cutPower() can interrupt one without a trigger. Must be on BEFORE the cycle is accepted. */
  enableFaultJournal(on = true) { this.#fault(); enableJournal(this.x, on); }
  /** Cut power now, while a program/erase/chip erase is in flight. Returns the audit record; the machine is terminal afterwards. */
  cutPower() { this.#fault(); return cutPowerNow(this.x); }
  /** Power returns to the chip only (for chip-level inspection); the machine stays powered off until powerCycle(). */
  restoreChip() { this.#fault(); restoreChipNow(this.x); }
  /** The SoC cycle counter: the clock every cycle number of the fault record is in. */
  cycles() { this.#fault(); return this.x.fm1_cycles(); }
  /** The bytes physically unknown after a cut: inclusive [lo, hi] ranges. The list survives any synthetic fill and is cleared only by a complete erase. */
  indeterminateRanges() { this.#fault(); return indeterminateRanges(this.x); }
  /**
   * The flash bytes at [addr, addr + len) with the indeterminate ones marked: { bytes, unknown } (unknown[i] = 1 where the byte is indeterminate, its bytes[i] a 0 placeholder, NOT a claim).
   * Unlike flash(), which shows the raw array (placeholders and synthetic input included).
   */
  peekKnown(addr, len = 1) {
    this.#fault();
    const x = this.x, total = x.fm1_flash_len();
    if (!Number.isInteger(addr) || addr < 0 || len < 0 || addr + len > total) throw new RangeError("peekKnown range outside the flash");
    const bytes = new Uint8Array(x.memory.buffer, x.fm1_flash() + addr, len).slice(), unknown = new Uint8Array(len);
    for (const [lo, hi] of indeterminateRanges(x)) for (let a = Math.max(lo, addr); a <= Math.min(hi, addr + len - 1); a++) { unknown[a - addr] = 1; bytes[a - addr] = 0; }
    return { bytes, unknown };
  }
  /** Everything the engine's fault machinery reports now, in one object (numbers, the indeterminate list and the audit record). Never contains an outcome. */
  faultState() {
    this.#fault();
    const s = readState(this.x);
    return { ...s, status: this.status, trigger: this.faultInfo, indeterminate: indeterminateRanges(this.x), record: readRecord(this.x) };
  }
  /**
   * Run until the armed (or harness) power cut, a CPU halt, or `maxMs` of audio time. Returns { outcome: "power-cut" | "halted" | "not-triggered", ranMs, record }: `ranMs` is the audio
   * time run by this call, `record` the audit record (null unless a cut fired). It never throws for "no cut": the caller decides whether that is a failure.
   */
  runUntilCut(maxMs, { stepMs = 50 } = {}) {
    this.#fault();
    if (!(maxMs > 0) || !(stepMs > 0)) throw new RangeError("maxMs and stepMs must be positive");
    const start = this.frames;
    let outcome = "not-triggered";
    while (((this.frames - start) * 1000) / SAMPLE_RATE < maxMs) {
      if (this.powerCut) { outcome = "power-cut"; break; }
      if (this.halted) { outcome = "halted"; break; }
      this.run(stepMs);
    }
    if (outcome === "not-triggered") outcome = this.powerCut ? "power-cut" : this.halted ? "halted" : "not-triggered";
    return { outcome, ranMs: Math.round(((this.frames - start) * 1000) / SAMPLE_RATE), record: this.powerCut ? readRecord(this.x) : null };
  }

  // ------------------------------------------------------------ input
  key(id, down) { requires(this.engine, "input"); this.x.fm1_key(id, down ? 1 : 0); }
  encoder(id, clicks) { requires(this.engine, "input"); this.x.fm1_enc(id, clicks); }
  pot(value) { requires(this.engine, "input"); this.x.fm1_pot(value); }
  midi(bytes) { requires(this.engine, "input"); for (const b of bytes) this.x.fm1_midi(b); }

  // ------------------------------------------------------------ power cycling
  /**
   * Power off and on: a new machine from the same package whose flash is this one's flash.
   * `corrupt` lists corruption specs (see flash.mjs) applied to that flash while it is "off".
   */
  powerCycle({ corrupt = [], outcome = null, ...overrides } = {}) {
    const before = this.flash();
    // After a power cut the cut range holds only the engine's labelled placeholder (the pre-image). What the rebooted chip holds there is a TEST INPUT the caller must name: `outcome` is an
    // explicit synthetic policy ({ kind: "old" | "new" | "ff" | "zero" | "random" | "bit-mix" | "prefix", seed?, fraction? }, faultpolicy.mjs); there is no default. The indeterminate list is
    // carried unchanged (a fill does not make the bytes known) and the applied outcome is kept on the new machine as `faultOutcome`, labelled synthetic.
    let image = before, applied = null;
    if (this.powerCut) {
      if (outcome === null || outcome === undefined) throw new FaultHarnessError("outcome-required", "the machine lost power in a cut: powerCycle() needs an explicit outcome policy for the interrupted range (there is no default fill)");
      const policy = validatePolicy(outcome);
      applied = materialize(policyRecord(readRecord(this.x), { profile: this.flashChipInfo.chip, timing: this.flashChipInfo.timing }), policy);
      image = applyToImage(before, applied).image;
    } else if (outcome !== null && outcome !== undefined) {
      throw new FaultHarnessError("outcome-without-cut", "an outcome policy applies only to a machine that lost power in a cut");
    }
    const sectors = diffSectors(image, this.baseFlash());
    let extra = [];
    if (corrupt.length) extra = corruptSectors(image, corrupt);
    const merged = new Map([...sectors, ...extra].map((s) => [s.at, s]));
    // The same chip profile stays the same physical chip: its non-volatile status bits (BP, CMP, SRP, QE, LB) survive power-off, WEL does not.
    // A different chip swapped in while off starts with a fresh status. (A cycle still running is treated as completing: power loss mid-cycle is not modelled.)
    const next = "flashChip" in overrides ? (overrides.flashChip == null ? "legacy" : parseFlashChip(overrides.flashChip)) : (this.flashChipInfo ? this.flashChipInfo.chip : "legacy");
    const sameChip = !!this.flashChipInfo && next === this.flashChipInfo.chip;
    let carry = {};
    if (sameChip && this.engine.capabilities.flashNv && !("flashNvStatus" in overrides)) carry.flashNvStatus = this.x.fm1_flash_nv_status() >>> 0;
    // the unique ID is factory-set and read-only, so it stays with the same chip; a different chip swapped in while off has its own (none, unless given)
    if (!sameChip && this.options.flashUid && !("flashUid" in overrides)) carry.flashUid = null;
    // bytes an earlier cut left unknown stay unknown for the same chip (a different chip swapped in while off starts with none)
    if (sameChip && this.engine.capabilities.faultInjection && !("faultIndeterminate" in overrides)) {
      const ranges = indeterminateRanges(this.x);
      if (ranges.length) carry.faultIndeterminate = ranges;
    }
    const rebooted = Fm1Machine.boot(this.engine, this.pkg, { ...this.options, ...overrides, ...carry, sectors: [...merged.values()] });
    rebooted.faultOutcome = applied;     // null unless this machine was powered off by a cut: the explicit synthetic outcome now in the new flash
    return rebooted;
  }
}

/**
 * Sector records that corrupt a freshly installed package's flash, for use as Fm1Machine.boot's
 * `sectors`. (Boots a throwaway machine without running it, to see the flash to corrupt.)
 */
export function corruptedSectors(engine, pkg, specs, options = {}) {
  const probe = Fm1Machine.boot(engine, pkg, options);
  const flash = probe.flash();
  if (flash.length !== FLASH_SIZE) throw new Error(`unexpected flash size ${flash.length}`);
  return corruptSectors(flash, specs);
}
