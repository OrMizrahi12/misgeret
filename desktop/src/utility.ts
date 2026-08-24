import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import type {
  MainToUtilityMessage,
  OperationState,
  RuntimeHandshake,
  UtilityStartConfig,
  UtilityToMainMessage,
} from './contracts.js';
import { publicUtilityError } from './logger.js';

interface RuntimeHandle {
  origin: string;
  runtime: RuntimeHandshake;
  coordinator?: { state: OperationState };
  profiles?: { openWorkspaceCount: number };
  close(): Promise<void>;
}

interface RuntimeModule {
  startServer(config: {
    paths: UtilityStartConfig['paths'];
    host: '127.0.0.1';
    port: 0;
    appVersion: string;
    buildId: string;
    apiToken: string;
    desktopActionToken: string;
    credentialEncryptionKey: string;
    browserExecutablePath?: string;
    onStateChange(state: OperationState): void;
  }): Promise<RuntimeHandle>;
}

const parentPort = process.parentPort;
if (!parentPort) throw new Error('UTILITY_PARENT_PORT_MISSING');

let handle: RuntimeHandle | undefined;
let currentState: OperationState = 'idle';
let stopping: Promise<void> | undefined;

function send(message: UtilityToMainMessage): void {
  parentPort.postMessage(message);
}

/** Sizes main's shutdown timeout. Undefined until the runtime reports it; main then assumes one. */
function openWorkspaceCount(): number | undefined {
  const count = handle?.profiles?.openWorkspaceCount;
  return Number.isSafeInteger(count) && Number(count) >= 0 ? count : undefined;
}

function assertLoopbackOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw Object.assign(new Error('Runtime did not bind to the required loopback address.'), {
      code: 'UNSAFE_RUNTIME_ORIGIN',
    });
  }
  return url.origin;
}

async function start(config: UtilityStartConfig): Promise<void> {
  if (handle) throw Object.assign(new Error('Runtime is already started.'), { code: 'ALREADY_STARTED' });
  if (!fs.existsSync(config.runtimeModulePath)) {
    throw Object.assign(new Error('The compiled finance runtime is missing.'), { code: 'RUNTIME_MODULE_MISSING' });
  }

  const imported = await import(pathToFileURL(config.runtimeModulePath).href) as Partial<RuntimeModule>;
  if (typeof imported.startServer !== 'function') {
    throw Object.assign(new Error('The finance runtime does not export startServer.'), {
      code: 'RUNTIME_EXPORT_MISSING',
    });
  }

  handle = await imported.startServer({
    paths: config.paths,
    host: config.host,
    port: config.port,
    appVersion: config.appVersion,
    buildId: config.buildId,
    apiToken: config.apiToken,
    desktopActionToken: config.desktopActionToken,
    credentialEncryptionKey: config.credentialEncryptionKey,
    browserExecutablePath: config.browserExecutablePath,
    onStateChange(state) {
      currentState = state;
      send({ type: 'state', state, openWorkspaceCount: openWorkspaceCount() });
    },
  });

  const origin = assertLoopbackOrigin(handle.origin);
  currentState = handle.coordinator?.state ?? 'idle';
  send({
    type: 'ready',
    origin,
    runtime: handle.runtime,
    state: currentState,
    openWorkspaceCount: openWorkspaceCount(),
  });
}

async function shutdown(): Promise<void> {
  if (stopping) return stopping;
  stopping = (async () => {
    currentState = 'shuttingDown';
    send({ type: 'state', state: currentState });
    try {
      await handle?.close();
    } finally {
      handle = undefined;
      send({ type: 'stopped' });
      setImmediate(() => process.exit(0));
    }
  })();
  return stopping;
}

parentPort.on('message', (event) => {
  const message = event.data as MainToUtilityMessage;
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;

  if (message.type === 'get-state') {
    send({ type: 'state', state: currentState, openWorkspaceCount: openWorkspaceCount() });
    return;
  }
  if (message.type === 'shutdown') {
    void shutdown().catch((error) => {
      const details = publicUtilityError(error, 'shutdown');
      send({ type: 'error', phase: 'shutdown', ...details });
      setImmediate(() => process.exit(1));
    });
    return;
  }
  if (message.type === 'start') {
    void start(message.config).catch((error) => {
      const details = publicUtilityError(error, 'startup');
      send({ type: 'error', phase: 'startup', ...details });
      setImmediate(() => process.exit(1));
    });
  }
});

process.on('uncaughtException', (error) => {
  const details = publicUtilityError(error, 'runtime');
  send({ type: 'error', phase: 'runtime', ...details });
  void shutdown().finally(() => process.exit(1));
});

process.on('unhandledRejection', (error) => {
  const details = publicUtilityError(error, 'runtime');
  send({ type: 'error', phase: 'runtime', ...details });
  void shutdown().finally(() => process.exit(1));
});
