import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, '.build', 'misgeret-build.json');
const destinationDirectory = process.argv[2] ? path.resolve(root, process.argv[2]) : undefined;

if (!destinationDirectory) throw new Error('Usage: node scripts/copy_build_manifest.mjs <build-directory>');
if (!fs.existsSync(source)) throw new Error('Shared build manifest is missing. Run generate_build_manifest.mjs first.');
if (!fs.existsSync(destinationDirectory)) throw new Error(`Build directory is missing: ${destinationDirectory}`);

const manifest = JSON.parse(fs.readFileSync(source, 'utf8'));
if (typeof manifest.buildId !== 'string' || !manifest.buildId) throw new Error('Shared build manifest has no buildId.');
fs.copyFileSync(source, path.join(destinationDirectory, 'build-manifest.json'));
