// A headless FM-1: boots a real firmware package on the emulated CPU with no window and no
// audio device, advances emulated time, lets tests read and corrupt flash, and reports what the
// machine is doing. One Fm1Machine is one power-on; powerCycle() makes the next one, carrying the
// flash changes over exactly as the app saves them.
import { createHash } from "node:crypto";
import { FLASH_SIZE, SECTOR, diffSectors, corruptSectors } from "./flash.mjs";
import { FlashIdError, parseFlashId, applyFlashId, readFlashId } from "./flashid.mjs";
import { FlashChipError, resolveFlashChipOptions, applyFlashChip, applyFlashUid, parseFlashChip, parseFlashUid } from "./flashchip.mjs";

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
   *   flashNvStatus  the chip's non-volatile status bits (value | unknown << 16, from fm1_flash_nv_status) as they were when the unit
   *            was switched off; powerCycle() passes it for you when the same chip profile is kept. Needs a chip profile and an engine
   *            with the flashNv capability. Not stored in `options`.
   *   flashUid  the chip's 128-bit unique ID that 4Bh (Read Unique ID) returns: 32 hex digits or 16 bytes in transmission order. A TEST FIXTURE: the
   *            value is per device and in neither datasheet, so there is none unless you give one (without it 4Bh answers FF and counts the read as unknown).
   *            Needs a chip profile and an engine with the flashUid capability; stored in `options`, so powerCycle() keeps it for the same chip.
   */
  static boot(engine, pkg, { mhz = 100, sectors = null, jit = false, usb = true, flashId = null, flashChip = null, flashTiming = null, flashNvStatus = null, flashUid = null } = {}) {
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
    }
    const machine = new Fm1Machine(engine, x, pkg, { mhz, jit, usb, flashId: preset ? preset.name : null, flashChip: chipChoice.chip === "legacy" ? null : chipChoice.chip, flashTiming: chipChoice.timing, flashUid: uidHex });
    machine.flashIdInfo = flashIdInfo;         // null unless an ID was selected
    machine.flashChipInfo = flashChipInfo;     // null unless a chip profile was selected: { chip, timing, jedec }
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
  /** Advance the machine by `ms` of emulated time (stops early if the CPU halts). */
  run(ms) {
    const x = this.x;
    const quanta = Math.ceil((ms * SAMPLE_RATE) / 1000 / QUANTUM);
    for (let i = 0; i < quanta; i++) {
      if (x.fm1_halted()) break;
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

  get halted() { return this.x.fm1_halted() === 1; }

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
  powerCycle({ corrupt = [], ...overrides } = {}) {
    const before = this.flash();
    const sectors = diffSectors(before, this.baseFlash());
    let extra = [];
    if (corrupt.length) extra = corruptSectors(before, corrupt);
    const merged = new Map([...sectors, ...extra].map((s) => [s.at, s]));
    // The same chip profile stays the same physical chip: its non-volatile status bits (BP, CMP, SRP, QE, LB) survive power-off, WEL does not.
    // A different chip swapped in while off starts with a fresh status. (A cycle still running is treated as completing: power loss mid-cycle is not modelled.)
    const next = "flashChip" in overrides ? (overrides.flashChip == null ? "legacy" : parseFlashChip(overrides.flashChip)) : (this.flashChipInfo ? this.flashChipInfo.chip : "legacy");
    const sameChip = !!this.flashChipInfo && next === this.flashChipInfo.chip;
    let carry = {};
    if (sameChip && this.engine.capabilities.flashNv && !("flashNvStatus" in overrides)) carry.flashNvStatus = this.x.fm1_flash_nv_status() >>> 0;
    // the unique ID is factory-set and read-only, so it stays with the same chip; a different chip swapped in while off has its own (none, unless given)
    if (!sameChip && this.options.flashUid && !("flashUid" in overrides)) carry.flashUid = null;
    return Fm1Machine.boot(this.engine, this.pkg, { ...this.options, ...overrides, ...carry, sectors: [...merged.values()] });
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
