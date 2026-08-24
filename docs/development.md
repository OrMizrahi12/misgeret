# Development

## Prerequisites

- Node.js 24 and npm
- Windows x64, macOS x64/arm64, or Linux x64
- Git

Install the exact dependency tree:

```powershell
npm ci
```

## Development server

```powershell
npm run dev
```

- Renderer: `http://localhost:5173`
- Local API: `http://127.0.0.1:3001`

The browser development surface is for local development only. Packaged builds use Electron's isolated renderer and capability-protected loopback API.

## Safe synthetic-data mode

Never develop screenshots or bug reproductions against your real profile. Start the server with a dedicated data directory:

```powershell
$env:DATA_DIR="$PWD\.demo-data"
$env:MOCK_BANK='1'
$env:MOCK_PROFILE='showcase'
$env:PORT='3001'
$env:MISGERET_CREDENTIAL_KEY=('11' * 32)
npm run dev
```

In a second terminal:

```powershell
$env:SEED_SYNTHETIC_DATA='1'
node scripts/seed_showcase.mjs
```

The guard variable is mandatory so the seeder cannot be run accidentally. Use only an isolated `DATA_DIR`.

## Verification

The main gate runs backend tests, typechecks all TypeScript surfaces, desktop tests, script tests, the production builds, and the shared build contract:

```powershell
npm run verify
```

Useful narrower commands:

```powershell
npm test
npm run typecheck
npm run desktop:test
npm run test:scripts
npm run build:desktop
npm run test:build-contract
```

## Desktop packaging

The first package build downloads and verifies the pinned Chromium into `.desktop-resources/`.

```powershell
npm run desktop:package
npm run desktop:make
```

`desktop:make` creates packages only for the host platform and architecture. Cross-platform release artifacts are built by `.github/workflows/release.yml` after a `v*` tag is pushed.

Generated output lives under `out/` and must not be committed.

## Screenshot documentation

With the isolated showcase server running and seeded:

```powershell
node scripts/capture_site_shots.mjs
```

The script captures the real renderer at 1440×900 with a 2× device scale factor, forces the light theme and reduced motion, removes focus and cursor rendering, and writes the 13 current surfaces to `docs/assets/screenshots/`.

## Pull requests

- Keep changes focused and include tests for behavior changes.
- Document any migration or change to local data ownership.
- Never commit real financial information, credentials, application-data folders, exports, backups, logs, keys, or installers.
- Run `npm run verify` and report the result in the pull request.
