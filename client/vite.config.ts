import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const clientDirectory = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(clientDirectory, '..', '.build', 'misgeret-build.json');
let buildId = 'web-dev';
try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    buildId?: unknown;
  };
  if (typeof manifest.buildId === 'string' && manifest.buildId) buildId = manifest.buildId;
} catch {
  // Vite development intentionally works without a release manifest.
}

export default defineConfig({
  plugins: [react()],
  define: {
    __MISGERET_BUILD_ID__: JSON.stringify(buildId),
  },
  server: {
    // VITE_API_TARGET lets a second dev instance point at an isolated server (E2E)
    proxy: { '/api': process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3001' },
  },
});
