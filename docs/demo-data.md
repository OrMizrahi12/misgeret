# Synthetic demo data and screenshots

The public screenshots are generated from the real Misgeret renderer and local API. They are not hand-built mockups and do not contain a real person's information.

## Dataset

`MOCK_PROFILE=showcase` creates deterministic institution responses with:

- 24 visible months, from a requested institution history window;
- two fictional salaries;
- mortgage, municipal tax, childcare, utilities, insurance, groceries, transfers, and card settlements;
- card purchases across food, transport, shopping, health, home, leisure, and fitness;
- recurring Netflix, Spotify, YES, cellular, and gym examples;
- an installment plan and pending transaction.

`scripts/seed_showcase.mjs` adds local declarations that an institution cannot provide:

- profile name `משפחת ישראלי — הדגמה`;
- a 20% monthly savings target;
- emergency-buffer, family-holiday, and restaurant-reduction goals;
- fictional apartment, deposit, securities, training fund, mortgage, and car-loan balances;
- explicit recurring-pattern verdicts.

Every name, amount, identifier, and credential in the showcase environment is fictional.

## Safety gate

The seeder refuses to run unless `SEED_SYNTHETIC_DATA=1` is set. This is an acknowledgement, not isolation by itself. Always start the API with a new dedicated `DATA_DIR` and `MOCK_BANK=1`.

## Reproducing the gallery

1. Start the isolated showcase environment as described in [Development](development.md#safe-synthetic-data-mode).
2. Run the seeder twice. The second run should report that connections, goals, and assets already exist; this proves the process is idempotent.
3. Run:

   ```powershell
   node scripts/capture_site_shots.mjs
   ```

4. Confirm all 13 PNG files exist at 2880×1800 and inspect them visually before publication.

The capture is performed inside headless Chromium. It contains only the app viewport—no OS username, taskbar, mouse pointer, screen-control border, or desktop notification can enter the frame.

## Current screenshot set

`home`, `month`, `plan`, `year`, `overview`, `patterns`, `future`, `health`, `networth`, `connections`, `settings`, `profiles`, and `review`.

When adding or removing an application route, update the capture list and the README gallery in the same pull request.
