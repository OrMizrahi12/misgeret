import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(root, 'out', 'Misgeret-win32-x64', 'Misgeret.exe');

export function createLaunchEnvironment(
  projectRoot,
  baseEnvironment = process.env,
  currentDirectory = process.cwd(),
) {
  const configuredRoot = baseEnvironment.MISGERET_DATA_ROOT?.trim();
  const dataRoot = configuredRoot
    ? path.resolve(currentDirectory, configuredRoot)
    : path.join(projectRoot, '.desktop-smoke', 'profile');

  return {
    ...baseEnvironment,
    MISGERET_DATA_ROOT: dataRoot,
    MISGERET_ALLOW_DATA_ROOT_OVERRIDE: '1',
    MOCK_BANK: baseEnvironment.MOCK_BANK?.trim() || '1',
    MISGERET_FIRST_RUN_ACTION: baseEnvironment.MISGERET_FIRST_RUN_ACTION?.trim() || 'new',
  };
}

export function launchPackagedDesktop(args = process.argv.slice(2)) {
  if (process.platform !== 'win32') throw new Error('Misgeret desktop v1 runs on Windows x64 only.');
  if (!fs.existsSync(executable)) throw new Error(`Packaged executable is missing: ${executable}`);

  const child = spawn(executable, args, {
    cwd: path.dirname(executable),
    env: createLaunchEnvironment(root),
    stdio: 'inherit',
    windowsHide: false,
  });

  child.once('error', (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    if (signal) console.error(`Misgeret exited after signal ${signal}.`);
    process.exitCode = code ?? 1;
  });

  return child;
}

const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (entryPoint?.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  launchPackagedDesktop();
}
