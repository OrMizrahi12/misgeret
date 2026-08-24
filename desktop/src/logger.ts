import fs from 'node:fs';
import path from 'node:path';

const SENSITIVE_KEY = /(authorization|cookie|credential|password|passcode|secret|token|username|account|transaction|description)/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const LONG_NUMBER = /(?<!\d)\d{6,}(?!\d)/g;
const WINDOWS_USER_PATH = /([A-Z]:\\Users\\)[^\\]+/gi;
const POSIX_USER_PATH = /(\/(?:home|Users)\/)[^/]+/g;
const URL = /\b(?:https?|file):\/\/[^\s"'<>]+/gi;
const BEARER_TOKEN = /\bBearer\s+[^\s,;]+/gi;
const SENSITIVE_ASSIGNMENT = /\b(authorization|cookie|credential|password|passcode|secret|token|username|account(?:\s*(?:number|id))?|transaction(?:\s*description)?|description)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n,;]+)/gi;
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export type UtilityErrorPhase = 'startup' | 'shutdown' | 'runtime';

const PUBLIC_UTILITY_MESSAGES: Record<UtilityErrorPhase, string> = {
  startup: 'The local finance runtime could not start.',
  shutdown: 'The local finance runtime could not close cleanly.',
  runtime: 'The local finance runtime stopped unexpectedly.',
};

function redactString(value: string): string {
  return value
    .slice(0, 2_000)
    .replace(URL, '[REDACTED_URL]')
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT, (_match, label: string) => `${label}=[REDACTED]`)
    .replace(EMAIL, '[REDACTED_EMAIL]')
    .replace(LONG_NUMBER, '[REDACTED_NUMBER]')
    .replace(WINDOWS_USER_PATH, '$1[REDACTED_USER]')
    .replace(POSIX_USER_PATH, '$1[REDACTED_USER]');
}

function safeErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'RUNTIME_ERROR';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? code : 'RUNTIME_ERROR';
}

export function publicUtilityError(
  error: unknown,
  phase: UtilityErrorPhase,
): { code: string; message: string } {
  return {
    code: safeErrorCode(error),
    message: PUBLIC_UTILITY_MESSAGES[phase],
  };
}

export function redactForLog(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => redactForLog(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 40)
        .map(([entryKey, entryValue]) => [entryKey, redactForLog(entryValue, entryKey)]),
    );
  }
  return value;
}
export class RedactedLogger {
  private readonly filePath: string;

  constructor(logsDir: string) {
    fs.mkdirSync(logsDir, { recursive: true });
    this.filePath = path.join(logsDir, 'desktop.jsonl');
  }

  info(event: string, metadata: Record<string, unknown> = {}): void {
    this.write('info', event, metadata);
  }

  warn(event: string, metadata: Record<string, unknown> = {}): void {
    this.write('warn', event, metadata);
  }

  error(event: string, error: unknown, metadata: Record<string, unknown> = {}): void {
    const normalized = error instanceof Error
      ? {
          name: SAFE_ERROR_NAME.test(error.name) ? error.name : 'Error',
          message: 'Operation failed.',
          code: safeErrorCode(error),
        }
      : { name: 'NonError', message: 'Operation failed.', code: safeErrorCode(error) };
    this.write('error', event, { ...metadata, error: normalized });
  }

  private write(level: 'info' | 'warn' | 'error', event: string, metadata: Record<string, unknown>): void {
    try {
      this.rotateIfNeeded();
      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event: redactString(String(event).slice(0, 120)),
        metadata: redactForLog(metadata),
      });
      fs.appendFileSync(this.filePath, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Logging must never take down the finance runtime.
    }
  }

  private rotateIfNeeded(): void {
    if (!fs.existsSync(this.filePath) || fs.statSync(this.filePath).size < MAX_LOG_BYTES) return;
    const previous = `${this.filePath}.1`;
    fs.rmSync(previous, { force: true });
    fs.renameSync(this.filePath, previous);
  }
}
