/**
 * One-off surgery: delete a category rule from the ACTIVE profile AND undo what it filed.
 *
 * A bare `DELETE FROM category_rules` is not enough — categories are resolved once, at sync, and
 * STORED on the row. The rule "כרטיס דביט → fees" had already stamped 235 real purchases; removing
 * the rule alone left every one of them filed as a bank fee (verified: the עמלות metric did not
 * move a shekel). So this runs the same three steps the app's own `DELETE /rules/:id?revert=1`
 * route runs, in the same order, using the same tested db methods:
 *
 *   1. deleteRule            — the rule itself
 *   2. revertRuleApplications — clear category on the rows this rule (and only this rule) stamped
 *   3. resolveCategory       — re-file those rows through the normal ladder, so the
 *                              zero-uncategorized guarantee still holds
 *
 * Runs OUTSIDE the agent's MSIX container (scheduled task): writes to %APPDATA% from inside it are
 * virtualized into a shadow copy the real app never reads.
 *
 *   node scripts/delete_category_rule.mjs "<pattern>" "<category>"
 */
import fs from 'node:fs';
import path from 'node:path';
import { FinanceDb } from '../server/dist/db.js';
import { resolveCategory } from '../server/dist/categories.js';

/**
 * The target comes from a UTF-8 JSON file, not from argv, when `--from` is used: a rule pattern is
 * Hebrew, and Hebrew on a Windows command line through schtasks/cmd is how this repo has been
 * burned before (see deploy_local.mjs). The file path is pure ASCII; the Hebrew never touches the
 * wire. `{"pattern": "...", "category": "..."}`.
 */
let [pattern, category] = process.argv.slice(2);
if (pattern === '--from') {
  const spec = JSON.parse(fs.readFileSync(category, 'utf8'));
  ({ pattern, category } = spec);
}
if (!pattern || !category) {
  console.error('usage: delete_category_rule.mjs "<pattern>" "<category>"  |  --from <spec.json>');
  process.exit(2);
}

// DATA_DIR mirrors the server's own override — it is what lets this be rehearsed against a COPY
// of the real profile before it is ever pointed at the real one.
const dataDir = process.env.DATA_DIR ?? path.join(process.env.APPDATA ?? '', 'misgeret', 'data');
const registry = JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8'));
const dbPath = path.join(dataDir, 'profiles', registry.activeId, 'finance.db');
console.log('profile:', registry.profiles.find((p) => p.id === registry.activeId)?.name, '·', dbPath);

const db = new FinanceDb(dbPath);
const rule = db.getRules().find((r) => r.pattern === pattern && r.category === category);
if (!rule) {
  console.log(`NOTHING TO DO: no rule "${pattern}" -> ${category}`);
  process.exit(0);
}

/** Mirrors routes.ts resolveContext() — the same two tiers the live route feeds resolveCategory. */
const context = {
  hints: (() => {
    const priority = { user: 3, rule: 2, issuer: 1 };
    const best = new Map();
    for (const r of db.getTxnsSinceMonth('0000-00')) {
      if (!r.category || r.category === 'other') continue;
      const p = priority[r.categorySource ?? ''] ?? 0;
      if (p === 0) continue;
      const m = r.description.replace(/[0-9]/g, ' ').replace(/\s+/g, ' ').trim();
      if (m.length < 2) continue;
      const hit = best.get(m);
      if (!hit || p > hit.p) best.set(m, { category: r.category, p });
    }
    return new Map([...best].map(([m, v]) => [m, v.category]));
  })(),
  sectorOverrides: new Map(db.getSectorOverrides().map((o) => [o.sector, o.category])),
};

console.log(`rule #${rule.id} "${rule.pattern}" -> ${rule.category}`);
db.deleteRule(rule.id);
const reverted = db.revertRuleApplications(rule.pattern, rule.category);
console.log('rows un-filed:', reverted);

const repaired = db.getUncategorizedSinceMonth('0000-00').map((t) => {
  const resolved = resolveCategory(t, db.getRules(), context);
  return { key: t.key, category: resolved.category, source: resolved.source };
});
db.setResolvedCategories(repaired);

const counts = {};
for (const r of repaired) counts[r.category] = (counts[r.category] ?? 0) + 1;
console.log('re-filed:', repaired.length, JSON.stringify(counts));
console.log('rules left:', db.getRules().map((r) => `${r.pattern}->${r.category}`).join(' · ') || '(none)');
