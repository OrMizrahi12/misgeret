import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(process.argv[2] ?? path.join(root, 'out', 'make'));
const output = path.resolve(process.argv[3] ?? path.join(root, 'out', 'release-metadata'));

if (!fs.existsSync(target)) throw new Error(`Release artifact directory does not exist: ${target}`);
fs.mkdirSync(output, { recursive: true });

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

const artifacts = walk(target)
  .filter((file) => /(?:\.exe|\.nupkg|\.zip|\.dmg|\.deb|\.rpm)$/i.test(file) || path.basename(file) === 'RELEASES')
  .sort((a, b) => a.localeCompare(b));
if (artifacts.length === 0) throw new Error(`No release artifacts found below ${target}`);

const checksums = artifacts.map((file) => `${sha256(file)}  ${path.relative(target, file).replaceAll('\\', '/')}`);
fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`, 'utf8');

const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const packages = [];
function licenseName(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) return value.map(licenseName).filter((item) => item !== 'UNKNOWN').join(' OR ') || 'UNKNOWN';
  if (value && typeof value === 'object') return licenseName(value.type ?? value.name);
  return 'UNKNOWN';
}

for (const [lockPath, record] of Object.entries(lock.packages ?? {})) {
  if (!lockPath.startsWith('node_modules/') || record.dev === true || !record.version) continue;
  const manifestPath = path.join(root, lockPath, 'package.json');
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  packages.push({
    name: manifest.name,
    version: manifest.version,
    license: licenseName(manifest.license ?? record.license),
    repository: typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url,
  });
}

const electronManifest = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8'));
packages.push({
  name: electronManifest.name,
  version: electronManifest.version,
  license: licenseName(electronManifest.license ?? 'MIT'),
  repository: typeof electronManifest.repository === 'string' ? electronManifest.repository : electronManifest.repository?.url,
});

const uniquePackages = [...new Map(packages.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg])).values()]
  .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));

const chromiumManifestPath = path.join(root, '.desktop-resources', 'chromium', 'misgeret-chromium.json');
const chromium = fs.existsSync(chromiumManifestPath)
  ? JSON.parse(fs.readFileSync(chromiumManifestPath, 'utf8'))
  : undefined;

fs.writeFileSync(
  path.join(output, 'third-party-licenses.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), packages: uniquePackages, chromium }, null, 2)}\n`,
  'utf8',
);

const notices = [
  '# Third-party software',
  '',
  'This inventory is generated from the production dependency lockfile used to build Misgeret.',
  '',
  '| Package | Version | License |',
  '|---|---:|---|',
  ...uniquePackages.map((pkg) => `| ${pkg.name} | ${pkg.version} | ${String(pkg.license).replaceAll('|', '\\|')} |`),
];
if (chromium) notices.push('', `Bundled browser: ${chromium.browser ?? 'Chrome for Testing'} (${chromium.sha256 ?? 'hash unavailable'}).`);
fs.writeFileSync(path.join(output, 'THIRD_PARTY_NOTICES.md'), `${notices.join('\n')}\n`, 'utf8');

function component(pkg) {
  const license = String(pkg.license ?? 'UNKNOWN');
  const packagePath = pkg.name.startsWith('@')
    ? `${encodeURIComponent(pkg.name.split('/')[0])}/${encodeURIComponent(pkg.name.split('/')[1])}`
    : encodeURIComponent(pkg.name);
  return {
    type: pkg.name === 'electron' ? 'framework' : 'library',
    name: pkg.name,
    version: pkg.version,
    'bom-ref': `pkg:npm/${packagePath}@${pkg.version}`,
    purl: `pkg:npm/${packagePath}@${pkg.version}`,
    licenses: license === 'UNKNOWN' ? undefined : [{ license: { name: license } }],
    externalReferences: pkg.repository ? [{ type: 'vcs', url: String(pkg.repository).replace(/^git\+/, '') }] : undefined,
  };
}

const components = uniquePackages.map(component);
if (chromium) {
  components.push({
    type: 'application',
    name: 'Chrome for Testing',
    version: String(chromium.browser ?? 'unknown').replace(/^Chrome\//, ''),
    'bom-ref': `chrome-for-testing:${chromium.sha256 ?? 'unknown'}`,
    hashes: chromium.sha256 ? [{ alg: 'SHA-256', content: chromium.sha256 }] : undefined,
  });
}

const rootManifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: { type: 'application', name: rootManifest.name, version: rootManifest.version },
  },
  components,
};
fs.writeFileSync(path.join(output, 'sbom.cdx.json'), `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');

console.log(`Release metadata generated for ${artifacts.length} artifact(s) in ${output}.`);
