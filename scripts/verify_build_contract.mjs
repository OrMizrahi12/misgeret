import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readManifest(filePath) {
  const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (typeof manifest.buildId !== 'string' || !manifest.buildId) {
    throw new Error(`Build manifest has no buildId: ${filePath}`);
  }
  return manifest;
}

const shared = readManifest(path.join(root, '.build', 'misgeret-build.json'));
for (const component of ['client/dist', 'server/dist', 'desktop/dist']) {
  const candidate = readManifest(path.join(root, component, 'build-manifest.json'));
  if (
    candidate.buildId !== shared.buildId
    || String(candidate.apiSchemaVersion) !== String(shared.apiSchemaVersion)
  ) {
    throw new Error(`${component} was built from a different manifest`);
  }
}

const assetDirectory = path.join(root, 'client', 'dist', 'assets');
const rendererCode = fs.readdirSync(assetDirectory)
  .filter((name) => name.endsWith('.js'))
  .map((name) => fs.readFileSync(path.join(assetDirectory, name), 'utf8'))
  .join('\n');
if (!rendererCode.includes(shared.buildId)) {
  throw new Error('Renderer JavaScript does not embed the shared build ID');
}

const runtimeModule = await import(pathToFileURL(path.join(root, 'server', 'dist', 'runtime.js')).href);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-build-contract-'));
const handle = await runtimeModule.startServer({
  dataDir,
  clientDist: path.join(root, 'client', 'dist'),
  port: 0,
  buildId: 'caller-controlled-id-must-not-win',
});
try {
  const response = await fetch(`${handle.origin}/api/runtime`);
  if (!response.ok) throw new Error(`Compiled runtime handshake returned HTTP ${response.status}`);
  const runtime = await response.json();
  if (runtime.buildId !== shared.buildId) {
    throw new Error('Compiled runtime did not report its independently embedded build ID');
  }
} finally {
  await handle.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`Build contract verified: ${shared.buildId}`);
