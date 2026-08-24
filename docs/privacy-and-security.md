# Privacy and security

Misgeret is local-first: it has no user-account service and no server that receives or stores your financial history. Local-first does not mean “offline”—a sync must contact the selected institution, and update checks contact GitHub Releases.

## What is stored locally

- imported transactions and balances;
- manual transactions, assets, and liabilities;
- category rules and recurring-item verdicts;
- planning goals, settings, profile metadata, and local backups;
- encrypted institution login fields.

Default application roots:

| Platform | Application data root |
|---|---|
| Windows | `%APPDATA%\Misgeret` |
| macOS | `~/Library/Application Support/Misgeret` |
| Linux | `$XDG_CONFIG_HOME/Misgeret` or `~/.config/Misgeret` |

Each profile database is stored below `data/profiles/<profile-id>/finance.db`. The profile registry is `data/profiles.json`. Backups are stored per profile.

## Credential protection

Institution login fields are serialized into an authenticated AES-256-GCM blob in SQLite. The 256-bit master key is encrypted by Electron `safeStorage` and written as `electron/credential-key.bin` with restrictive file permissions where the platform supports them.

- Windows uses the current user's operating-system protection.
- macOS uses Keychain-backed secure storage.
- Linux requires a secure Secret Service/keyring backend. The packaged app refuses to store a new key when only an insecure plaintext backend is available.

The renderer never receives the master key or stored credential blob. During synchronization, the backend decrypts the selected connection in memory and passes the fields to that institution's scraper.

## Network activity

Misgeret can make these outbound connections:

1. The selected bank, card issuer, or benefit-club website during a user-initiated or configured automatic sync.
2. GitHub Releases for update checks and downloads.
3. Package registries and Chromium download infrastructure only while a developer installs dependencies or prepares a source build.

There is no Misgeret analytics, advertising, telemetry, or financial-data endpoint.

## What is not encrypted

Transaction databases, CSV exports, screenshots, and ordinary local backups are not encrypted by Misgeret. Anyone who can read files as your operating-system user may be able to read them.

Recommended protections:

- enable BitLocker, FileVault, LUKS, or equivalent full-disk encryption;
- protect the operating-system account with a strong password and screen lock;
- avoid placing exports or backups in untrusted cloud-synced folders;
- never attach real databases, logs, screenshots, exports, or credentials to a public issue;
- keep the operating system and Misgeret updated.

## Scraper and supply-chain risk

Institution synchronization automates websites rather than using a guaranteed public API. A website change can break a connection. It can also change the page content a scraper processes. The project mitigates this with version locking, input normalization, redacted logs, a bundled Chromium, automated tests, artifact audits, checksums, and dependency inventories—but cannot eliminate the risk.

Review the source and release checksums before using the application with real credentials. The current desktop binaries are community builds and are not code-signed or notarized.

## Deleting your data

Use the in-app data controls for transaction resets and profile management. Uninstalling the application intentionally leaves user data in the application-data directory. For a complete local removal, close Misgeret, remove its application-data root, and remove any exported files or backups you created elsewhere.

## Responsible disclosure

Do not publish exploit details or real financial data. Follow [SECURITY.md](../SECURITY.md) and use GitHub private vulnerability reporting.
