// Tests of the optimized unified engine (settled-loop early exit of core 1; the engine of Default): the pin, and the identity of the COMMITTED binary
// site/emulator/fm1_web_frodhes_optimized.wasm (ci/engine/build.mjs --optimized rebuilds it). Quick tier only: no engine is run here.
// (the behavioural tests, switch off against the committed unified engine and switch on against off, are in ci/chip-mode-tests.mjs --full and the 277-package passes). It is the engine of Default since the integration (D109).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { EMULATOR_DIR } from "./engine.mjs";
import { PIN, UNIFIED, OPTIMIZED, verifyOptimizedFile } from "../engine/verify.mjs";
import { SHIPPED_WASM_SHA256 } from "./unifiedtests.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const sha = (b) => createHash("sha256").update(b).digest("hex");
export const OPTIMIZED_WASM = resolve(EMULATOR_DIR, "fm1_web_frodhes_optimized.wasm");
/** The unified engine this one is built on, and the optimized build the scratch investigation validated (adaptive v4); both complete hashes. */
export const UNIFIED_WASM_SHA256 = "5d595ae778bf8cf7c698c463ff175efa0a08313d1272efd30db7b34d3d74e0c8";
export const OPTIMIZED_WASM_SHA256 = "20e5300c5714a4b70ebabc4b49b43d1ae8062a8ac1c9eee272aee8d6e82edd9a";
export const OPTIMIZED_PATCH_SHA256 = "ae229c5e2fd7243840b129624a395ba373264823ce8332ea194a5537ef396161";

export function registerOptimizedQuickTests(testQuick) {
  testQuick("optimized engine pin: settled-loop.patch is the pinned one, touches exactly the four files, and the export list is the unified engine's plus the two switch exports", () => {
    const patch = readFileSync(resolve(ROOT, "ci/engine", OPTIMIZED.patch.file));
    assert.equal(sha(patch), OPTIMIZED.patch.sha256, "ci/engine/settled-loop.patch is the pinned one (edit it, rebuild with build.mjs --optimized, then re-pin)");
    assert.equal(OPTIMIZED.patch.sha256, OPTIMIZED_PATCH_SHA256);
    const text = patch.toString("utf8");
    assert.ok(!text.includes("\r"), "the patch is stored with LF line endings (ci/engine/*.patch is -text)");
    assert.deepEqual([...text.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]),
      ["crates/fm1-soc/src/lib.rs", "crates/fm1-soc/src/machine.rs", "crates/fm1-soc/src/periph.rs", "crates/fm1-web/src/lib.rs"], "the patch touches exactly these files: never usb.rs, fwsc.rs or fm1-core");
    for (const s of ["pub struct Settled1", "pub extern \"C\" fn fm1_settled_loop(on: u32)", "pub extern \"C\" fn fm1_settled_loop_stat(i: u32) -> f64", "fn prove_round(", "fn settled_call_end(",
      "const SETTLED_MISS_MAX: u32 = 8;", "fn the_switch_is_off_by_default()", "fn a_busy_core_makes_the_looking_pause_without_changing_anything()", "fn the_looking_resumes_when_the_hold_runs_out()"]) assert.ok(text.includes(s), s);
    assert.ok(!/fm1_audit|AUDIT|SETTLED_TEST_MODE|thread_local/.test(text), "no audit hook, test-only switch or thread-local state in the patch");
    assert.deepEqual(OPTIMIZED.addedExports, ["fm1_settled_loop", "fm1_settled_loop_stat"]);
    assert.deepEqual([...OPTIMIZED.expectedExports].sort(), [...new Set([...UNIFIED.expectedExports, ...OPTIMIZED.addedExports])].sort(), "the optimized exports are the unified engine's plus the added ones");
    assert.equal(OPTIMIZED.expectedExports.length, 84);
    assert.equal(OPTIMIZED.artifact, "fm1_web_frodhes_optimized.wasm");
    assert.equal(OPTIMIZED.shippedCopy, "site/emulator/fm1_web_frodhes_optimized.wasm");
  });

  testQuick("optimized engine: the committed site/emulator/fm1_web_frodhes_optimized.wasm is the pinned build (complete hash, exact exports and imports) and differs from the unified engine", () => {
    const rustc = Object.keys(OPTIMIZED.toolchains)[0];
    const v = verifyOptimizedFile(OPTIMIZED_WASM, { rustc });
    assert.equal(v.hash, "match", `sha256 ${v.sha256}`);
    assert.equal(v.sha256, OPTIMIZED_WASM_SHA256, "the optimized build the Stage 2 validation accepted (adaptive v5, which supersedes v4 a0dacf3f...), byte for byte");
    assert.equal(OPTIMIZED.toolchains[rustc].wasmSha256, OPTIMIZED_WASM_SHA256);
    assert.equal(v.bytes, OPTIMIZED.toolchains[rustc].wasmBytes);
    assert.ok(v.exportsOk, `missing ${v.missing} unexpected ${v.unexpected}`);
    assert.ok(v.importsOk, v.imports.join());
    assert.deepEqual(v.exports.filter((n) => !UNIFIED.expectedExports.includes(n)), ["fm1_settled_loop", "fm1_settled_loop_stat"], "the only exports beyond the unified engine's are the switch and its counters");
    assert.deepEqual(v.imports, PIN.expectedImports, "the same imports as every other engine of this family");
    assert.notEqual(v.sha256, UNIFIED_WASM_SHA256);
  });

  testQuick("optimized engine: building it leaves the shipped engine and the unified engine as pinned (their complete hashes)", () => {
    assert.equal(sha(readFileSync(resolve(EMULATOR_DIR, "fm1_web.wasm"))), SHIPPED_WASM_SHA256, "the shipped engine is untouched (it draws the panel and is the reference mode)");
    assert.equal(sha(readFileSync(resolve(EMULATOR_DIR, "fm1_web_unified.wasm"))), UNIFIED_WASM_SHA256, "the unified engine is the pinned one");
    assert.equal(UNIFIED.toolchains[Object.keys(UNIFIED.toolchains)[0]].wasmSha256, UNIFIED_WASM_SHA256);
  });
}
