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

## Documentation

After **every change**, you MUST update the affected technical documentation in the same task. Use [docs/README.md](docs/README.md) to locate the canonical chapters, and keep their descriptions of behavior, internal mechanisms, contracts, limitations and design rationale consistent with the current implementation. Update affected cross-references as well. The task is not complete until these documentation updates are complete; plans, reviews and reports in `.test-artifacts` do not substitute for them.

## Testing

- Before selecting checks, read [docs/testing.md](docs/testing.md) for prepared inputs, contract groups, real integration requirements and GC setup.
- During the edit–test–fix loop, refresh the prepared source snapshot and run the affected `test:group` checks. Before feature delivery, use `test:feature` for the common product baseline plus affected real integrations. Include preparation in the practical 2–3-minute target; report justified overruns instead of reducing coverage.
- Reserve full unit/CLI unions and version/platform matrices for changes whose contract impact requires them, including broad harness, compatibility or release work. Ordinary feature acceptance does not require unrelated full suites.
- Selected native/shared/profile checks require their real prepared inputs. Report required checks that failed or were not run; skips are not acceptance.
