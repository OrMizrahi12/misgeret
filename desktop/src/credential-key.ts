import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface SafeStorageAdapter {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
  getSelectedStorageBackend?(): string;
}

const KEY_PATTERN = /^[0-9a-f]{64}$/;

/** Loads or creates the database credential key. Only the safeStorage-wrapped value touches disk. */
export async function loadOrCreateCredentialKey(
  directory: string,
  safeStorage: SafeStorageAdapter,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw Object.assign(new Error('Secure credential storage is unavailable on this system.'), {
      code: 'SECURE_STORAGE_UNAVAILABLE',
    });
  }
  const backend = safeStorage.getSelectedStorageBackend?.();
  const secureLinuxBackends = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);
  if (platform === 'linux' && (!backend || !secureLinuxBackends.has(backend))) {
    throw Object.assign(new Error('A system keyring is required to protect financial credentials.'), {
      code: 'SECURE_STORAGE_UNAVAILABLE',
    });
  }

  fs.mkdirSync(directory, { recursive: true });
  const keyPath = path.join(directory, 'credential-key.bin');
  if (fs.existsSync(keyPath)) {
    const decrypted = await safeStorage.decryptStringAsync(fs.readFileSync(keyPath));
    const key = decrypted.result;
    if (!KEY_PATTERN.test(key)) throw new Error('Stored credential key is invalid.');
    if (decrypted.shouldReEncrypt) {
      const replacement = await safeStorage.encryptStringAsync(key);
      const temporary = `${keyPath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, replacement, { mode: 0o600 });
      fs.renameSync(temporary, keyPath);
    }
    return key;
  }

  const key = crypto.randomBytes(32).toString('hex');
  const temporary = `${keyPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, await safeStorage.encryptStringAsync(key), { mode: 0o600 });
  fs.renameSync(temporary, keyPath);
  try { fs.chmodSync(keyPath, 0o600); } catch { /* Windows ACLs are managed by safeStorage. */ }
  return key;
}
