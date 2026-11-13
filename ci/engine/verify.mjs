// Checks a built chip-profile engine against ci/engine/pin.json: its exports and imports exactly, and its hash
// where the toolchain that built it is one the pin has a verified hash for. Pure checks, no side effects.
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const PIN = JSON.parse(readFileSync(resolve(here, "pin.json"), "utf8"));
/** Where build.mjs puts the engine (gitignored), and where tests look for it unless FM1_CHIP_ENGINE names another. */
export const DEFAULT_OUT = resolve(here, "out");
export const defaultEnginePath = () => (process.env.FM1_CHIP_ENGINE ? resolve(process.env.FM1_CHIP_ENGINE) : resolve(DEFAULT_OUT, "fm1_web_chips.wasm"));

export function verifyEngineFile(path, { rustc = null } = {}) {
  const bytes = readFileSync(path);
  const module = new WebAssembly.Module(bytes);
  const exports = WebAssembly.Module.exports(module).map((e) => e.name).sort();
  const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`).sort();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const missing = PIN.expectedExports.filter((n) => !exports.includes(n));
  const unexpected = exports.filter((n) => !PIN.expectedExports.includes(n));
  const importsOk = JSON.stringify(imports) === JSON.stringify(PIN.expectedImports);
  if (rustc === null) {                       // the build record written next to the engine says which toolchain built it
    const rec = resolve(dirname(path), "BUILD-RECORD.json");
    if (existsSync(rec)) rustc = JSON.parse(readFileSync(rec, "utf8")).toolchain?.rustc ?? null;
  }
  const known = rustc ? PIN.toolchains[rustc] : undefined;
  const hash = known ? (known.patchedWasmSha256 === sha256 ? "match" : "MISMATCH") : "unverified-toolchain";
  const exportsOk = !missing.length && !unexpected.length;
  return { path, sha256, bytes: bytes.length, exports, imports, missing, unexpected, importsOk, exportsOk, rustc, hash, ok: exportsOk && importsOk && hash !== "MISMATCH" };
}
