import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const MAGIC = Buffer.from('MSGR1', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
let encryptionKey: Buffer | undefined;

interface DpapiModule {
  Dpapi: {
    protectData(data: Buffer, entropy: null, scope: 'CurrentUser'): Uint8Array;
    unprotectData(data: Uint8Array, entropy: null, scope: 'CurrentUser'): Uint8Array;
  };
  isPlatformSupported: boolean;
}

function validateFields(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid credential payload.');
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, field]) => typeof field === 'string')) throw new Error('Invalid credential payload.');
  return Object.fromEntries(entries) as Record<string, string>;
}

export function configureCredentialEncryptionKey(value: Buffer | string): void {
  const key = typeof value === 'string' ? Buffer.from(value, 'hex') : Buffer.from(value);
  if (key.length !== 32) throw new Error('Credential encryption requires a 32-byte key.');
  encryptionKey = key;
}

export function isLegacyCredentialBlob(blob: Buffer): boolean {
  return !blob.subarray(0, MAGIC.length).equals(MAGIC);
}

function activeKey(): Buffer {
  if (encryptionKey) return encryptionKey;
  // Unit tests do not boot the Electron shell. Give them a deterministic, process-local key;
  // production and normal development must explicitly provide one through startServer.
  if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') {
    encryptionKey = crypto.createHash('sha256').update('misgeret-test-credential-key').digest();
    return encryptionKey;
  }
  throw new Error('Credential encryption key is not configured.');
}

function decryptLegacyWindowsDpapi(blob: Buffer): Record<string, string> {
  if (process.platform !== 'win32') {
    throw Object.assign(new Error('This credential was protected on another Windows installation.'), {
      code: 'CREDENTIALS_UNAVAILABLE',
    });
  }
  try {
    const legacy = require('@primno/dpapi') as DpapiModule;
    if (!legacy.isPlatformSupported) throw new Error('DPAPI is unavailable.');
    const decrypted = legacy.Dpapi.unprotectData(new Uint8Array(blob), null, 'CurrentUser');
    return validateFields(JSON.parse(Buffer.from(decrypted).toString('utf8')));
  } catch (error) {
    throw Object.assign(new Error('Stored credentials could not be unlocked on this computer.', { cause: error }), {
      code: 'CREDENTIALS_UNAVAILABLE',
    });
  }
}

/** Versioned, authenticated encryption. The master key is protected by Electron safeStorage. */
export function encryptCredentials(fields: Record<string, string>): Buffer {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', activeKey(), iv);
  cipher.setAAD(MAGIC);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(validateFields(fields)), 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptCredentials(blob: Buffer): Record<string, string> {
  if (isLegacyCredentialBlob(blob)) return decryptLegacyWindowsDpapi(blob);
  if (blob.length <= MAGIC.length + IV_BYTES + TAG_BYTES) throw new Error('Invalid credential blob.');
  const ivStart = MAGIC.length;
  const tagStart = ivStart + IV_BYTES;
  const dataStart = tagStart + TAG_BYTES;
  const decipher = crypto.createDecipheriv('aes-256-gcm', activeKey(), blob.subarray(ivStart, tagStart));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(blob.subarray(tagStart, dataStart));
  const plaintext = Buffer.concat([decipher.update(blob.subarray(dataStart)), decipher.final()]);
  return validateFields(JSON.parse(plaintext.toString('utf8')));
}

function legacyFile(dataDir: string): string {
  return path.join(dataDir, 'credentials.enc');
}

/** Phase 1 stored one encrypted blob at data/credentials.enc. Returns raw bytes or null. */
export function readLegacyCredentialsFile(dataDir: string): Buffer | null {
  const file = legacyFile(dataDir);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

export function deleteLegacyCredentialsFile(dataDir: string): void {
  fs.rmSync(legacyFile(dataDir), { force: true });
}
