import fs from 'node:fs';
import path from 'node:path';

const [sourceArgument, destinationArgument, platform = process.platform, arch = process.arch, versionArgument] = process.argv.slice(2);
if (!sourceArgument || !destinationArgument) {
  throw new Error('Usage: collect_release_assets.mjs <make-dir> <destination> [platform] [arch] [version]');
}

const source = path.resolve(sourceArgument);
const destination = path.resolve(destinationArgument);
const version = versionArgument ?? JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version;
const allowedPlatforms = new Set(['win32', 'darwin', 'linux']);
if (!allowedPlatforms.has(platform) || !/^(?:x64|arm64)$/.test(arch) || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid release target ${platform}/${arch} or version ${version}.`);
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : entry.isFile() ? [absolute] : [];
  });
}

const files = walk(source);
const selected = [];
if (platform === 'win32') {
  const setup = files.find((file) => path.basename(file).toLowerCase() === 'misgeretsetup.exe');
  const releases = files.find((file) => path.basename(file) === 'RELEASES');
  const nupkg = files.find((file) => /-full\.nupkg$/i.test(file));
  if (!setup || !releases || !nupkg) throw new Error('Windows release requires Setup.exe, RELEASES and a full nupkg.');
  selected.push([setup, 'MisgeretSetup.exe'], [releases, 'RELEASES'], [nupkg, path.basename(nupkg)]);
} else if (platform === 'darwin') {
  const dmg = files.find((file) => file.toLowerCase().endsWith('.dmg'));
  const zip = files.find((file) => file.toLowerCase().endsWith('.zip'));
  if (!dmg || !zip) throw new Error('macOS release requires both DMG and ZIP.');
  selected.push(
    [dmg, `Misgeret-${version}-macOS-${arch}.dmg`],
    [zip, `Misgeret-${version}-macOS-${arch}.zip`],
  );
} else {
  const deb = files.find((file) => file.toLowerCase().endsWith('.deb'));
  const rpm = files.find((file) => file.toLowerCase().endsWith('.rpm'));
  if (!deb || !rpm) throw new Error('Linux release requires both DEB and RPM.');
  selected.push(
    [deb, `Misgeret-${version}-Linux-${arch}.deb`],
    [rpm, `Misgeret-${version}-Linux-${arch}.rpm`],
  );
}

fs.mkdirSync(destination, { recursive: true });
for (const [sourceFile, outputName] of selected) {
  fs.copyFileSync(sourceFile, path.join(destination, outputName));
}
console.log(`Collected ${selected.length} ${platform}/${arch} release assets in ${destination}.`);
