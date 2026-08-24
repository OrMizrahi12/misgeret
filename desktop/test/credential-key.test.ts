import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadOrCreateCredentialKey, type SafeStorageAdapter } from '../src/credential-key.js';

function fixture(backend = 'gnome_libsecret', shouldReEncrypt = false): SafeStorageAdapter {
  return {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(value) { return Buffer.from(`wrapped:${value}`, 'utf8'); },
    async decryptStringAsync(value) {
      return { result: value.toString('utf8').replace(/^wrapped:/, ''), shouldReEncrypt };
    },
    getSelectedStorageBackend() { return backend; },
  };
}

test('creates one wrapped 32-byte key and reuses it', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-key-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = await loadOrCreateCredentialKey(directory, fixture(), 'linux');
  const second = await loadOrCreateCredentialKey(directory, fixture(), 'linux');
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(second, first);
  assert.equal(fs.readFileSync(path.join(directory, 'credential-key.bin'), 'utf8').includes(first), true);
});

test('Linux rejects plaintext or unknown safeStorage backends', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-key-'));
  await assert.rejects(loadOrCreateCredentialKey(directory, fixture('basic_text'), 'linux'), {
    code: 'SECURE_STORAGE_UNAVAILABLE',
  });
  await assert.rejects(loadOrCreateCredentialKey(directory, fixture('unknown'), 'linux'), {
    code: 'SECURE_STORAGE_UNAVAILABLE',
  });
});

test('does not overwrite an existing corrupt key wrapper', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-key-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keyPath = path.join(directory, 'credential-key.bin');
  fs.writeFileSync(keyPath, 'wrapped:not-a-key');
  await assert.rejects(loadOrCreateCredentialKey(directory, fixture(), 'linux'), /invalid/i);
  assert.equal(fs.readFileSync(keyPath, 'utf8'), 'wrapped:not-a-key');
});
