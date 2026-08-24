import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  configureCredentialEncryptionKey,
  decryptCredentials,
  deleteLegacyCredentialsFile,
  encryptCredentials,
  readLegacyCredentialsFile,
} from './credentials.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fincred-'));
}

describe('credential blobs', () => {
  configureCredentialEncryptionKey(Buffer.alloc(32, 7));
  test('encrypt/decrypt round-trip for arbitrary field sets', () => {
    const creds = { id: '012345678', card6Digits: '123456', password: 'p@ss עברית' };
    expect(decryptCredentials(encryptCredentials(creds))).toEqual(creds);
  });

  test('encrypted blob is not plaintext', () => {
    const blob = encryptCredentials({ username: 'u', password: 'secret-marker-123' });
    expect(blob.toString('utf-8')).not.toContain('secret-marker-123');
  });

  test('uses a unique nonce and rejects tampering', () => {
    const first = encryptCredentials({ username: 'u', password: 'p' });
    const second = encryptCredentials({ username: 'u', password: 'p' });
    expect(first.equals(second)).toBe(false);
    first[first.length - 1] ^= 1;
    expect(() => decryptCredentials(first)).toThrow();
  });
});

describe('legacy credentials file (phase 1 format)', () => {
  test('missing file reads as null; delete is a no-op', () => {
    const dir = tempDir();
    expect(readLegacyCredentialsFile(dir)).toBeNull();
    deleteLegacyCredentialsFile(dir); // must not throw
  });

  test('reads raw encrypted bytes that decrypt with decryptCredentials, then deletes', () => {
    const dir = tempDir();
    const blob = encryptCredentials({ username: 'u', password: 'p' });
    fs.writeFileSync(path.join(dir, 'credentials.enc'), blob);

    const read = readLegacyCredentialsFile(dir);
    expect(read).not.toBeNull();
    expect(decryptCredentials(read!)).toEqual({ username: 'u', password: 'p' });

    deleteLegacyCredentialsFile(dir);
    expect(readLegacyCredentialsFile(dir)).toBeNull();
  });
});
