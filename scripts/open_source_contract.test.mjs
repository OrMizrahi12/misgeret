import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fromRoot = (...segments) => path.join(root, ...segments);

test('the app enters the local profile flow directly and publishes under MIT', () => {
  const app = fs.readFileSync(fromRoot('client', 'src', 'App.tsx'), 'utf8');
  assert.match(app, /async function boot\(\)[\s\S]*await api\.profiles\(\)/);

  const pkg = JSON.parse(fs.readFileSync(fromRoot('package.json'), 'utf8'));
  assert.equal(pkg.license, 'MIT');
  assert.match(pkg.repository.url, /github\.com\/OrMizrahi12\/misgeret/);
  assert.equal(fs.existsSync(fromRoot('LICENSE')), true);
  assert.equal(Object.keys(pkg.scripts).some((name) => /account|billing|checkout|payment/i.test(name)), false);
});

test('generated build metadata is limited to version, source, API and update provenance', () => {
  execFileSync(process.execPath, [fromRoot('scripts', 'generate_build_manifest.mjs')], {
    cwd: root,
    stdio: 'pipe',
  });
  const manifest = JSON.parse(fs.readFileSync(fromRoot('.build', 'misgeret-build.json'), 'utf8'));
  assert.deepEqual(
    Object.keys(manifest).sort(),
    ['apiSchemaVersion', 'buildId', 'sourceRevision', 'updateChannel', 'updateFeedUrl', 'version'].sort(),
  );
});
