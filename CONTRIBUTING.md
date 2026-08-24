# Contributing to Misgeret

Thank you for helping build a local-first financial tool for Israeli households.

## Before you start

- Search existing issues and open a focused issue for substantial behavior or data-model changes.
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

- Keep one coherent change per pull request.
- Explain the user-visible behavior and the reason for it.
- List verification commands and their results.
- Describe any local-data, migration, credential, network, export, or backup impact.
- Add or update tests for behavior changes.
- Update public documentation and screenshots when a screen or claim changes.

Maintainers may ask for a smaller change or additional privacy and migration evidence before merging.
