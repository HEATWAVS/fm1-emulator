// Drives the flash chip of a LIVE chip-profile engine over the SoC's own SPI0 and chip-select registers, the way the CPU does,
// without running firmware, with a clock the test controls. Needs the engine's test hooks (capability testBus; ci/engine/build.mjs
// builds them, the shipped engine has none). Used by the live chip conformance tests (chiplivetests.mjs).
//
// The machine is booted but never rendered, so nothing else touches the chip and time moves only when advance() says so.
import { Fm1Machine } from "./machine.mjs";

const SPI0 = 0x11c00;            // SPI0 CON; BUF is +8
const CS = 0x500c0;              // GPIO PD0 OUT: the flash chip select (low = selected)
export const FLASH_BYTES = 1 << 20;
/** Longer than any datasheet maximum cycle time (20 ms): advancing this far ends every cycle. */
export const SETTLE_US = 25_000;

export class LiveChip {
  constructor(machine) {
    if (!machine.engine.capabilities.testBus) throw new Error(`engine "${machine.engine.name}" has no test bus hooks (build the chip engine: node ci/engine/build.mjs)`);
    this.m = machine;
    this.x = machine.x;
  }

  /** Boot `pkg` (the package only provides a booted machine; the chip is exercised directly). Options as Fm1Machine.boot. */
  static boot(engine, pkg, options = {}) {
    return new LiveChip(Fm1Machine.boot(engine, pkg, { usb: false, ...options }));
  }

  /** The 1 MiB flash array, live (a fresh view each call: engine memory can move). */
  mem() { return new Uint8Array(this.x.memory.buffer, this.x.fm1_flash(), FLASH_BYTES); }

  /** One chip-select transaction: the bytes clocked out, then `read` bytes clocked in. Returns the bytes read. */
  tx(bytes, read = 0) {
    const x = this.x;
    x.fm1_test_bus_write32(CS, 0);
    for (const b of bytes) { x.fm1_test_bus_write32(SPI0, 0); x.fm1_test_bus_write32(SPI0 + 8, b); }
    const out = [];
    for (let i = 0; i < read; i++) { x.fm1_test_bus_write32(SPI0, 0x1000); x.fm1_test_bus_write32(SPI0 + 8, 0); out.push(x.fm1_test_bus_read32(SPI0 + 8) & 0xff); }
    x.fm1_test_bus_write32(CS, 1);
    return out;
  }

  /** Let `us` microseconds of emulated time pass. */
  advance(us) { if (us > 0) this.x.fm1_test_advance_us(us); }
  settle() { this.advance(SETTLE_US); }

  wren() { this.tx([0x06]); }
  /** The 16-bit status register as the firmware reads it: 05h = S7..S0, 35h = S15..S8. */
  status() { const lo = this.tx([0x05], 1)[0], hi = this.tx([0x35], 1)[0]; return lo | (hi << 8); }
  /** The chip's WIP as the engine reports it (fm1_flash_wip): must always agree with status() bit 0. */
  wip() { return this.m.flashWip(); }
  events() { return this.m.flashEvents(); }
  /** WP# pin level. */
  wp(high) { this.x.fm1_test_set_wp(high ? 1 : 0); }
  id() { return this.tx([0x9f], 3); }

  /** WREN, one command, then let every cycle end. */
  run(bytes, read = 0) { this.wren(); const out = this.tx(bytes, read); this.settle(); return out; }
  /** WREN, write status register (S7..S0, optionally S15..S8), then let it complete. */
  wrsr(lo, hi = null) { return this.run(hi === null ? [0x01, lo] : [0x01, lo, hi]); }

  /** Fill the array: "ff" erased, "zero", or "pat" (a fixed non-uniform pattern the oracle transcripts also use). */
  fill(kind) {
    const m = this.mem();
    if (kind === "ff") m.fill(0xff);
    else if (kind === "zero") m.fill(0);
    else if (kind === "pat") for (let i = 0; i < FLASH_BYTES; i++) m[i] = pat(i);
    else throw new Error(`unknown fill ${kind}`);
    return this;
  }

  /** Power the unit off and on (a new machine; the flash array and, for the same chip profile, the chip's non-volatile status carry over). */
  powerCycle(overrides = {}) { return new LiveChip(this.m.powerCycle(overrides)); }
}

/** The pattern fill("pat") writes (also the oracle transcripts' initial image "pat"). */
export const pat = (i) => ((i * 131 + (i >> 8) * 17) ^ 0x5a) & 0xff;
