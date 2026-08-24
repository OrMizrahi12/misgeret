# Architecture

Misgeret is a local desktop application with a deliberately small trust boundary. The UI, local API, financial database, scraper runtime, and update client run on the user's computer. There is no Misgeret account service or financial-data backend.

## Runtime components

```text
React renderer
    │ loopback HTTP + per-launch capability token
    ▼
Local Express API ─────► per-profile SQLite database
    │
    ├────► bundled Chromium + israeli-bank-scrapers ─────► institution website
    │
    └────► encrypted credential blobs
                 ▲
Electron main ───┴──── OS safeStorage / keyring
    │
    └────────────► GitHub Releases (update checks)
```

### Electron main process

The main process owns application lifecycle, the native window, secure storage, file dialogs, updater operations, and a narrow IPC bridge. Renderer Node integration is disabled, context isolation is enabled, and Electron fuses restrict unsupported execution paths.

### Renderer

The renderer is a React and Vite application. It renders the Hebrew interface and talks only to the local API. It does not receive database paths, encryption keys, or raw credential blobs.

### Local API

The Express backend binds to loopback and is launched with a random capability token. Desktop requests must carry that token. Destructive desktop operations use an additional authorization boundary. Browser-based development mode is supported for testing, but the packaged app keeps the server private to the desktop runtime.

### Data layer

Each profile has an independent SQLite database under `data/profiles/<uuid>/finance.db`. The profile registry selects the active database; no cross-profile tables are shared. SQLite backup APIs and atomic replacement are used for backup and restore flows.

### Institution synchronization

Misgeret uses [`israeli-bank-scrapers`](https://github.com/eshaham/israeli-bank-scrapers) with a bundled, version-matched Chromium. Credentials are decrypted only for the duration of a sync and are passed to the selected institution scraper. The result is normalized before it reaches the database.

Institution websites are not stable APIs. Selectors, authentication flows, and available history can change without notice. Known outages are surfaced in the connection picker instead of being hidden behind a generic timeout.

## Data pipeline

1. Fetch completed and pending transactions from each connected institution.
2. Normalize dates, amounts, currencies, account identity, installment metadata, and issuer categories.
3. Deduplicate rows across repeated syncs.
4. Reconcile card transactions with the matching bank settlement.
5. Exclude proven internal transfers and user-declared savings movements from spending totals.
6. Apply user rules, issuer categories, deterministic classification, and a reviewable `other` floor.
7. Derive monthly summaries, recurring patterns, forecasts, goals, health metrics, and net worth.

Derived views are recomputed from stored facts. User verdicts—such as whether a recurring merchant is a subscription, fixed commitment, or habit—remain separate from detector suggestions.

## Build and release

- Electron Forge packages Windows Squirrel, macOS DMG/ZIP, Linux DEB, and Linux RPM artifacts.
- Native `better-sqlite3` binaries and Chromium are staged for the target platform.
- The artifact audit rejects source files, test data, logs, databases, environment files, and developer metadata.
- Tagged releases are built on GitHub Actions for Windows x64, macOS arm64/x64, and Linux x64.
- Each release includes aggregate SHA-256 checksums. Release metadata generation also produces third-party notices and a CycloneDX SBOM for local audits.

## Important boundaries

- Misgeret is not an Open Banking provider and is not licensed as an Israeli financial-information service.
- The local transaction database is not encrypted at rest.
- Windows and macOS packages are currently unsigned; see the installation warning in the main README.
- The app is read-only with respect to bank activity. It does not transfer money or submit financial actions.
