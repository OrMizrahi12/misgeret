import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { createPackagerIgnore } from './scripts/desktop_artifact_policy.mjs';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const windowsIconPath = path.join(root, 'desktop', 'assets', 'icon.ico');
const macIconPath = path.join(root, 'desktop', 'assets', 'icon.icns');
const linuxIconPath = path.join(root, 'desktop', 'assets', 'icon.png');
const iconPath = process.platform === 'darwin' ? macIconPath : process.platform === 'linux' ? linuxIconPath : windowsIconPath;
const executableName = process.platform === 'linux' ? 'misgeret' : 'Misgeret';
const chromiumSource = path.join(root, '.desktop-resources', 'chromium');
const expectedElectronVersion = '42.6.1';
const expectedBetterSqliteVersion = '12.11.1';
const expectedBetterSqliteSha256 = '24e2e3ca5a829572239718fbca35b873ba4975655d29c56a93f1880e3775d9b8';
const certificateFile = process.env.MISGERET_WINDOWS_CERTIFICATE_FILE?.trim();
const certificatePassword = process.env.MISGERET_WINDOWS_CERTIFICATE_PASSWORD;
// When set, Squirrel downloads the currently published packages from the live feed and
// emits a delta .nupkg alongside the full one, so customers download megabytes, not the
// whole app. The publish pipeline sets this only after probing that the feed exists.
const remoteReleases = process.env.MISGERET_REMOTE_RELEASES?.trim();
if (remoteReleases && new URL(remoteReleases).protocol !== 'https:') {
  throw new Error('MISGERET_REMOTE_RELEASES must be an HTTPS URL.');
}

if ((certificateFile && !certificatePassword) || (!certificateFile && certificatePassword)) {
  throw new Error('Both MISGERET_WINDOWS_CERTIFICATE_FILE and MISGERET_WINDOWS_CERTIFICATE_PASSWORD are required for signing.');
}

async function stageBetterSqlite3Async(
  buildPath: string,
  electronVersion: string,
  platform: string,
  arch: string,
): Promise<void> {
  const supportedTargets = new Set(['win32/x64', 'darwin/x64', 'darwin/arm64', 'linux/x64']);
  if (!supportedTargets.has(`${platform}/${arch}`)) throw new Error(`Unsupported Misgeret target: ${platform}/${arch}.`);
  if (electronVersion !== expectedElectronVersion) {
    throw new Error(`Electron drift detected: expected ${expectedElectronVersion}, got ${electronVersion}.`);
  }

  const moduleDir = path.join(buildPath, 'node_modules', 'better-sqlite3');
  if (!fs.existsSync(moduleDir)) throw new Error(`Packaged better-sqlite3 module is missing from ${moduleDir}.`);
  const modulePackage = JSON.parse(fs.readFileSync(path.join(moduleDir, 'package.json'), 'utf8')) as { version?: unknown };
  if (modulePackage.version !== expectedBetterSqliteVersion) {
    throw new Error(`better-sqlite3 drift detected: expected ${expectedBetterSqliteVersion}, got ${String(modulePackage.version)}.`);
  }

  const cliCandidates = [
    path.join(buildPath, 'node_modules', 'prebuild-install', 'bin.js'),
    path.join(root, 'node_modules', 'prebuild-install', 'bin.js'),
  ];
  const cli = cliCandidates.find((candidate) => fs.existsSync(candidate));
  if (!cli) throw new Error('prebuild-install CLI is missing; refusing to fall back to node-gyp.');

  await execFileAsync(process.execPath, [
    cli,
    '--runtime=electron',
    `--target=${electronVersion}`,
    `--arch=${arch}`,
    `--platform=${platform}`,
    '--force',
  ], {
    cwd: moduleDir,
    env: {
      ...process.env,
      npm_config_runtime: 'electron',
      npm_config_target: electronVersion,
      npm_config_arch: arch,
      npm_config_platform: platform,
      npm_config_build_from_source: 'false',
    },
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });

  const binary = path.join(moduleDir, 'build', 'Release', 'better_sqlite3.node');
  if (!fs.existsSync(binary) || fs.statSync(binary).size < 100_000) {
    throw new Error('Electron ABI146 better_sqlite3.node was not staged correctly.');
  }
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  if (platform === 'win32' && arch === 'x64' && sha256 !== expectedBetterSqliteSha256) {
    throw new Error(`Unexpected better-sqlite3 Electron prebuild checksum: ${sha256}.`);
  }
  fs.writeFileSync(path.join(buildPath, 'desktop-native-build.json'), `${JSON.stringify({
    electronVersion,
    electronAbi: 146,
    platform,
    arch,
    module: 'better-sqlite3',
    binary: 'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    sha256,
  }, null, 2)}\n`);
}

// Electron Packager's afterCopy contract is callback-based. Returning a Promise here
// makes Node's promisify leave Finalizing package pending with no active event handle.
function stageBetterSqlite3(
  buildPath: string,
  electronVersion: string,
  platform: string,
  arch: string,
  callback: (error?: Error) => void,
): void {
  void stageBetterSqlite3Async(buildPath, electronVersion, platform, arch).then(
    () => callback(),
    (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
  );
}

const config: ForgeConfig = {
  outDir: 'out',
  packagerConfig: {
    name: 'Misgeret',
    executableName,
    appBundleId: 'com.misgeret.desktop',
    appCopyright: 'Copyright © Misgeret',
    icon: iconPath,
    asar: true,
    prune: true,
    extraResource: [chromiumSource],
    afterCopy: [stageBetterSqlite3],
    // A fail-closed root allowlist keeps local metadata and user data out even
    // when a new directory is added to the repository in the future.
    ignore: createPackagerIgnore(root),
    win32metadata: {
      CompanyName: 'Misgeret',
      FileDescription: 'מסגרת — תמונת מצב פיננסית מקומית',
      InternalName: 'Misgeret',
      OriginalFilename: 'Misgeret.exe',
      ProductName: 'מסגרת',
    },
    ...(certificateFile ? {
      windowsSign: { certificateFile, certificatePassword },
    } : {}),
  },
  // Native binaries are staged deterministically in afterCopy. An empty allow-list makes
  // Forge's mandatory @electron/rebuild phase a no-op and prevents a node-gyp fallback.
  rebuildConfig: { onlyModules: [] },
  makers: [
    new MakerSquirrel({
      name: 'misgeret',
      authors: 'Misgeret',
      description: 'מסגרת — תמונת מצב פיננסית מקומית',
      setupExe: 'MisgeretSetup.exe',
      setupIcon: windowsIconPath,
      noMsi: true,
      ...(remoteReleases ? { remoteReleases } : {}),
      ...(certificateFile ? { certificateFile, certificatePassword } : {}),
    }),
    new MakerDMG({
      name: 'Misgeret',
      icon: macIconPath,
      overwrite: true,
    }),
    new MakerZIP({}, ['darwin']),
    new MakerDeb({ options: {
      name: 'misgeret',
      productName: 'Misgeret',
      genericName: 'Personal Finance',
      description: 'Local-first personal finance for Israeli households',
      productDescription: 'Open-source, local-first financial awareness for Israeli households.',
      maintainer: 'Or Mizrahi',
      homepage: 'https://github.com/OrMizrahi12/misgeret',
      icon: linuxIconPath,
      categories: ['Office'],
    } }),
    new MakerRpm({ options: {
      name: 'misgeret',
      productName: 'Misgeret',
      genericName: 'Personal Finance',
      description: 'Local-first personal finance for Israeli households',
      productDescription: 'Open-source, local-first financial awareness for Israeli households.',
      license: 'MIT',
      homepage: 'https://github.com/OrMizrahi12/misgeret',
      icon: linuxIconPath,
      categories: ['Office'],
    } }),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
  hooks: {
    prePackage: async () => {
      const chromiumManifest = path.join(chromiumSource, 'misgeret-chromium.json');
      if (!fs.existsSync(chromiumManifest)) {
        throw new Error('Bundled Chromium is missing. Run the Chromium preparation script before packaging.');
      }
      const module = await import('./desktop/build.mjs') as { buildDesktop(): Promise<void> };
      await module.buildDesktop();
    },
  },
};

export default config;
