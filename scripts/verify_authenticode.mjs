import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedPublisher = process.env.MISGERET_WINDOWS_PUBLISHER?.trim();
if (!expectedPublisher) throw new Error('MISGERET_WINDOWS_PUBLISHER is required to verify signed artifacts.');

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}

const executables = [
  path.join(root, 'out', 'Misgeret-win32-x64', 'Misgeret.exe'),
  ...walk(path.join(root, 'out', 'make')).filter((file) => file.toLowerCase().endsWith('.exe')),
].filter((file, index, all) => fs.existsSync(file) && all.indexOf(file) === index);

if (executables.length < 2 || !executables.some((file) => path.basename(file) === 'MisgeretSetup.exe')) {
  throw new Error('Expected signed Misgeret.exe and MisgeretSetup.exe artifacts were not found.');
}

const command = [
  '$signature = Get-AuthenticodeSignature -LiteralPath $args[0];',
  '[pscustomobject]@{',
  'Status = [string]$signature.Status;',
  'Subject = [string]$signature.SignerCertificate.Subject',
  '} | ConvertTo-Json -Compress',
].join(' ');

for (const executable of executables) {
  const output = execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command,
    executable,
  ], { encoding: 'utf8', windowsHide: true }).trim();
  const signature = JSON.parse(output);
  if (signature.Status !== 'Valid') throw new Error(`Authenticode signature is not valid: ${path.basename(executable)}`);
  if (typeof signature.Subject !== 'string' || !signature.Subject.includes(expectedPublisher)) {
    throw new Error(`Authenticode publisher mismatch: ${path.basename(executable)}`);
  }
}

console.log(`Authenticode verified for ${executables.length} executable(s).`);
