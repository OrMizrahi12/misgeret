import { Hourglass } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Amount } from './Amount';
import { api, errorMessageHe } from './api';
import { CardChip } from './CardChip';
import type { ReviewTxn } from './types';
import { CATEGORIES } from './types';

/** Client-side mirror of the server's rule-pattern suggestion (strip digits/punctuation/בע"מ). */
export function suggestPattern(description: string): string {
  return description
    .replace(/בע["״׳']?מ/g, ' ')
    .replace(/[0-9]/g, ' ')
    .replace(/[["'״׳().,:;/\\#*_\-\]]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && w !== 'בעמ')
    .join(' ')
    .trim();
}

interface Undoable {
  key: string;
  description: string;
  categoryHe: string;
  ruleId?: number;
}

export function Review({ onBack }: { onBack: () => void }) {
  const [txns, setTxns] = useState<ReviewTxn[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [makeRule, setMakeRule] = useState(true);
  const [pattern, setPattern] = useState('');
  const [preview, setPreview] = useState<number | null>(null);
  const [undo, setUndo] = useState<Undoable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    const res = await api.review();
    setTxns(res.txns);
    setSelected(null);
    setMakeRule(true);
  }

  useEffect(() => {
    load().catch((e) => setError(errorMessageHe(e)));
  }, []);

  const current = txns?.[0] ?? null;

  // the pattern follows the head of the queue (skip/save/reorder all change it)
  useEffect(() => {
    setPattern(current ? suggestPattern(current.description) : '');
    setSelected(null);
  }, [current?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // "this rule would catch N more transactions" — before committing to it
  useEffect(() => {
    const p = pattern.trim();
    if (!makeRule || p.length < 2) {
      setPreview(null);
      return;
    }
    const t = setTimeout(() => {
      api.rulePreview(p).then((r) => setPreview(r.count)).catch(() => setPreview(null));
    }, 300);
    return () => clearTimeout(t);
  }, [pattern, makeRule]);

  function skip() {
    // not sure what this is? it should not block the whole queue — rotate it to the end
    setTxns((prev) => (prev && prev.length > 1 ? [...prev.slice(1), prev[0]] : prev));
  }

  function bringToFront(key: string) {
    setTxns((prev) => {
      if (!prev) return prev;
      const hit = prev.find((t) => t.key === key);
      return hit ? [hit, ...prev.filter((t) => t.key !== key)] : prev;
    });
  }

  async function save() {
    if (!current || !selected) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.setTxnCategory(current.key, {
        category: selected,
        ...(makeRule && pattern.trim().length >= 2 ? { rulePattern: pattern.trim() } : {}),
      });
      setUndo({
        key: current.key,
        description: current.description,
        categoryHe: CATEGORIES.find((c) => c.id === selected)?.nameHe ?? selected,
        ruleId: res.ruleId,
      });
      await load();
    } catch (e) {
      setError(errorMessageHe(e));
    } finally {
      setSaving(false);
    }
  }

  async function undoLast() {
    if (!undo) return;
    setError(null);
    try {
      await api.clearTxnCategory(undo.key);
      // revert=1 also un-categorizes everything the rule touched retroactively — a full undo
      if (undo.ruleId !== undefined) await api.deleteRule(undo.ruleId, true);
      setUndo(null);
      await load();
    } catch (e) {
      setError(errorMessageHe(e));
    }
  }

  return (
    <div>
      <div className="toolbar">
        <h2 style={{ margin: 0, flex: 1 }}>לחידוד {txns ? `· ${txns.length}` : ''}</h2>
        <button className="link" onClick={onBack}>חזרה לדשבורד</button>
      </div>

      {error && <p className="error">{error}</p>}
      {undo && (
        <div className="review-banner">
          <span>"{undo.description}" סווג כ{undo.categoryHe} ✓{undo.ruleId !== undefined ? ' (כולל חוק)' : ''}</span>
          <button onClick={undoLast}>ביטול</button>
        </div>
      )}
      {!txns && !error && <p className="muted">טוען…</p>}
      {txns && txns.length === 0 && <p className="muted">אין מה לחדד — כל העסקאות מסווגות לקטגוריה מדויקת. ✓</p>}

      {current && (
        <div className="card review-item">
          <div className="review-meta">
            <span className="txn-date">
              {new Date(current.date).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'Asia/Jerusalem' })}
            </span>
            <span className="txn-desc">
              {current.description}
              <span className="muted"> · {current.connectionLabel}</span>
              {current.issuerCategory && <span className="tag">הסוג מחברת הכרטיס: {current.issuerCategory}</span>}
            </span>
            <Amount value={current.amount} tone={current.amount >= 0 ? 'positive' : undefined} />
          </div>

          <div className="chips">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                className={selected === c.id ? 'chip selected' : 'chip'}
                onClick={() => setSelected(c.id)}
              >
                {c.nameHe}
              </button>
            ))}
          </div>

          <div className="rule-row">
            <input
              type="checkbox"
              id="make-rule"
              checked={makeRule}
              onChange={(e) => setMakeRule(e.target.checked)}
            />
            <label htmlFor="make-rule" style={{ flexDirection: 'row' }}>צור חוק לתבנית:</label>
            <input type="text" dir="rtl" value={pattern} onChange={(e) => setPattern(e.target.value)} disabled={!makeRule} />
            {makeRule && preview !== null && (
              <span className="muted">יחול על {preview} עסקאות</span>
            )}
          </div>

          <div className="actions">
            <button className="primary" onClick={save} disabled={!selected || saving}>
              {saving ? 'שומר…' : 'שמירה והמשך'}
            </button>
            {txns && txns.length > 1 && (
              <button className="link" onClick={skip} disabled={saving} title="לא בטוח? העסקה תחזור בסוף התור">
                דלג לבינתיים
              </button>
            )}
          </div>
        </div>
      )}

      {txns && txns.length > 1 && (
        <div className="card">
          <CardChip icon={Hourglass} />
          <div className="label">הבאות בתור</div>
          <ul className="txns">
            {txns.slice(1, 9).map((t) => (
              <li className="txn" key={t.key} style={{ cursor: 'pointer' }} onClick={() => bringToFront(t.key)}>
                <span className="txn-date">
                  {new Date(t.date).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'Asia/Jerusalem' })}
                </span>
                <span className="txn-desc">
                  {t.description}
                  <span className="muted"> · {t.connectionLabel}</span>
                </span>
                <Amount value={t.amount} tone={t.amount >= 0 ? 'positive' : undefined} />
              </li>
            ))}
          </ul>
          {txns.length > 9 && <p className="muted">ועוד {txns.length - 9}… לחיצה על שורה מקפיצה אותה לטיפול.</p>}
        </div>
      )}
    </div>
  );
}
