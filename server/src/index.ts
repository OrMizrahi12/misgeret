import { startServer } from './runtime.js';

const handle = await startServer({
  port: Number(process.env.PORT) || 3001,
  dataDir: process.env.DATA_DIR,
  dbPath: process.env.DB_PATH,
  clientDist: process.env.CLIENT_DIST,
  appVersion: process.env.APP_VERSION,
  buildId: process.env.BUILD_ID,
  apiToken: process.env.API_TOKEN,
  desktopActionToken: process.env.DESKTOP_ACTION_TOKEN,
  credentialEncryptionKey: process.env.MISGERET_CREDENTIAL_KEY,
  browserExecutablePath: process.env.BROWSER_EXECUTABLE_PATH,
});

const mode = process.env.MOCK_BANK === '1' ? ' [mock mode — fake data]' : '';
console.log(`Financial framework server: ${handle.origin}${mode}`);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await handle.close();
    process.exitCode = 0;
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
      ? err.code
      : undefined;
    console.error('[shutdown] failed', code && /^[A-Z0-9_]+$/.test(code) ? { code } : undefined);
    process.exitCode = 1;
  }
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
