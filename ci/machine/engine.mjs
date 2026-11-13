// Engine adapter for the headless machine harness.
//
// The harness never assumes which engine it is given: it loads a WebAssembly file, lists what
// that file exports, and reports capabilities. A test that needs a feature the engine does not
// have must say so (see requires() in machine.mjs) instead of passing without testing it.
//
// Today the engine is this repository's site/emulator/fm1_web.wasm, loaded read-only. A later
// engine (for example a separately built upstream one) plugs in through the same adapter.
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

export async function loadEngine({ wasmPath = resolve(EMULATOR_DIR, "fm1_web.wasm"), name = "fm1_web.wasm" } = {}) {
  const bytes = readFileSync(wasmPath);
  const module = new WebAssembly.Module(bytes);
  const { jitImports } = await asModule("jit.js");
  const { applyPackageResources } = await asModule("package-resources.js");
  const exportNames = new Set(WebAssembly.Module.exports(module).map((e) => e.name));
  const has = (...names) => names.every((n) => exportNames.has(n));
  return {
    name,
    wasmPath,
    wasmSha256: createHash("sha256").update(bytes).digest("hex"),
    exportNames,
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
      selectFlashId: has("fm1_flash_id_set"),
      flashFaultInjection: has("fm1_flash_fault"),
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
