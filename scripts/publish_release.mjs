// One-command public release: build → GitHub Releases → verified live update feed.
//
// Usage:  npm run release:publish                 (build + publish, requires clean worktree)
//         npm run release:publish -- --dry-run    (everything except GitHub mutations)
//         npm run release:publish -- --skip-build (publish an existing out/make, version-checked)
//         npm run release:publish -- --create-repo (create the public releases repo if missing)
//
// The update feed is GitHub's evergreen redirect:
//   https://github.com/<owner>/<repo>/releases/latest/download
// Squirrel fetches <feed>/RELEASES and downloads the listed .nupkg files relative to it,
// so every release must carry a RELEASES file that references only its own assets. This
// script trims the accumulated RELEASES to the packages actually uploaded and verifies
// each entry's SHA1 and size before anything leaves the machine.
//
// Source is MIT-licensed in the public project repository; signed build artifacts land in the
// separate releases repository that also acts as the Squirrel update feed.
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function validateRepoSlug(slug) {
  if (typeof slug !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?\/[A-Za-z0-9._-]{1,100}$/.test(slug)) {
    throw new Error(`githubRepo must look like owner/name, got: ${String(slug)}`);
  }
  return slug;
}

export function feedUrlForRepo(slug) {
  return `https://github.com/${validateRepoSlug(slug)}/releases/latest/download`;
}

export function validateFeedUrl(candidate) {
  const url = new URL(candidate);
  if (url.protocol !== 'https:') throw new Error('updateFeedUrl must use HTTPS.');
  if (url.username || url.password) throw new Error('updateFeedUrl must not embed credentials.');
  if (url.search || url.hash) throw new Error('updateFeedUrl must not carry a query string or fragment.');
  return url.toString().replace(/\/+$/, '');
}

export function loadReleaseConfig(rootDir, env = process.env) {
  const configPath = path.join(rootDir, 'release.config.json');
  if (!fs.existsSync(configPath)) throw new Error(`release.config.json is missing at ${configPath}.`);
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const githubRepo = validateRepoSlug(env.MISGERET_RELEASES_REPO?.trim() || raw.githubRepo);
  const updateFeedUrl = validateFeedUrl(env.MISGERET_UPDATE_FEED_URL?.trim() || raw.updateFeedUrl);
  const updateChannel = env.MISGERET_UPDATE_CHANNEL?.trim() || raw.updateChannel || 'stable';
  if (updateChannel !== 'stable') {
    // latest/download ignores prereleases, so a beta channel needs its own feed. Refuse
    // rather than silently publishing a beta into every customer's stable feed.
    throw new Error('Only the stable channel is publishable today; a beta feed is future work.');
  }
  return { githubRepo, updateFeedUrl, updateChannel };
}

// RELEASES format (Squirrel.Windows): "<SHA1-hex> <fileName> <sizeInBytes>" per line.
// Squirrel writes the file as UTF-8 with a BOM; we strip it and publish without one.
export function parseReleasesFile(text) {
  const entries = [];
  for (const line of text.replace(new RegExp('^\\uFEFF'), '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 3) throw new Error(`Malformed RELEASES line: ${line}`);
    const [sha1, name, sizeText] = parts;
    if (!/^[0-9a-fA-F]{40}$/.test(sha1)) throw new Error(`RELEASES entry has an invalid SHA1: ${line}`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.nupkg$/.test(name)) throw new Error(`RELEASES entry has an unexpected file name: ${line}`);
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`RELEASES entry has an invalid size: ${line}`);
    entries.push({ sha1: sha1.toUpperCase(), name, size });
  }
  if (entries.length === 0) throw new Error('RELEASES file contains no entries.');
  return entries;
}

export function trimReleases(entries, availableNames) {
  const available = new Set(availableNames);
  const kept = entries.filter((entry) => available.has(entry.name));
  if (kept.length === 0) throw new Error('No RELEASES entry matches an artifact on disk.');
  return kept;
}

export function serializeReleases(entries) {
  return `${entries.map((entry) => `${entry.sha1} ${entry.name} ${entry.size}`).join('\r\n')}\r\n`;
}

export function verifyEntryAgainstFile(entry, filePath) {
  const content = fs.readFileSync(filePath);
  if (content.length !== entry.size) {
    throw new Error(`${entry.name}: size mismatch (RELEASES says ${entry.size}, file is ${content.length}).`);
  }
  const sha1 = crypto.createHash('sha1').update(content).digest('hex').toUpperCase();
  if (sha1 !== entry.sha1) throw new Error(`${entry.name}: SHA1 mismatch between RELEASES and the file on disk.`);
}

export function releaseVersionFromPackages(entries, version) {
  const fullName = `misgeret-${version}-full.nupkg`;
  if (!entries.some((entry) => entry.name === fullName)) {
    throw new Error(`RELEASES does not reference ${fullName} — out/make is stale, rebuild first.`);
  }
  return fullName;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function gh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', windowsHide: true, ...options });
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}.`);
}

async function fetchFeedReleases(feedUrl) {
  const response = await fetch(`${feedUrl}/RELEASES`, { redirect: 'follow' });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Update feed answered ${response.status} for RELEASES.`);
  return response.text();
}

async function main() {
  const flags = new Set(process.argv.slice(2));
  const dryRun = flags.has('--dry-run');
  const skipBuild = flags.has('--skip-build');
  const createRepo = flags.has('--create-repo');

  const config = loadReleaseConfig(root);
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const tag = `v${version}`;
  const signed = Boolean(process.env.MISGERET_WINDOWS_CERTIFICATE_FILE?.trim());
  if (!signed && process.env.MISGERET_ALLOW_UNSIGNED_RELEASE !== '1') {
    throw new Error(
      'No code-signing certificate is configured.\n' +
      '  Signed release:   set MISGERET_WINDOWS_CERTIFICATE_FILE / _PASSWORD / MISGERET_WINDOWS_PUBLISHER.\n' +
      '  Unsigned release: set MISGERET_ALLOW_UNSIGNED_RELEASE=1 (SmartScreen will warn on new installs).',
    );
  }
  console.log(`Publishing Misgeret ${version} → ${config.githubRepo} (${signed ? 'signed' : 'UNSIGNED'})`);

  // --- Preflight: gh auth, repo existence + PUBLIC visibility, tag not taken ------------
  try {
    gh(['auth', 'status'], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    throw new Error('gh is not authenticated. Run "gh auth login" first.');
  }

  let repoVisibility;
  try {
    repoVisibility = JSON.parse(gh(['repo', 'view', config.githubRepo, '--json', 'visibility'],
      { stdio: ['ignore', 'pipe', 'ignore'] })).visibility;
  } catch {
    if (!createRepo) {
      throw new Error(
        `The releases repo ${config.githubRepo} does not exist. Create it once with:\n` +
        `  gh repo create ${config.githubRepo} --public --add-readme --description "Misgeret releases and update feed"\n` +
        'or rerun with --create-repo.',
      );
    }
    if (dryRun) {
      console.log(`[dry-run] would create public repo ${config.githubRepo}`);
    } else {
      gh(['repo', 'create', config.githubRepo, '--public', '--add-readme',
        '--description', 'Misgeret releases and update feed'], { stdio: 'inherit' });
      repoVisibility = 'PUBLIC';
    }
  }
  if (repoVisibility && String(repoVisibility).toUpperCase() !== 'PUBLIC') {
    throw new Error(`${config.githubRepo} is ${repoVisibility}. Customers cannot download from a non-public repo.`);
  }

  let tagExists = false;
  try {
    gh(['release', 'view', tag, '--repo', config.githubRepo, '--json', 'tagName'], { stdio: ['ignore', 'ignore', 'ignore'] });
    tagExists = true;
  } catch {
    // no such release — exactly what we want
  }
  if (tagExists) throw new Error(`${tag} is already published. Bump the version in package.json first.`);

  // --- Release prerequisites (clean worktree, channel, feed, signing or explicit opt-out)
  run('node', ['scripts/verify_release_prerequisites.mjs'], {
    MISGERET_UPDATE_FEED_URL: config.updateFeedUrl,
    MISGERET_UPDATE_CHANNEL: config.updateChannel,
  });

  // --- Probe the live feed so Squirrel can generate a delta package -------------------
  const remoteReleases = await fetchFeedReleases(config.updateFeedUrl);
  console.log(remoteReleases
    ? 'Existing feed found — the build will also produce a delta package.'
    : 'No existing feed — publishing the first full release.');

  // --- Build with the feed URL baked into the manifest --------------------------------
  if (skipBuild) {
    console.log('Skipping build (--skip-build); publishing the artifacts already in out/make.');
  } else {
    run('npm', ['run', 'desktop:make'], {
      MISGERET_UPDATE_FEED_URL: config.updateFeedUrl,
      MISGERET_UPDATE_CHANNEL: config.updateChannel,
      ...(remoteReleases ? { MISGERET_REMOTE_RELEASES: config.updateFeedUrl } : {}),
    });
    if (signed) run('node', ['scripts/verify_authenticode.mjs'], {});
  }

  // --- Stage assets: trimmed RELEASES + packages + installer + provenance -------------
  const makeDir = path.join(root, 'out', 'make', 'squirrel.windows', 'x64');
  const releasesPath = path.join(makeDir, 'RELEASES');
  const setupPath = path.join(makeDir, 'MisgeretSetup.exe');
  if (!fs.existsSync(releasesPath) || !fs.existsSync(setupPath)) {
    throw new Error(`RELEASES/MisgeretSetup.exe missing under ${makeDir} — run "npm run desktop:make".`);
  }

  const nupkgOnDisk = fs.readdirSync(makeDir).filter((name) => name.endsWith('.nupkg'));
  const entries = trimReleases(parseReleasesFile(fs.readFileSync(releasesPath, 'utf8')), nupkgOnDisk);
  releaseVersionFromPackages(entries, version);
  for (const entry of entries) verifyEntryAgainstFile(entry, path.join(makeDir, entry.name));

  const stageDir = path.join(root, 'out', 'release-publish');
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  fs.writeFileSync(path.join(stageDir, 'RELEASES'), serializeReleases(entries), 'ascii');
  for (const entry of entries) fs.copyFileSync(path.join(makeDir, entry.name), path.join(stageDir, entry.name));
  fs.copyFileSync(setupPath, path.join(stageDir, 'MisgeretSetup.exe'));

  const metadataDir = path.join(root, 'out', 'release-metadata');
  for (const name of ['THIRD_PARTY_NOTICES.md', 'sbom.cdx.json']) {
    const source = path.join(metadataDir, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(stageDir, name));
  }
  const assets = fs.readdirSync(stageDir).sort();
  fs.writeFileSync(
    path.join(stageDir, 'SHA256SUMS.txt'),
    `${assets.map((name) => `${sha256(path.join(stageDir, name))}  ${name}`).join('\n')}\n`,
    'utf8',
  );

  const notesPath = path.join(root, 'docs', 'releases', `${tag}.md`);
  const notes = fs.existsSync(notesPath)
    ? fs.readFileSync(notesPath, 'utf8')
    : `## Misgeret ${version}\n\nהתקנה חדשה: הורידו והריצו את \`MisgeretSetup.exe\`.\nמותקן כבר? האפליקציה תציג כפתור עדכון לבד.\n`;
  const stagedNotes = path.join(stageDir, `notes-${tag}.md`);
  fs.writeFileSync(stagedNotes, notes, 'utf8');

  const uploads = [...assets, 'SHA256SUMS.txt']
    .filter((name, index, all) => all.indexOf(name) === index)
    .map((name) => path.join(stageDir, name));
  console.log(`Staged ${uploads.length} asset(s):`);
  for (const file of uploads) console.log(`  ${path.basename(file)} (${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB)`);

  if (dryRun) {
    console.log(`[dry-run] would run: gh release create ${tag} --repo ${config.githubRepo} --latest`);
    return;
  }

  // --- Publish -------------------------------------------------------------------------
  gh(['release', 'create', tag,
    '--repo', config.githubRepo,
    '--title', `Misgeret ${version}`,
    '--notes-file', stagedNotes,
    '--latest',
    ...uploads,
  ], { stdio: 'inherit' });

  // --- Verify the live feed serves exactly what we published ---------------------------
  const expected = serializeReleases(entries).replace(/\r\n/g, '\n').trim();
  const deadline = Date.now() + 180_000;
  let live;
  for (;;) {
    try {
      live = (await fetchFeedReleases(config.updateFeedUrl))?.replace(/\r\n/g, '\n').trim();
    } catch {
      live = undefined; // transient network failure — keep polling until the deadline
    }
    if (live === expected) break;
    if (Date.now() > deadline) {
      throw new Error(`Published, but the live feed does not serve the new RELEASES yet. Got:\n${live ?? '(unreachable or 404)'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  let setupOk = false;
  for (let attempt = 0; attempt < 3 && !setupOk; attempt += 1) {
    try {
      setupOk = (await fetch(`${config.updateFeedUrl}/MisgeretSetup.exe`, { method: 'HEAD', redirect: 'follow' })).ok;
    } catch {
      // transient — retry below
    }
    if (!setupOk) await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  if (!setupOk) throw new Error('Installer download probe failed after publishing.');

  console.log('');
  console.log(`Misgeret ${version} is live.`);
  console.log(`  Customer download: ${config.updateFeedUrl}/MisgeretSetup.exe`);
  console.log(`  Update feed:       ${config.updateFeedUrl}/RELEASES (verified serving ${tag})`);
  console.log('  Installed apps built with this feed will offer the update on their next check.');
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
