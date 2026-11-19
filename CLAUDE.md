# Project instructions

## Priority
Engineering correctness and reliability come first. Token efficiency must come from avoiding
duplicated work, never from reducing the quality of research, implementation, or verification.

## Efficient development and token usage
Work efficiently without compromising engineering quality.

### Reuse what is already known
- Use the existing project documentation, decisions, and test results instead of repeatedly
  rediscovering information.
- Do not repeat completed research unless new evidence or a technical problem requires it.
- Read only the source files necessary for the current task. Expand the investigation when
  evidence indicates it is necessary.

### Scope
- Work on one approved component at a time. Do not implement future components prematurely.
- Prefer small, verifiable changes over large implementations.
- If a task becomes unusually complex, explain why before expanding the investigation.

### Correctness (never traded for tokens)
- Never skip necessary tests, source verification, compatibility checks, or code reviews to save tokens.
- Never substitute assumptions for evidence, and never claim a feature works without testing it.

### Reporting
- Avoid unnecessary explanations, repeated summaries, and large dumps of unchanged source code.
- Keep reports concise but include relevant evidence, file paths, test results, risks, and
  unresolved questions.

### Project documents
- Maintain PROJECT-PLAN.md, CURRENT-STATUS.md, ARCHITECTURE.md, DECISIONS.md, and TESTING.md as
  appropriate. They live in `docs/dev/`.
- Preserve important technical findings there so future sessions can continue without repeating
  research.

## Engines and chip test modes (Component 8)
- Default runs the optimized unified engine `site/emulator/fm1_web_frodhes_optimized.wasm` with the CPU optimization switched on (D109). The shipped `site/emulator/fm1_web.wasm` is never rebuilt or replaced here: it draws the front panel (`fm1_skin`) and is the *Previous engine* reference mode. The unified engine `site/emulator/fm1_web_unified.wasm` runs the chip test modes; both are built by `ci/engine/build.mjs --optimized` from pinned sources (`ci/engine/pin.json`) and their hashes are pinned by quick-tier tests. Provenance and licence notes: `docs/dev/ARCHITECTURE.md`, `DECISIONS.md` D94-D99.
- Chip test sessions never touch saved patches (ephemeral). Never claim a chip profile matches a physical chip: both are datasheet-based reference profiles.
- Never access the separate FM1 Firmware project. Never push.

## Permanent project rule: Emulator, not firmware
The objective is to improve the FM-1 emulator, never to fix or modify individual firmware.
- Treat Frodhes, X0X, Melodee, stock firmware, and other firmware as unmodified test inputs.
- All fixes, optimizations, and performance improvements must target the emulator itself.
- Never modify, patch, rewrite, or optimize firmware code or firmware behavior to work around emulator problems.
- Differences in firmware execution should be used to identify weaknesses in the emulator.
- Emulator improvements should preserve correct emulated behavior and work reliably across different firmware workloads.
- Do not sacrifice one firmware's performance or correctness unnecessarily to improve another.
