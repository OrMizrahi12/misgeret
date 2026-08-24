// Reports the REAL installed app's data layout — from outside the MSIX container.
//
// Claude Code sessions run inside the Claude desktop MSIX container, where %APPDATA% is
// virtualized: an in-session `dir` can show a stale ghost of a file the real app already
// moved, and opening the real database fails outright. Any claim about the user's actual
// data must therefore be made from a Windows Scheduled Task, which runs in the real
// session. Results come back through C:\Users\Public (real, shared, ASCII, space-free).
//
// Usage:  node scripts/verify_local_data.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = 'C:\\Users\\Public\\misgeret-verify';
const taskName = 'MisgeretVerifyData';

// Runs in the real session: reads the registry and every profile database it names, so the
// answer is about the user's money and not about a virtualized copy of it.
const inspector = `
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('${path.join(repo, 'noop.js').replace(/\\/g, '\\\\')}');
const Database = require('better-sqlite3');
const dataDir = path.join(process.env.APPDATA, 'Misgeret', 'data');
const out = [];
const say = (line) => out.push(line);

say('dataDir: ' + dataDir);
say('root entries: ' + fs.readdirSync(dataDir).join(', '));

const registryPath = path.join(dataDir, 'profiles.json');
if (!fs.existsSync(registryPath)) {
  say('FAIL: no profiles.json — the migration never ran');
} else {
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  say('activeId: ' + registry.activeId);
  for (const profile of registry.profiles) {
    const dbFile = path.join(dataDir, 'profiles', profile.id, 'finance.db');
    let detail = 'MISSING DATABASE';
    try {
      const db = new Database(dbFile, { readonly: true, fileMustExist: true });
      const count = (sql) => db.prepare(sql).get().n;
      const span = db.prepare('SELECT MIN(month) a, MAX(month) b FROM transactions').get();
      const sync = db.prepare("SELECT value FROM settings WHERE key='lastSyncAt'").get();
      // Which institutions, not just how many: the app's behaviour differs per company (bank vs card),
      // and assuming the wrong one is how a design ends up describing a bank the user never had.
      const at = db.prepare('SELECT company, nickname FROM connections ORDER BY id').all()
        .map((c) => c.company + (c.nickname ? ' (' + c.nickname + ')' : '')).join(', ');
      detail = [
        'txns=' + count('SELECT COUNT(*) n FROM transactions'),
        'connections=' + count('SELECT COUNT(*) n FROM connections') + (at ? ' [' + at + ']' : ''),
        'assets=' + count('SELECT COUNT(*) n FROM assets'),
        'goals=' + count('SELECT COUNT(*) n FROM savings_goals'),
        'months=' + span.a + '..' + span.b,
        'lastSync=' + (sync ? sync.value : 'never'),
        'bytes=' + fs.statSync(dbFile).size,
      ].join(' ');
      db.close();
    } catch (err) {
      detail = 'OPEN FAILED: ' + err.message;
    }
    say('profile "' + profile.name + '" [' + profile.id + '] ' + detail);
    const backups = path.join(dataDir, 'profiles', profile.id, 'backups');
    say('  backups: ' + (fs.existsSync(backups) ? fs.readdirSync(backups).length + ' file(s)' : 'none'));
  }
}

const strayDb = path.join(dataDir, 'finance.db');
say(fs.existsSync(strayDb)
  ? 'STRAY legacy finance.db still at the root: ' + fs.statSync(strayDb).size + ' bytes'
  : 'no stray legacy finance.db at the root (migration moved it)');
for (const extra of ['quarantine', 'deleted-profiles', 'backups']) {
  const dir = path.join(dataDir, extra);
  if (fs.existsSync(dir)) say(extra + '/: ' + fs.readdirSync(dir).join(', '));
}

fs.writeFileSync('${base.replace(/\\/g, '\\\\')}\\\\report.txt', out.join('\\n') + '\\n', 'utf8');
`;

const wrapper = [
  '@echo off',
  'setlocal',
  `set BASE=${base}`,
  'del /q "%BASE%\\report.txt" 2>nul',
  `node "%BASE%\\inspect.mjs" > "%BASE%\\stderr.log" 2>&1`,
  'echo done > "%BASE%\\status.txt"',
  '',
].join('\r\n');

fs.mkdirSync(base, { recursive: true });
fs.writeFileSync(path.join(base, 'inspect.mjs'), inspector, 'utf8');
fs.writeFileSync(path.join(base, 'verify.cmd'), wrapper, 'ascii');
for (const file of ['status.txt', 'report.txt', 'stderr.log']) fs.rmSync(path.join(base, file), { force: true });

execFileSync('schtasks', ['/Create', '/TN', taskName, '/TR', `${base}\\verify.cmd`, '/SC', 'ONCE', '/ST', '23:59', '/F'], { stdio: 'ignore' });
execFileSync('schtasks', ['/Run', '/TN', taskName], { stdio: 'ignore' });

const deadline = Date.now() + 90_000;
while (Date.now() < deadline && !fs.existsSync(path.join(base, 'status.txt'))) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
try {
  execFileSync('schtasks', ['/Delete', '/TN', taskName, '/F'], { stdio: 'ignore' });
} catch {
  // already gone
}

const reportPath = path.join(base, 'report.txt');
if (!fs.existsSync(reportPath)) {
  const stderr = fs.existsSync(path.join(base, 'stderr.log'))
    ? fs.readFileSync(path.join(base, 'stderr.log'), 'utf8')
    : '(no output)';
  console.error('the inspector produced no report:');
  console.error(stderr);
  process.exit(1);
}
console.log(fs.readFileSync(reportPath, 'utf8'));
