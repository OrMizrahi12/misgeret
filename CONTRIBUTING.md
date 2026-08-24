# Contributing to Misgeret

Thank you for helping build a local-first financial tool for Israeli households.

## Before you start

- Search existing issues and open a focused issue for substantial behavior or data-model changes.
- Start with [`good first issue`](https://github.com/OrMizrahi12/misgeret/labels/good%20first%20issue) or [`help wanted`](https://github.com/OrMizrahi12/misgeret/labels/help%20wanted) if you are new to the project.
- Comment on the issue you want to work on and wait for a maintainer to confirm the scope before investing in a substantial implementation.
- Use [GitHub Discussions](https://github.com/OrMizrahi12/misgeret/discussions) for questions and early ideas that are not yet actionable issues.
- Use synthetic data for development, screenshots, tests, and bug reports.
- Read [Development](docs/development.md), [Architecture](docs/architecture.md), and [Privacy and security](docs/privacy-and-security.md).
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Privacy is part of correctness

Never commit or upload real financial data, institution credentials, browser profiles, application-data directories, `.env` files, encryption keys, logs, exports, backups, screenshots with personal data, or generated installers.

Changes that add network access, change credential handling, move data between profiles, or alter backup/restore behavior must document the trust boundary and include tests.

## Development

```powershell
npm ci
npm run dev
```

Use the guarded showcase environment described in [Development](docs/development.md#safe-synthetic-data-mode). Before opening a pull request:

```powershell
npm run verify
```

## Pull requests

- Create a branch in your fork and open a pull request against `main`; direct changes to `main` are not accepted.
- Keep one coherent change per pull request.
- Explain the user-visible behavior and the reason for it.
- List verification commands and their results.
- Describe any local-data, migration, credential, network, export, or backup impact.
- Add or update tests for behavior changes.
- Update public documentation and screenshots when a screen or claim changes.

Maintainers may ask for a smaller change or additional privacy and migration evidence before merging.

## Licensing

No contributor license agreement is required. By submitting a contribution, you agree that it may be distributed under the project's [MIT License](LICENSE).
