import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile, type ExecFileException } from 'node:child_process';
import { utilityProcess, type UtilityProcess } from 'electron';
import type {
  MainToUtilityMessage,
  OperationState,
  RuntimeHandshake,
  UtilityStartConfig,
  UtilityToMainMessage,
} from './contracts.js';
import type { RedactedLogger } from './logger.js';

export interface StartedRuntime {
  origin: string;
  runtime: RuntimeHandshake;
}

export interface KillableUtilityProcess {
  readonly pid?: number;
  kill(): boolean;
}

export type ProcessTreeExecFile = (
  file: string,
  args: string[],
  options: {
    shell: false;
    timeout: number;
    windowsHide: true;
  },
  callback: (error: ExecFileException | null) => void,
) => unknown;

export interface ProcessTreeTerminationDependencies {
  platform?: NodeJS.Platform;
  execFile?: ProcessTreeExecFile;
}

export type ProcessTreeTerminationResult = 'taskkill' | 'child-kill' | 'failed';

function safelyKillChild(child: KillableUtilityProcess): ProcessTreeTerminationResult {
  try {
    child.kill();
    return 'child-kill';
  } catch {
    // The process may have exited between the timeout and this fallback.
    return 'failed';
  }
}

/**
 * Terminates the utility process and all Chromium descendants after graceful
 * shutdown has timed out. The executable and every argument are fixed values;
 * no command string or shell is involved.
 */
export async function terminateUtilityProcessTree(
  child: KillableUtilityProcess,
  dependencies: ProcessTreeTerminationDependencies = {},
): Promise<ProcessTreeTerminationResult> {
  const platform = dependencies.platform ?? process.platform;
  const runExecFile = dependencies.execFile ?? execFile;
  const pid = child.pid;

  if (platform !== 'win32' || !Number.isSafeInteger(pid) || (pid ?? 0) <= 0) {
    return safelyKillChild(child);
  }

  try {
    await new Promise<void>((resolve, reject) => {
      runExecFile(
        'taskkill.exe',
        ['/PID', String(pid), '/T', '/F'],
        { shell: false, timeout: 5_000, windowsHide: true },
        (error) => {
          if (error) reject(error);
          else resolve();
        },
      );
    });
    return 'taskkill';
  } catch {
    return safelyKillChild(child);
  }
}

const BASE_SHUTDOWN_TIMEOUT_MS = 10_000;
const PER_WORKSPACE_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 45_000;

/**
 * Graceful shutdown closes one database per open profile — await-idle, checkpoint(TRUNCATE),
 * close — and a TRUNCATE checkpoint on a large WAL costs seconds on its own. The 10s budget was
 * sized for exactly one database. Expiry hard-kills the whole process tree, and on an update the
 * next thing to touch those WALs is a new binary version, so an under-sized timeout is expensive.
 */
export function shutdownTimeoutMsFor(openWorkspaceCount: number | undefined): number {
  const workspaces = Number.isSafeInteger(openWorkspaceCount) && Number(openWorkspaceCount) >= 1
    ? Number(openWorkspaceCount)
    : 1;
  return Math.min(
    MAX_SHUTDOWN_TIMEOUT_MS,
    BASE_SHUTDOWN_TIMEOUT_MS + PER_WORKSPACE_SHUTDOWN_TIMEOUT_MS * workspaces,
  );
}

export class RuntimeManager extends EventEmitter {
  private child: UtilityProcess | undefined;
  private stateValue: OperationState = 'idle';
  private openWorkspaceCountValue: number | undefined;
  private expectedExit = false;
  private restartAllowance = 1;

  constructor(private readonly logger: RedactedLogger) {
    super();
  }

  get state(): OperationState {
    return this.stateValue;
  }

  /** Last count the runtime reported; undefined until it does. */
  get openWorkspaceCount(): number | undefined {
    return this.openWorkspaceCountValue;
  }

  shutdownTimeoutMs(): number {
    return shutdownTimeoutMsFor(this.openWorkspaceCountValue);
  }

  private recordOpenWorkspaceCount(count: number | undefined): void {
    if (Number.isSafeInteger(count) && Number(count) >= 0) this.openWorkspaceCountValue = count;
  }

  get running(): boolean {
    return this.child?.pid !== undefined;
  }

  takeRestartAllowance(): boolean {
    if (this.restartAllowance <= 0) return false;
    this.restartAllowance -= 1;
    return true;
  }

  async start(config: UtilityStartConfig): Promise<StartedRuntime> {
    if (this.child) throw new Error('RUNTIME_ALREADY_RUNNING');
    this.expectedExit = false;
    this.openWorkspaceCountValue = undefined;
    const entry = path.join(__dirname, 'utility.cjs');
    const env: Record<string, string | undefined> = {
      ...process.env,
      NODE_ENV: 'production',
      // Never forward a development inspector to the finance runtime.
      NODE_OPTIONS: '',
    };
    // Dev/QA toggles must never shape a normal launch: an ambient MOCK_BANK=1 would make the
    // runtime write fabricated transactions into the REAL database. They stay honored only for
    // the isolated smoke profile, which explicitly overrides the data root.
    const smokeSandbox = env.MISGERET_ALLOW_DATA_ROOT_OVERRIDE === '1' && Boolean(env.MISGERET_DATA_ROOT?.trim());
    if (!smokeSandbox) {
      delete env.MOCK_BANK;
      delete env.DATA_DIR;
      delete env.DB_PATH;
    }
    const child = utilityProcess.fork(entry, [], {
      cwd: path.dirname(config.paths.rootDir),
      env,
      execArgv: [],
      serviceName: 'Misgeret Finance Runtime',
      stdio: 'ignore',
    });
    this.child = child;

    return new Promise<StartedRuntime>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.expectedExit = true;
        child.kill();
        reject(Object.assign(new Error('Finance runtime startup timed out.'), { code: 'RUNTIME_TIMEOUT' }));
      }, 30_000);

      const settleError = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.expectedExit = true;
        child.kill();
        reject(error);
      };

      child.on('spawn', () => {
        const message: MainToUtilityMessage = { type: 'start', config };
        child.postMessage(message);
      });

      child.on('message', (candidate: unknown) => {
        const message = candidate as UtilityToMainMessage;
        if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;

        if (message.type === 'state') {
          this.stateValue = message.state;
          this.recordOpenWorkspaceCount(message.openWorkspaceCount);
          this.emit('state', message.state);
          return;
        }
        if (message.type === 'ready') {
          this.stateValue = message.state;
          this.recordOpenWorkspaceCount(message.openWorkspaceCount);
          this.logger.info('runtime.ready', {
            appVersion: message.runtime.appVersion,
            buildId: message.runtime.buildId,
            apiSchemaVersion: message.runtime.apiSchemaVersion,
            dbSchemaVersion: message.runtime.dbSchemaVersion,
          });
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve({ origin: message.origin, runtime: message.runtime });
          }
          this.emit('ready', { origin: message.origin, runtime: message.runtime });
          return;
        }
        if (message.type === 'error') {
          const error = Object.assign(new Error(message.message), { code: message.code, phase: message.phase });
          this.logger.error('runtime.error', error, { phase: message.phase, code: message.code });
          this.emit('runtime-error', error);
          if (message.phase === 'startup') settleError(error);
          return;
        }
        if (message.type === 'stopped') this.emit('stopped');
      });

      child.on('error', (type, location) => {
        const error = Object.assign(new Error(`Utility process fatal error: ${type}`), { code: 'UTILITY_FATAL' });
        this.logger.error('runtime.utility-fatal', error, { location });
        settleError(error);
      });

      child.on('exit', (code) => {
        clearTimeout(timeout);
        if (this.child === child) this.child = undefined;
        this.logger.warn('runtime.exit', { code, expected: this.expectedExit });
        if (!settled) settleError(Object.assign(new Error('Finance runtime exited during startup.'), {
          code: 'RUNTIME_EARLY_EXIT',
        }));
        this.emit('exit', { code, expected: this.expectedExit });
      });
    });
  }

  async stop(reason: 'quit' | 'update' | 'restart', timeoutMs = this.shutdownTimeoutMs()): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.expectedExit = true;

    await new Promise<void>((resolve) => {
      let resolved = false;
      const onMessage = (candidate: unknown): void => {
        if ((candidate as UtilityToMainMessage)?.type === 'stopped') finish();
      };
      const finish = (): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        child.removeListener('message', onMessage);
        resolve();
      };
      const timer = setTimeout(() => {
        this.logger.warn('runtime.shutdown-timeout', { timeoutMs });
        void terminateUtilityProcessTree(child).then((method) => {
          this.logger.warn('runtime.shutdown-forced', { method });
          finish();
        });
      }, timeoutMs);
      child.once('exit', finish);
      child.on('message', onMessage);
      const message: MainToUtilityMessage = { type: 'shutdown', reason };
      child.postMessage(message);
    });
  }
}
