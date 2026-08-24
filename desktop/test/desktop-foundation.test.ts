import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Screen } from 'electron';
import { DESKTOP_COMMANDS } from '../src/contracts.js';
import { publicUtilityError, redactForLog, RedactedLogger } from '../src/logger.js';
import { restoreWindowState } from '../src/window-state.js';

test('desktop commands are unique and stable', () => {
  assert.equal(new Set(DESKTOP_COMMANDS).size, DESKTOP_COMMANDS.length);
  assert.ok(DESKTOP_COMMANDS.includes('refresh'));
  assert.ok(DESKTOP_COMMANDS.includes('navigate-health'));
});
test('desktop logger removes credentials and personal identifiers', () => {
  const result = JSON.stringify(redactForLog({
    password: 'top-secret',
    token: 'bearer-token',
    email: 'person@example.com',
    accountNumber: '123456789',
    path: process.platform === 'win32'
      ? path.join('C:\\Users', 'finance-owner', 'Misgeret')
      : path.join('/home', 'finance-owner', 'Misgeret'),
  }));
  for (const sensitive of ['top-secret', 'bearer-token', 'example.com', '123456789', 'finance-owner']) {
    assert.equal(result.includes(sensitive), false, `log retained ${sensitive}`);
  }
});

test('desktop JSONL logs never persist raw errors, full URLs, or financial identifiers', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-redacted-log-'));
  const logger = new RedactedLogger(directory);
  const upstream = Object.assign(new Error(
    'password=hunter2 username=bank-owner account number=9988776655 '
      + 'transaction description=private pharmacy purchase '
      + 'https://bank.example/api/transactions?token=url-secret&account=9988776655',
  ), { code: 'BANK_SYNC_FAILED' });

  try {
    logger.info(
      'request https://bank.example/private?username=bank-owner&password=hunter2',
      {
        note: 'password=hunter2; username=bank-owner; account=9988776655; '
          + 'transaction description=private pharmacy purchase',
        requestUrl: 'https://bank.example/api/transactions?token=url-secret&account=9988776655',
        username: 'bank-owner',
        accountNumber: '9988776655',
        transactionDescription: 'private pharmacy purchase',
      },
    );
    logger.error('bank-sync-failed', upstream, { endpoint: 'https://bank.example/login?token=url-secret' });

    const jsonl = fs.readFileSync(path.join(directory, 'desktop.jsonl'), 'utf8');
    for (const sensitive of [
      upstream.message,
      'hunter2',
      'bank-owner',
      '9988776655',
      'private pharmacy purchase',
      'url-secret',
      'bank.example',
      'https://bank.example/api/transactions?token=url-secret&account=9988776655',
    ]) {
      assert.equal(jsonl.includes(sensitive), false, `JSONL retained ${sensitive}`);
    }

    const entries = jsonl.trim().split('\n').map((line) => JSON.parse(line) as {
      metadata: { error?: { name: string; message: string; code: string } };
    });
    assert.deepEqual(entries[1]?.metadata.error, {
      name: 'Error',
      message: 'Operation failed.',
      code: 'BANK_SYNC_FAILED',
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('utility public errors expose only a safe code and fixed phase message', () => {
  const rawMessage = 'password=hunter2 at https://bank.example/login?token=url-secret';
  const startup = publicUtilityError(Object.assign(new Error(rawMessage), { code: 'BANK_START_FAILED' }), 'startup');
  const runtime = publicUtilityError({ code: 'BAD code: username=bank-owner', message: rawMessage }, 'runtime');

  assert.deepEqual(startup, {
    code: 'BANK_START_FAILED',
    message: 'The local finance runtime could not start.',
  });
  assert.deepEqual(runtime, {
    code: 'RUNTIME_ERROR',
    message: 'The local finance runtime stopped unexpectedly.',
  });
  assert.equal(JSON.stringify({ startup, runtime }).includes('hunter2'), false);
  assert.equal(JSON.stringify({ startup, runtime }).includes('bank.example'), false);
  assert.equal(JSON.stringify({ startup, runtime }).includes('bank-owner'), false);
});

test('off-screen window state is replaced with visible primary-display bounds', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-window-state-'));
  const file = path.join(directory, 'window-state.json');
  fs.writeFileSync(file, JSON.stringify({ x: 9000, y: 9000, width: 1400, height: 900, maximized: true }));
  const fakeScreen = {
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  } as unknown as Screen;

  try {
    const state = restoreWindowState(fakeScreen, file);
    assert.equal(state.maximized, false);
    assert.ok(state.x >= 0 && state.y >= 0);
    assert.ok(state.x + state.width <= 1920);
    assert.ok(state.y + state.height <= 1080);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
