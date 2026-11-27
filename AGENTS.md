# Project instructions

- **Live Occipital:** Get explicit approval to install the checkout helper or reload user Pi. Install only with `make build`; test in isolated trees. See [Make shortcuts](docs/testing.md#make-shortcuts).
- **Docs:** Update affected [technical docs](docs/README.md) and links in the same task. Report which docs changed or that none did.
- **Tests:** Before selecting checks, read [docs/testing.md](docs/testing.md) and follow its preparation, cadence and real-input requirements. Report failed or unrun required checks; skips do not pass.
- **Commits:** Use Conventional Commits; mark breaks with `!` or `BREAKING CHANGE:`. Before every commit, follow the [changelog checklist](docs/releases.md#changelogs-and-release-notes). For internal/test-only changes, report why no entry is needed.

Subagents are optional for implementation.
