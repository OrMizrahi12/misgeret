import path from 'node:path';

const allowedBuildRoots = new Set(['client', 'server', 'desktop']);
const blockedMetadataDirectories = new Set([
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
const blockedContentDirectories = new Set([
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

function segmentsFor(relativePath) {
  return relativePath
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean);
}

function hasBlockedDirectory(segments) {
  return segments.some((segment) =>
    segment.startsWith('.')
    || blockedMetadataDirectories.has(segment.toLowerCase())
    || blockedContentDirectories.has(segment.toLowerCase()));
}

function hasForbiddenFileName(segments) {
  const fileName = segments.at(-1)?.toLowerCase() ?? '';
  return (
    /^\.env(?:\..*)?$/.test(fileName)
    || /^(?:credentials|secrets)\.json$/.test(fileName)
    || /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|\.npmrc|\.pypirc|\.yarnrc)$/.test(fileName)
    || /\.(?:cts|key|log|map|md|mts|p12|pem|pfx|ts|tsx|tsbuildinfo)$/.test(fileName)
    || /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(fileName)
    || /^(?:changelog|contributing|readme)(?:\..*)?$/.test(fileName)
    || /^finance\.db(?:-(?:shm|wal))?$/.test(fileName)
  );
}

/**
 * Electron Packager calls this predicate with absolute source paths. Returning an
 * ignore function disables Packager's built-in ignores, so every allowed root and
 * every denied runtime-irrelevant path is expressed here deliberately.
 */
export function createPackagerIgnore(projectRoot) {
  const resolvedRoot = path.resolve(projectRoot);
  const comparableRoot = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;

  return (candidatePath) => {
    const resolvedCandidate = path.resolve(candidatePath);
    const comparableCandidate = process.platform === 'win32'
      ? resolvedCandidate.toLowerCase()
      : resolvedCandidate;
    const candidateRelativeToRoot = path.relative(comparableRoot, comparableCandidate);
    const isInsideProject = candidateRelativeToRoot === '' || (
      candidateRelativeToRoot !== '..'
      && !candidateRelativeToRoot.startsWith(`..${path.sep}`)
      && !path.isAbsolute(candidateRelativeToRoot)
    );

    // Electron Packager currently passes normalized package-relative names such
    // as `/server/dist/runtime.js`, despite the public type describing an
    // absolute path. Accept both forms without broadening the allowlist.
    const isPackagerRelative = /^[\\/](?![\\/])/.test(candidatePath)
      && !/^[a-z]:[\\/]/i.test(candidatePath);
    const relative = isInsideProject
      ? candidateRelativeToRoot
      : isPackagerRelative
        ? candidatePath.replace(/^[\\/]+/, '')
        : undefined;

    if (relative === '') return false;
    if (relative === undefined) return true;

    const segments = segmentsFor(relative);
    const [topLevel, secondLevel] = segments;
    const top = topLevel?.toLowerCase();
    const second = secondLevel?.toLowerCase();

    if (!top) return true;
    if (top === 'package.json') return segments.length !== 1;

    if (allowedBuildRoots.has(top)) {
      if (segments.length === 1) return false;
      // Workspace metadata is required by npm pruning, and server/package.json
      // preserves ESM interpretation for the compiled server/*.js runtime.
      if (segments.length === 2 && second === 'package.json') return false;
      if (second !== 'dist') return true;
      if (segments.length === 2) return false;
      return hasBlockedDirectory(segments.slice(2)) || hasForbiddenFileName(segments);
    }

    if (top === 'node_modules') {
      if (segments.length === 1) return false;
      if (second === '.bin' || second === 'electron' || second === 'electron-nightly') return true;
      if (second === '@primno' && segments[2]?.toLowerCase() === 'dpapi' && process.platform !== 'win32') return true;
      return hasBlockedDirectory(segments.slice(1)) || hasForbiddenFileName(segments);
    }

    return true;
  };
}
