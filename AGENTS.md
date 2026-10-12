# Project Instructions

## Commit Messages

Commit messages must follow the Conventional Commits format:

```text
<type>[optional scope][!]: <description>
```

Examples: `feat: add terminal color synchronization`, `fix: preserve native editor state`, `docs: update the README`.

Use `!` or a `BREAKING CHANGE:` footer to identify breaking changes.

## Delegation

Subagents may be used when implementing tasks. Delegation is permitted, not required.

## Testing

- During the edit–test–fix loop, use `npm run check` and affected `node --test` cases; enable `--expose-gc` for ownership checks. `npm test` runs the full unit/SDK suite; `npm run test:native-release` runs inexpensive packaging/release regressions.
- Reserve the time-expensive full `npm run test:terminal` for final verification after UI/integration work is finished, not each edit or commit. Focused CLI cases may reproduce or verify a concrete defect. Documentation-only changes do not require the full CLI suite.
- For affected syntax integration, the shorter `OCCIPITAL_TEST_BIN=/absolute/path/to/occipital npm run test:syntax-terminal` may run during development and remains in ordinary CI. Full `test:terminal` runs in CI only on extension release tags.
- When choosing test files, CLI scenarios, native checks or runtime/GC setup, read [docs/testing.md](docs/testing.md). Report required checks that failed or were not run; skips are not acceptance.
