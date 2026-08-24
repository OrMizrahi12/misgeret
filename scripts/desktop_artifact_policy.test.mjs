import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { artifactViolationReason, auditDesktopArtifacts, packagedExecutablePath } from './audit_desktop_artifacts.mjs';
import { createPackagerIgnore } from './desktop_artifact_policy.mjs';

const require = createRequire(import.meta.url);
const { createPackage } = require('@electron/asar');

const fixtureRoot = path.resolve('C:/fixture/misgeret');
const ignore = createPackagerIgnore(fixtureRoot);
const sourcePath = (...segments) => path.join(fixtureRoot, ...segments);

test('packager filter is a fail-closed root allowlist', () => {
  const allowed = [
    sourcePath('package.json'),
    sourcePath('client'),
    sourcePath('client', 'package.json'),
    sourcePath('client', 'dist'),
    sourcePath('client', 'dist', 'assets', 'index.js'),
    sourcePath('server', 'dist', 'runtime.js'),
    sourcePath('server', 'package.json'),
    sourcePath('desktop', 'dist', 'main.cjs'),
    sourcePath('node_modules'),
    sourcePath('node_modules', 'express', 'index.js'),
  ];
  const rejected = [
    sourcePath('.agents', 'instructions.md'),
    sourcePath('.claude', 'settings.local.json'),
    sourcePath('.codex', 'state.json'),
    sourcePath('.superpowers', 'notes.md'),
    sourcePath('.git', 'config'),
    sourcePath('.github', 'workflows', 'release.yml'),
    sourcePath('.idea', 'workspace.xml'),
    sourcePath('.vscode', 'settings.json'),
    sourcePath('.desktop-resources', 'chromium', 'chrome.exe'),
    sourcePath('data', 'finance.db'),
    sourcePath('docs', 'desktop.md'),
    sourcePath('scripts', 'release.mjs'),
    sourcePath('new-local-directory', 'private.txt'),
    sourcePath('client', 'src', 'App.tsx'),
    sourcePath('client', 'public', 'development-only.json'),
    sourcePath('server', 'src', 'runtime.ts'),
    sourcePath('desktop', 'src', 'main.ts'),
    sourcePath('desktop', 'test', 'main.test.ts'),
    sourcePath('client', 'dist', 'assets', 'index.js.map'),
    sourcePath('server', 'dist', '.env.production'),
    sourcePath('node_modules', '.bin', 'tsx.cmd'),
    sourcePath('node_modules', 'electron', 'dist', 'electron.exe'),
    sourcePath('node_modules', 'express', 'test', 'app.js'),
    sourcePath('node_modules', 'some-package', 'fixtures', 'credentials.json'),
    sourcePath('node_modules', 'some-package', '.github', 'FUNDING.yml'),
    sourcePath('node_modules', 'some-package', '.eslintrc'),
    sourcePath('node_modules', 'some-package', 'README.md'),
    sourcePath('node_modules', 'some-package', 'src', 'index.ts'),
  ];
  const dpapiBinary = sourcePath('node_modules', '@primno', 'dpapi', 'build', 'Release', 'dpapi.node');
  (process.platform === 'win32' ? allowed : rejected).push(dpapiBinary);

  for (const candidate of allowed) assert.equal(ignore(candidate), false, `expected allowed: ${candidate}`);
  for (const candidate of rejected) assert.equal(ignore(candidate), true, `expected rejected: ${candidate}`);
  assert.equal(ignore(path.resolve(fixtureRoot, '..', 'outside.txt')), true);

  // These are the normalized names Electron Packager actually sends to an
  // IgnoreFunction from its copy filter.
  assert.equal(ignore('/desktop/dist/main.cjs'), false);
  assert.equal(ignore('/server/package.json'), false);
  assert.equal(ignore('/.claude/settings.local.json'), true);
  assert.equal(ignore('/new-local-directory/file.txt'), true);
});

test('artifact audit independently rejects metadata, secrets, data, tests, and sources', () => {
  const rejected = [
    '/.claude/settings.local.json',
    '/resources/app.asar.unpacked/.codex/state.json',
    '/node_modules/pkg/.github/FUNDING.yml',
    '/data/finance.db',
    '/backups/finance-2026-07-14.db',
    '/logs/desktop.log',
    '/server/src/runtime.ts',
    '/client/dist/assets/index.js.map',
    '/node_modules/pkg/tests/runtime.js',
    '/node_modules/pkg/fixtures/account.json',
    '/desktop/dist/.env.production',
    '/desktop/dist/release-certificate.pfx',
    '/resources/export.misgeret-backup',
  ];
  const allowed = [
    '/package.json',
    '/desktop/dist/main.cjs',
    '/server/dist/runtime.js',
    '/client/dist/assets/index.js',
    '/node_modules/express/index.js',
    '/node_modules/runtime-package/src/index.js',
    '/resources/chromium/chrome.exe',
    '/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  ];

  for (const entry of rejected) {
    assert.notEqual(artifactViolationReason(entry), undefined, `expected violation: ${entry}`);
  }
  for (const entry of allowed) {
    assert.equal(artifactViolationReason(entry), undefined, `expected clean: ${entry}`);
  }
});

test('artifact audit inspects the complete packaged tree, not only ASAR names', async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-artifact-policy-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const source = path.join(temporaryRoot, 'source');
  const packageRoot = path.join(temporaryRoot, 'Misgeret-win32-x64');
  const resources = path.join(packageRoot, 'resources');
  const unpacked = path.join(resources, 'app.asar.unpacked', 'node_modules');
  fs.mkdirSync(path.join(source, 'desktop', 'dist', 'static'), { recursive: true });
  fs.mkdirSync(path.join(resources, 'chromium'), { recursive: true });
  fs.mkdirSync(path.join(unpacked, 'better-sqlite3', 'build', 'Release'), { recursive: true });
  fs.mkdirSync(path.join(unpacked, '@primno', 'dpapi', 'build', 'Release'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"misgeret"}\n');
  fs.writeFileSync(path.join(source, 'desktop', 'dist', 'main.cjs'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(source, 'desktop', 'dist', 'static', 'recovery.html'), '<!doctype html>\n');
  fs.writeFileSync(path.join(packageRoot, 'Misgeret.exe'), 'fixture');
  fs.writeFileSync(path.join(resources, 'chromium', 'chrome.exe'), 'fixture');
  fs.writeFileSync(path.join(resources, 'chromium', 'misgeret-chromium.json'), JSON.stringify({
    platform: 'win32',
    arch: 'x64',
    executableRelativePath: 'chrome.exe',
  }));
  fs.writeFileSync(path.join(unpacked, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'), 'fixture');
  fs.writeFileSync(path.join(unpacked, '@primno', 'dpapi', 'build', 'Release', 'dpapi.node'), 'fixture');
  await createPackage(source, path.join(resources, 'app.asar'));

  const cleanResult = auditDesktopArtifacts(packageRoot);
  assert.equal(cleanResult.asarCount, 1);

  fs.mkdirSync(path.join(resources, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(resources, '.codex', 'state.json'), '{}\n');
  assert.throws(
    () => auditDesktopArtifacts(packageRoot),
    /\.codex[/\\]state\.json \(local or IDE dot metadata\)/,
  );
});

test('artifact audit accepts the lowercase Linux executable required by DEB and RPM makers', async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-linux-artifact-policy-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const source = path.join(temporaryRoot, 'source');
  const packageRoot = path.join(temporaryRoot, 'Misgeret-linux-x64');
  const resources = path.join(packageRoot, 'resources');
  const chromium = path.join(resources, 'chromium');
  const unpacked = path.join(resources, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release');
  fs.mkdirSync(path.join(source, 'desktop', 'dist', 'static'), { recursive: true });
  fs.mkdirSync(chromium, { recursive: true });
  fs.mkdirSync(unpacked, { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"misgeret"}\n');
  fs.writeFileSync(path.join(source, 'desktop', 'dist', 'static', 'recovery.html'), '<!doctype html>\n');
  fs.writeFileSync(path.join(packageRoot, 'misgeret'), 'fixture');
  fs.writeFileSync(path.join(chromium, 'chrome'), 'fixture');
  fs.writeFileSync(path.join(chromium, 'misgeret-chromium.json'), JSON.stringify({
    platform: 'linux',
    arch: 'x64',
    executableRelativePath: 'chrome',
  }));
  fs.writeFileSync(path.join(unpacked, 'better_sqlite3.node'), 'fixture');
  await createPackage(source, path.join(resources, 'app.asar'));

  const cleanResult = auditDesktopArtifacts(packageRoot);
  assert.equal(cleanResult.asarCount, 1);
  assert.equal(packagedExecutablePath('linux', packageRoot), path.join(packageRoot, 'misgeret'));
  assert.equal(packagedExecutablePath('win32', packageRoot), path.join(packageRoot, 'Misgeret.exe'));
  assert.equal(packagedExecutablePath('darwin', packageRoot), path.join(packageRoot, 'Contents', 'MacOS', 'Misgeret'));
});
