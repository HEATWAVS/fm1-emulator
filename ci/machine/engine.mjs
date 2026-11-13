// Engine adapter for the headless machine harness.
//
// The harness never assumes which engine it is given: it loads a WebAssembly file, lists what
// that file exports, and reports capabilities. A test that needs a feature the engine does not
// have must say so (see requires() in machine.mjs) instead of passing without testing it.
//
// By default the engine is this repository's site/emulator/fm1_web.wasm, loaded read-only. Another engine (the
// chip-profile engine from ci/engine/build.mjs, never committed) plugs in through the same adapter: loadEngine({ wasmPath }).
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const EMULATOR_DIR = resolve(here, "../../site/emulator");

// The page's own helper modules are plain browser scripts (this package has no "type": "module"),
// so they are imported from a data: URL the way ci/audit-firmwares.mjs does.
const asModule = (file) =>
  import(`data:text/javascript;base64,${readFileSync(resolve(EMULATOR_DIR, file)).toString("base64")}`);

// Engine builds whose in-memory chip-structure layout has been validated for flashid.mjs, keyed by the
// full sha256 of the .wasm. Anything else gets no flash-ID support (it fails safe, never guesses).
// Validated 2026-11-13 on Windows/Node 24 by probing (see docs/dev/ARCHITECTURE.md): the engine keeps 3
// copies of its chip structure (1 live, 2 stale), each with the 3 ID bytes 48 bytes after the pointer to
// the flash memory (fm1_flash()).
export const FLASH_ID_LAYOUTS = {
  cdf039104a7445b01ae8de062cc67a2967ea39a8abc2d268e44beb0825370278: { jedecOffsetFromFlashPtr: 48, searchWindow: 256, copies: 3 },
};

export async function loadEngine({ wasmPath = resolve(EMULATOR_DIR, "fm1_web.wasm"), name = "fm1_web.wasm" } = {}) {
  const bytes = readFileSync(wasmPath);
  const module = new WebAssembly.Module(bytes);
  const { jitImports } = await asModule("jit.js");
  const { applyPackageResources } = await asModule("package-resources.js");
  const exportNames = new Set(WebAssembly.Module.exports(module).map((e) => e.name));
  const has = (...names) => names.every((n) => exportNames.has(n));
  const wasmSha256 = createHash("sha256").update(bytes).digest("hex");
  const flashIdLayout = has("fm1_flash", "fm1_flash_len", "fm1_flash_revision", "fm1_xip") ? FLASH_ID_LAYOUTS[wasmSha256] ?? null : null;
  return {
    name,
    wasmPath,
    wasmSha256,
    exportNames,
    flashIdLayout,
    // What this engine can do, found by looking at its exports (never assumed).
    capabilities: {
      boot: has("fm1_boot_fwsc", "fm1_alloc", "fm1_render", "fm1_halted"),
      flashRead: has("fm1_flash", "fm1_flash_len"),
      flashBase: has("fm1_flash_base"),
      flashRestore: has("fm1_flash_restore"),
      flashRevision: has("fm1_flash_revision", "fm1_flash_busy"),
      input: has("fm1_key", "fm1_enc", "fm1_midi", "fm1_pot"),
      lcd: has("fm1_lcd", "fm1_lcd_revision"),
      cpu1Fault: has("fm1_cpu1_fault"),
      // Not exposed by the engine in this repository, nor by the upstream source we read
      // (spiflash.rs keeps the ID in a Rust field; its power-cut switch is a native environment
      // variable). They stay false until an engine exports them.
      selectFlashId: has("fm1_flash_id_set"),          // native: an engine export (none yet)
      flashIdPatch: flashIdLayout !== null,           // runtime patch on a validated build (flashid.mjs)
      flashFaultInjection: has("fm1_flash_fault"),
      // A chip-profile engine (built by ci/engine/build.mjs; the shipped engine has none of these). Profile selection,
      // the status register's WIP bit (distinct from fm1_flash_busy, which is chip-select), and the unspecified/unmodelled counters.
      selectFlashChip: has("fm1_flash_chip", "fm1_flash_timing"),
      flashWip: has("fm1_flash_wip"),
      flashEvents: has("fm1_flash_events"),
      // the chip's non-volatile status bits across a power cycle; and test-only hooks that drive the SoC bus (SPI0, chip select, the
      // cycle counter) without running firmware, used by the live chip conformance tests (never in the shipped engine)
      flashNv: has("fm1_flash_nv_status", "fm1_flash_nv_restore"),
      testBus: has("fm1_test_bus_write32", "fm1_test_bus_read32", "fm1_test_advance_us", "fm1_test_set_wp"),
      resetCounter: has("fm1_resets"),
    },
    instantiate() {
      let exports;
      exports = new WebAssembly.Instance(module, { env: jitImports(() => exports) }).exports;
      return exports;
    },
    applyPackageResources,
  };
}
