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
