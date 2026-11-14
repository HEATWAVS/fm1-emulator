#!/usr/bin/env node
// Reproducible build of the chip-profile test engine: the pinned upstream fm1-emu v0.3.0 source + chip-profiles.patch
// + tables generated from the Stage A spec (ci/machine/chipspec.mjs), built with upstream's own web recipe.
//
//   node ci/engine/build.mjs --upstream <path to a clone of joakimeriksson/fm1-emu>      (recommended: no network)
//   node ci/engine/build.mjs                                                            (clones the pinned tag from GitHub into ci/engine/out/)
//   options: --out DIR (default ci/engine/out, gitignored)   --url URL (clone source)   --test (also run the Rust host tests + oracle replay)
//
// Output (all under --out, never committed): fm1_web_chips.wasm, BUILD-RECORD.json, src/ (the patched tree), target/.
// The shipped site/emulator/fm1_web.wasm is never read or written here. Needs: node, git, rustc/cargo with the
// wasm32-unknown-unknown target (and the host target for --test). Nothing is installed for you.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PIN, DEFAULT_OUT, verifyEngineFile } from "./verify.mjs";
import { renderTables } from "./tables.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sha = (b) => createHash("sha256").update(b).digest("hex");
function fail(msg) { console.error(`engine build: ${msg}`); process.exit(1); }
const argv = process.argv.slice(2);
const opt = { out: DEFAULT_OUT, url: PIN.upstream.url, upstream: null, test: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--test") opt.test = true;
  else if (a === "--out" || a === "--url" || a === "--upstream") { if (argv[i + 1] === undefined) fail(`${a} needs a value`); opt[a.slice(2)] = argv[++i]; }
  else fail(`unknown option ${a} (see the header of ci/engine/build.mjs)`);
}
opt.out = resolve(opt.out);
const step = (n, text) => console.log(`\n[${n}/9] ${text}`);
const out = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, ...o }).trim();
const tool = (cmd, args) => { try { return out(cmd, args, { stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };

// ------------------------------------------------------------------ 1 preflight
step(1, "toolchain");
const rustcLine = tool("rustc", ["--version"]), cargoLine = tool("cargo", ["--version"]), gitLine = tool("git", ["--version"]);
if (!rustcLine || !cargoLine) fail("rustc/cargo not found on PATH (this script installs nothing)");
if (!gitLine) fail("git not found on PATH");
const targetLib = tool("rustc", ["--print", "target-libdir", "--target", "wasm32-unknown-unknown"]);
if (!targetLib || !existsSync(targetLib)) fail("the wasm32-unknown-unknown target is not installed (rustup target add wasm32-unknown-unknown)");
console.log(`  ${rustcLine}\n  ${cargoLine}\n  ${gitLine}`);

// ------------------------------------------------------------------ 2 patch integrity
step(2, "the patch");
const patchPath = resolve(here, PIN.patch.file), patchBytes = readFileSync(patchPath);
if (sha(patchBytes) !== PIN.patch.sha256) fail(`${PIN.patch.file} has sha256 ${sha(patchBytes)}, pin.json expects ${PIN.patch.sha256}`);
console.log(`  ${PIN.patch.file} sha256 ${PIN.patch.sha256.slice(0, 16)}... ok`);

// ------------------------------------------------------------------ 3 the pinned upstream source
step(3, `upstream ${PIN.upstream.tag} (${PIN.upstream.commit.slice(0, 12)})`);
mkdirSync(opt.out, { recursive: true });
let upstream = opt.upstream && resolve(opt.upstream);
if (!upstream) {
  upstream = resolve(opt.out, "upstream");
  if (!existsSync(upstream)) {
    console.log(`  cloning ${opt.url} (tag ${PIN.upstream.tag})`);
    execFileSync("git", ["clone", "--quiet", "--no-checkout", "--branch", PIN.upstream.tag, opt.url, upstream], { stdio: "inherit" });
  }
}
const head = tool("git", ["-C", upstream, "rev-parse", `${PIN.upstream.commit}^{commit}`]);
if (head !== PIN.upstream.commit) fail(`${upstream} does not contain the pinned commit ${PIN.upstream.commit}`);
console.log(`  commit ${head} present (read from git objects; the clone's working tree is not used)`);

// ------------------------------------------------------------------ 4 export the trimmed workspace (LF blobs)
step(4, `exporting ${PIN.workspaceFiles.length} files of the trimmed workspace (${PIN.workspaceMembers.length} crates)`);
const src = resolve(opt.out, "src");
rmSync(src, { recursive: true, force: true });
const blob = (path) => execFileSync("git", ["-C", upstream, "cat-file", "blob", `${PIN.upstream.commit}:${path}`], { maxBuffer: 1 << 28 });
for (const f of PIN.workspaceFiles) {
  const to = resolve(src, f);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, blob(f));
}
const toml = blob("Cargo.toml").toString("utf8").replace(/\r\n/g, "\n");
const trimmed = toml.replace(/members = \[[\s\S]*?\]\n(?:#[^\n]*\n)?exclude = \[[^\]]*\]/, `members = [${PIN.workspaceMembers.map((m) => `"${m}"`).join(", ")}]`);
if (trimmed === toml) fail("the upstream root Cargo.toml has an unexpected shape");
writeFileSync(resolve(src, "Cargo.toml"), trimmed);
console.log("  root Cargo.toml: workspace members trimmed (the others need crates.io); no Cargo.lock (cargo writes one; these crates have no external dependencies)");

// ------------------------------------------------------------------ 5 apply the patch
step(5, "applying chip-profiles.patch");
const gitEnv = { ...process.env, GIT_CEILING_DIRECTORIES: opt.out };           // never let git find this repository from the build tree
const apply = (args) => execFileSync("git", ["-c", "core.autocrlf=false", "apply", ...args, patchPath], { cwd: src, env: gitEnv, stdio: "inherit" });
apply(["--check"]);
apply([]);
console.log("  applied cleanly (fm1-soc: lib.rs, spiflash.rs, periph.rs, machine.rs changed, spichip.rs and tests/chip_oracle.rs new; fm1-web: lib.rs changed)");

// ------------------------------------------------------------------ 6 generated tables
step(6, "generating spichip_tables.rs from ci/machine/chipspec.mjs");
const tables = renderTables();
if (sha(tables) !== PIN.generatedTablesSha256) fail(`generated tables sha256 ${sha(tables)} differs from pin.json (${PIN.generatedTablesSha256}): the Stage A spec changed. Review it, rebuild, then update generatedTablesSha256 and the toolchain hashes in pin.json.`);
writeFileSync(resolve(src, "crates/fm1-soc/src/spichip_tables.rs"), tables);
console.log(`  sha256 ${sha(tables).slice(0, 16)}... matches pin.json`);

// ------------------------------------------------------------------ 7 build
step(7, "building (upstream's web recipe, trimmed workspace)");
const env = { ...process.env, ...PIN.recipe.env };
const run = (args, extraEnv = {}) => {
  const r = spawnSync("cargo", args, { cwd: src, env: { ...env, ...extraEnv }, stdio: "inherit" });
  if (r.status !== 0) fail(`cargo ${args[0]} failed (exit ${r.status})`);
};
run(["build", "--release", "-p", "fm1-web", "--target", "wasm32-unknown-unknown", "--target-dir", resolve(opt.out, "target"), "--offline"]);
const engine = resolve(opt.out, "fm1_web_chips.wasm");
copyFileSync(resolve(opt.out, "target/wasm32-unknown-unknown/release/fm1_web.wasm"), engine);

// ------------------------------------------------------------------ 8 verify
step(8, "verifying the artifact");
const v = verifyEngineFile(engine, { rustc: rustcLine });
console.log(`  sha256 ${v.sha256}  (${v.bytes} bytes)`);
console.log(`  exports ${v.exports.length}: ${v.exportsOk ? "exactly the expected set" : `MISSING ${v.missing} UNEXPECTED ${v.unexpected}`}; imports ${v.importsOk ? "as expected" : "DIFFER"}`);
console.log(`  hash: ${v.hash === "match" ? "matches the verified hash for this toolchain" : v.hash === "MISMATCH" ? "DOES NOT MATCH the verified hash for this toolchain" : `no verified hash for "${rustcLine}" in pin.json (exports still checked); add one after review`}`);
const record = { builtWith: "ci/engine/build.mjs", toolchain: { rustc: rustcLine, cargo: cargoLine }, upstream: { ...PIN.upstream, usedClone: upstream }, patchSha256: PIN.patch.sha256, tablesSha256: PIN.generatedTablesSha256, artifact: { file: "fm1_web_chips.wasm", sha256: v.sha256, bytes: v.bytes }, exports: v.exports.length, hashCheck: v.hash };
writeFileSync(resolve(opt.out, "BUILD-RECORD.json"), JSON.stringify(record, null, 2) + "\n");
if (!v.ok) fail("verification failed (see above)");

// ------------------------------------------------------------------ 9 optional Rust tests
step(9, opt.test ? "Rust host tests + oracle replay (--test)" : "Rust host tests skipped (add --test to run them)");
if (opt.test) {
  const oracle = resolve(opt.out, "oracle.txt");
  execFileSync(process.execPath, [resolve(here, "gen-transcripts.mjs"), oracle, "--with-ruid", "--with-fault"], { stdio: "inherit" });
  run(["test", "--workspace", "--offline", "--target-dir", resolve(opt.out, "target-host"), "--", "--include-ignored"], { FM1_CHIP_ORACLE: oracle, RUSTFLAGS: "" });
}
console.log(`\nbuilt ${engine}\nsha256 ${v.sha256}`);
