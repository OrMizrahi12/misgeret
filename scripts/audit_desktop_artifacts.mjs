import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { listPackage } = require('@electron/asar');
const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), '..');

const forbiddenMetadataDirectories = new Set([
  '.agents',
  '.claude',
  '.codex',
  '.fleet',
  '.git',
  '.github',
  '.gitlab',
  '.idea',
  '.superpowers',
  '.vs',
  '.vscode',
]);
const forbiddenNonRuntimeDirectories = new Set([
  '__fixtures__',
  '__tests__',
  'benchmark',
  'benchmarks',
  'coverage',
  'doc',
  'docs',
  'example',
  'examples',
  'fixture',
  'fixtures',
  'test',
  'tests',
]);
const forbiddenRootDirectories = new Set([
  'backups',
  'browser-temp',
  'data',
  'docs',
  'logs',
  'out',
  'release',
  'scripts',
]);

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function pathSegments(value) {
  return value
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
}

/**
 * Independent package-output policy. This deliberately does not import the
 * Forge copy filter: a bad or bypassed filter must still fail the artifact.
 */
export function artifactViolationReason(entry) {
  const segments = pathSegments(entry);
  if (segments.length === 0) return undefined;

  const [top, second] = segments;
  const fileName = segments.at(-1) ?? '';

  if (segments.some((segment) => segment.startsWith('.') || forbiddenMetadataDirectories.has(segment))) {
    return 'local or IDE dot metadata';
  }
  if (forbiddenRootDirectories.has(top)) return 'development, log, or user-data root';
  if (segments.some((segment) => forbiddenNonRuntimeDirectories.has(segment))) {
    return 'test, fixture, example, or documentation content';
  }
  if (
    (top === 'client' && (second === 'src' || second === 'public'))
    || (top === 'server' && second === 'src')
    || (top === 'desktop' && (second === 'src' || second === 'test' || second === 'assets'))
  ) {
    return 'application source tree';
  }
  if (/^\.env(?:\..*)?$/.test(fileName)) return 'environment secrets';
  if (/^(?:credentials|secrets)\.json$/.test(fileName)) return 'credential or secret file';
  if (/^(?:id_(?:rsa|dsa|ecdsa|ed25519)|\.npmrc|\.pypirc|\.yarnrc)$/.test(fileName)) {
    return 'developer credential file';
  }
  if (/\.(?:key|p12|pem|pfx)$/.test(fileName)) return 'private key or signing certificate';
  if (/^finance(?:-[^/]*)?\.db(?:-(?:shm|wal))?$/.test(fileName) || fileName.endsWith('.misgeret-backup')) {
    return 'financial database or backup';
  }
  if (/\.log$/.test(fileName)) return 'runtime or development log';
  if (/\.map$/.test(fileName)) return 'source map';
  if (/\.(?:cts|mts|ts|tsx|tsbuildinfo)$/.test(fileName) || /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(fileName)) {
    return 'TypeScript source or test file';
  }
  if (/\.md$/.test(fileName) || /^(?:changelog|contributing|readme)(?:\..*)?$/.test(fileName)) {
    return 'documentation file';
  }

  return undefined;
}

function relativeToClosestPackageRoot(file, packageRoots, fallbackRoot) {
  const containingRoot = packageRoots.find((candidate) => {
    const relative = path.relative(candidate, file);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
  return path.relative(containingRoot ?? fallbackRoot, file);
}

export function packagedExecutablePath(platform, packageRoot) {
  if (platform === 'win32') return path.join(packageRoot, 'Misgeret.exe');
  if (platform === 'darwin') return path.join(packageRoot, 'Contents', 'MacOS', 'Misgeret');
  if (platform === 'linux') return path.join(packageRoot, 'misgeret');
  throw new Error(`Unsupported desktop platform: ${platform}`);
}

export function auditDesktopArtifacts(targetDirectory) {
  const target = path.resolve(targetDirectory);
  if (!fs.existsSync(target)) {
    throw new Error(`Desktop artifact directory does not exist: ${target}`);
  }

  const files = walk(target);
  const asars = files.filter((file) => path.basename(file).toLowerCase() === 'app.asar');
  if (asars.length === 0) throw new Error(`No packaged app.asar found below ${target}`);

  const violations = new Set();
  for (const asar of asars) {
    const entries = listPackage(asar);
    for (const entry of entries) {
      const reason = artifactViolationReason(entry);
      if (reason) violations.add(`${asar}: ${entry} (${reason})`);
    }
    // positive invariant: the recovery screen must ship, or every packaged runtime failure
    // dead-ends on ERR_FILE_NOT_FOUND instead of the retry/logs/quit screen
    if (!entries.some((entry) => entry.replaceAll('\\', '/').endsWith('desktop/dist/static/recovery.html'))) {
      violations.add(`${asar} (recovery screen desktop/dist/static/recovery.html missing)`);
    }
  }

  const layouts = asars.map((asar) => {
    const resources = path.dirname(asar);
    const parent = path.dirname(resources);
    if (path.basename(parent).toLowerCase() === 'contents') {
      const packageRoot = path.dirname(parent);
      return {
        platform: 'darwin',
        packageRoot,
        resources,
        executable: packagedExecutablePath('darwin', packageRoot),
      };
    }
    const packageRoot = parent;
    const windowsExecutable = path.join(packageRoot, 'Misgeret.exe');
    return {
      platform: fs.existsSync(windowsExecutable) ? 'win32' : 'linux',
      packageRoot,
      resources,
      executable: packagedExecutablePath(fs.existsSync(windowsExecutable) ? 'win32' : 'linux', packageRoot),
    };
  });
  const packageRoots = [...new Set(layouts.map((layout) => layout.packageRoot))];
  const packagedFiles = files.filter((file) => packageRoots.some((packageRoot) => {
    const relative = path.relative(packageRoot, file);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }));
  for (const file of packagedFiles) {
    const relative = relativeToClosestPackageRoot(file, packageRoots, target);
    const reason = artifactViolationReason(relative);
    if (reason) violations.add(`${file} (${reason})`);
  }

  for (const { platform, resources, executable } of layouts) {
    const chromiumRoot = path.join(resources, 'chromium');
    const chromiumManifest = path.join(chromiumRoot, 'misgeret-chromium.json');
    const unpacked = path.join(resources, 'app.asar.unpacked');
    const unpackedFiles = fs.existsSync(unpacked) ? walk(unpacked) : [];

    if (!fs.existsSync(executable)) violations.add(`${executable} (main executable missing)`);
    try {
      const manifest = JSON.parse(fs.readFileSync(chromiumManifest, 'utf8'));
      const chromium = path.resolve(chromiumRoot, String(manifest.executableRelativePath ?? ''));
      const relative = path.relative(chromiumRoot, chromium);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(chromium)) {
        throw new Error('invalid executableRelativePath');
      }
      if (manifest.platform !== platform) throw new Error(`manifest platform is ${String(manifest.platform)}`);
    } catch (error) {
      violations.add(`${chromiumManifest} (bundled Chromium manifest/executable invalid: ${error.message})`);
    }
    if (!unpackedFiles.some((file) => path.basename(file) === 'better_sqlite3.node')) {
      violations.add(`${unpacked} (better-sqlite3 native binary is not unpacked)`);
    }
    if (platform === 'win32' && !unpackedFiles.some((file) => /dpapi.*\.node$/i.test(path.basename(file)))) {
      violations.add(`${unpacked} (DPAPI native binary is not unpacked)`);
    }
    if (platform !== 'win32' && unpackedFiles.some((file) => /dpapi.*\.node$/i.test(path.basename(file)))) {
      violations.add(`${unpacked} (Windows DPAPI binary must not ship on ${platform})`);
    }
  }

  if (violations.size > 0) {
    throw new Error(`Desktop package invariant failed:\n${[...violations].map((item) => `- ${item}`).join('\n')}`);
  }

  return { asarCount: asars.length, fileCount: packagedFiles.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const target = path.resolve(process.argv[2] ?? path.join(root, 'out'));
  const result = auditDesktopArtifacts(target);
  console.log(`Desktop artifact audit passed: ${result.asarCount} ASAR package(s), ${result.fileCount} files checked.`);
}
