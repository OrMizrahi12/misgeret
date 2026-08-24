# Misgeret Roadmap

Misgeret is a community-maintained, local-first financial desktop application for Israeli households. This roadmap describes the direction of the project, not fixed delivery dates or promises.

The issue tracker is the source of truth for work that is ready to be picked up. Before starting a substantial change, open or comment on an issue so scope and privacy implications can be agreed first.

## Now: strengthen the public foundation

- Improve reliability across supported banks and card providers as their websites change.
- Expand deterministic tests around imports, reconciliation, recurring patterns, backups, and profile isolation.
- Improve keyboard navigation, focus states, RTL accessibility, and screen-reader semantics.
- Keep the synthetic demo profile, screenshots, product tour, and public documentation representative of the current application.
- Make contributor onboarding predictable on Windows, macOS, and Linux.

## Next: safer and smoother distribution

- Add Windows code signing and macOS signing/notarization when sustainable project credentials are available.
- Improve install and troubleshooting guidance for macOS and common Linux distributions.
- Strengthen migration, backup, restore, and release-integrity verification.
- Expand platform-specific smoke testing without introducing telemetry or cloud accounts.

## Later: broader community reach

- Make the interface ready for additional languages while preserving first-class Hebrew and RTL support.
- Improve import/export interoperability with transparent, documented formats.
- Define stable extension boundaries for new institutions and community-maintained integrations.
- Grow maintainer documentation and decision records as the contributor base expands.

## Non-negotiable project principles

- No registration, subscription, advertising, analytics, or financial-data cloud.
- Financial data and credentials stay under the user's control on the local computer.
- Tests, screenshots, logs, bug reports, and demos use synthetic or fully redacted data only.
- Security, privacy, profile isolation, and deterministic financial calculations take priority over feature velocity.

## How to participate

- Start with [`good first issue`](https://github.com/OrMizrahi12/misgeret/labels/good%20first%20issue) or [`help wanted`](https://github.com/OrMizrahi12/misgeret/labels/help%20wanted).
- Use [GitHub Discussions](https://github.com/OrMizrahi12/misgeret/discussions) for questions and early ideas.
- Use [Issues](https://github.com/OrMizrahi12/misgeret/issues) for scoped, actionable work.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

