import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  feedUrlForRepo,
  loadReleaseConfig,
  parseReleasesFile,
  releaseVersionFromPackages,
  serializeReleases,
  trimReleases,
  validateFeedUrl,
  validateRepoSlug,
  verifyEntryAgainstFile,
} from './publish_release.mjs';

const SHA1 = 'A'.repeat(40);

test('validateRepoSlug accepts owner/name and rejects everything else', () => {
  assert.equal(validateRepoSlug('OrMizrahi12/misgeret'), 'OrMizrahi12/misgeret');
  for (const bad of ['misgeret', 'a/b/c', 'owner/', '/repo', 'owner/re po', '', undefined]) {
    assert.throws(() => validateRepoSlug(bad), /owner\/name/);
  }
});

test('feedUrlForRepo builds the evergreen latest/download URL', () => {
  assert.equal(
    feedUrlForRepo('OrMizrahi12/misgeret'),
    'https://github.com/OrMizrahi12/misgeret/releases/latest/download',
  );
});

test('validateFeedUrl enforces bare HTTPS and strips trailing slashes', () => {
  assert.equal(validateFeedUrl('https://example.com/feed/'), 'https://example.com/feed');
  assert.throws(() => validateFeedUrl('http://example.com/feed'), /HTTPS/);
  assert.throws(() => validateFeedUrl('https://user:pw@example.com/feed'), /credentials/);
  assert.throws(() => validateFeedUrl('https://example.com/feed?channel=beta'), /query/);
});

test('parseReleasesFile reads Squirrel entries and normalizes the SHA to uppercase', () => {
  const entries = parseReleasesFile(`${'ab'.repeat(20)} misgeret-1.6.0-full.nupkg 123\r\n`);
  assert.deepEqual(entries, [{ sha1: 'AB'.repeat(20), name: 'misgeret-1.6.0-full.nupkg', size: 123 }]);
});

test('parseReleasesFile strips the UTF-8 BOM Squirrel writes', () => {
  const entries = parseReleasesFile('﻿' + 'ab'.repeat(20) + ' misgeret-1.6.0-full.nupkg 123\r\n');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sha1, 'AB'.repeat(20));
});

test('parseReleasesFile rejects malformed lines', () => {
  assert.throws(() => parseReleasesFile(''), /no entries/);
  assert.throws(() => parseReleasesFile(`${SHA1} two.nupkg`), /Malformed/);
  assert.throws(() => parseReleasesFile(`nothex misgeret-1.0.0-full.nupkg 1`), /Malformed|SHA1/);
  assert.throws(() => parseReleasesFile(`${SHA1} ../evil.nupkg 1`), /file name/);
  assert.throws(() => parseReleasesFile(`${SHA1} misgeret-1.0.0-full.exe 1`), /file name/);
  assert.throws(() => parseReleasesFile(`${SHA1} misgeret-1.0.0-full.nupkg -5`), /size/);
});

test('trimReleases keeps only packages that exist on disk and refuses an empty result', () => {
  const entries = [
    { sha1: SHA1, name: 'misgeret-1.5.1-full.nupkg', size: 1 },
    { sha1: SHA1, name: 'misgeret-1.6.0-delta.nupkg', size: 2 },
    { sha1: SHA1, name: 'misgeret-1.6.0-full.nupkg', size: 3 },
  ];
  const kept = trimReleases(entries, ['misgeret-1.6.0-delta.nupkg', 'misgeret-1.6.0-full.nupkg']);
  assert.deepEqual(kept.map((entry) => entry.name), ['misgeret-1.6.0-delta.nupkg', 'misgeret-1.6.0-full.nupkg']);
  assert.throws(() => trimReleases(entries, []), /No RELEASES entry/);
});

test('serializeReleases round-trips through parseReleasesFile', () => {
  const entries = [{ sha1: 'AB'.repeat(20), name: 'misgeret-1.6.0-full.nupkg', size: 42 }];
  assert.deepEqual(parseReleasesFile(serializeReleases(entries)), entries);
});

test('releaseVersionFromPackages demands the full package of the current version', () => {
  const entries = [{ sha1: SHA1, name: 'misgeret-1.5.1-full.nupkg', size: 1 }];
  assert.equal(releaseVersionFromPackages(entries, '1.5.1'), 'misgeret-1.5.1-full.nupkg');
  assert.throws(() => releaseVersionFromPackages(entries, '1.6.0'), /stale/);
});

test('verifyEntryAgainstFile checks both size and SHA1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-publish-'));
  const file = path.join(dir, 'misgeret-1.6.0-full.nupkg');
  const content = Buffer.from('not really a nupkg');
  fs.writeFileSync(file, content);
  const sha1 = crypto.createHash('sha1').update(content).digest('hex').toUpperCase();

  verifyEntryAgainstFile({ sha1, name: 'misgeret-1.6.0-full.nupkg', size: content.length }, file);
  assert.throws(
    () => verifyEntryAgainstFile({ sha1, name: 'x', size: content.length + 1 }, file),
    /size mismatch/,
  );
  assert.throws(
    () => verifyEntryAgainstFile({ sha1: 'C'.repeat(40), name: 'x', size: content.length }, file),
    /SHA1 mismatch/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadReleaseConfig reads release.config.json and lets env override', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-config-'));
  fs.writeFileSync(path.join(dir, 'release.config.json'), JSON.stringify({
    githubRepo: 'OrMizrahi12/misgeret',
    updateFeedUrl: 'https://github.com/OrMizrahi12/misgeret/releases/latest/download',
    updateChannel: 'stable',
  }));

  const fromFile = loadReleaseConfig(dir, {});
  assert.equal(fromFile.githubRepo, 'OrMizrahi12/misgeret');
  assert.equal(fromFile.updateChannel, 'stable');

  const overridden = loadReleaseConfig(dir, {
    MISGERET_RELEASES_REPO: 'other/repo',
    MISGERET_UPDATE_FEED_URL: 'https://updates.example.com/misgeret/stable',
  });
  assert.equal(overridden.githubRepo, 'other/repo');
  assert.equal(overridden.updateFeedUrl, 'https://updates.example.com/misgeret/stable');

  assert.throws(() => loadReleaseConfig(dir, { MISGERET_UPDATE_CHANNEL: 'beta' }), /stable channel/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the real release.config.json is valid and repo matches the feed URL', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = loadReleaseConfig(root, {});
  assert.equal(config.updateFeedUrl, feedUrlForRepo(config.githubRepo));
});
