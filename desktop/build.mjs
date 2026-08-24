import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'desktop', 'dist');

export async function buildDesktop() {
  const sharedManifestPath = path.join(root, '.build', 'misgeret-build.json');
  if (!fs.existsSync(sharedManifestPath)) {
    throw new Error('Shared build manifest is missing. Run npm run build:manifest before the desktop bundle.');
  }
  const manifest = JSON.parse(fs.readFileSync(sharedManifestPath, 'utf8'));
  if (typeof manifest.buildId !== 'string' || !manifest.buildId) throw new Error('Shared build manifest has no buildId.');

  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });

  await build({
    entryPoints: {
      main: path.join(root, 'desktop', 'src', 'main.ts'),
      preload: path.join(root, 'desktop', 'src', 'preload.ts'),
      utility: path.join(root, 'desktop', 'src', 'utility.ts'),
    },
    outdir: output,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info',
    define: { 'process.env.NODE_ENV': '"production"' },
  });

  // The recovery screen ships as static files next to the bundle. The packager only admits
  // desktop/dist, so desktop/static must be copied INTO it — otherwise every packaged runtime
  // failure dead-ends on ERR_FILE_NOT_FOUND instead of showing the retry/logs/quit screen.
  const staticSrc = path.join(root, 'desktop', 'static');
  const staticDst = path.join(output, 'static');
  fs.mkdirSync(staticDst, { recursive: true });
  for (const file of fs.readdirSync(staticSrc)) {
    fs.copyFileSync(path.join(staticSrc, file), path.join(staticDst, file));
  }
  const required = path.join(staticDst, 'recovery.html');
  if (!fs.existsSync(required)) throw new Error('Recovery screen missing from desktop bundle.');

  fs.writeFileSync(
    path.join(output, 'build-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await buildDesktop();
}
