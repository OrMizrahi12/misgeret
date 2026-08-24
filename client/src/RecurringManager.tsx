import { useEffect, useState } from 'react';
import { Amount } from './Amount';
import { api, errorMessageHe } from './api';
import { CategoryTag } from './CategoryTxns';
import type { RecurringItem } from './types';
import { CADENCE_NAME_HE } from './types';

const ILS0 = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });

function dayLabel(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });
}

/** Tags that explain an item's rhythm and confidence at a glance. */
function ItemTags({ r }: { r: RecurringItem }) {
  return (
    <>
      {r.category && <CategoryTag id={r.category} />}
      {r.cadence !== 'monthly' && <span className="tag">{CADENCE_NAME_HE[r.cadence]}</span>}
      {r.installmentPlan && (
        <span className="tag" title="פריסת תשלומים של קנייה אחת — חוב עם סוף ידוע, לא מנוי">תשלומים</span>
      )}
      {!r.active && (
        <span className="tag" title="לא נראתה חיוב חדש זמן רב — לא נספר בתוכנית, בתחזית ובמדדים">הסתיים</span>
      )}
      {r.provisional && <span className="tag warn">מסתמן — פעמיים עד כה</span>}
      {!r.amountStable && (
        <span className="tag" title={`נע לאחרונה בין ${ILS0.format(r.amountMin)} ל-${ILS0.format(r.amountMax)}`}>
          סכום משתנה
        </span>
      )}
    </>
  );
}

/**
 * The engine room: the recurring income/expense streams the detection engine found, and the
 * mute lever for wrong detections. Everything downstream — the monthly plan, the health
 * metrics and forecasts — reads these streams; a wrong one gets fixed here in Settings.
 */
export function RecurringManager() {
  const [income, setIncome] = useState<RecurringItem[]>([]);
  const [expenses, setExpenses] = useState<RecurringItem[]>([]);
  const [muted, setMuted] = useState<RecurringItem[]>([]);
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const data = await api.cashflow();
      const byLiveness = (a: RecurringItem, b: RecurringItem) => Number(b.active) - Number(a.active);
      setIncome(data.recurring.filter((r) => r.kind === 'income' && !r.excludedFlow).sort(byLiveness));
      setExpenses(data.recurring.filter((r) => r.kind === 'expense' && !r.excludedFlow).sort(byLiveness));
      setMuted(data.muted);
    } catch (e) {
      setError(errorMessageHe(e));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function mute(r: RecurringItem) {
    setError(null);
    try {
      await api.muteRecurring(r.merchant, r.kind);
      await load();
    } catch (e) {
      setError(errorMessageHe(e));
    }
  }

  async function unmute(r: RecurringItem) {
    setError(null);
    try {
      await api.unmuteRecurring(r.merchant, r.kind);
      await load();
    } catch (e) {
      setError(errorMessageHe(e));
    }
  }

  return (
    <div className="card">
      <button className="link" onClick={() => setShow((v) => !v)} aria-expanded={show}>
        {show ? 'הסתר' : 'הצג'} ניהול החיובים הקבועים · {income.length} הכנסות · {expenses.length} הוצאות
        {muted.length > 0 ? ` · ${muted.length} מושתקים` : ''}
      </button>
      {error && <p className="error" style={{ marginTop: 8 }}>{error}</p>}
      {show && (
        <>
          <p className="muted" style={{ margin: '10px 0 0' }}>
            החיובים וההכנסות שחוזרים כל חודש, כפי שהמנוע זיהה — התוכנית והמדדים בנויים מהם. זיהוי שגוי? "לא חוזר" מתקן הכל.
          </p>
          <div className="label" style={{ marginTop: 14 }}>הכנסות</div>
          {income.length === 0 && <p className="muted">טרם זוהו.</p>}
          <ul className="txns">
            {income.map((r) => (
              <li className="txn" key={`${r.merchant}+`}>
                <span className="txn-date num">יום {r.dayOfMonth}</span>
                <span className="txn-desc">
                  {r.merchant}
                  <ItemTags r={r} />
                </span>
                <Amount value={r.amount} tone="positive" />
                <button className="link danger" onClick={() => mute(r)} title="זיהוי שגוי? הפריט יוסתר מהתוכנית ומהמדדים (אפשר להחזיר למטה)">לא חוזר</button>
              </li>
            ))}
          </ul>
          <div className="label" style={{ marginTop: 14 }}>הוצאות ומנויים</div>
          {expenses.length === 0 && <p className="muted">טרם זוהו.</p>}
          <ul className="txns">
            {expenses.map((r) => (
              <li className="txn" key={`${r.merchant}-`}>
                <span className="txn-date num">יום {r.dayOfMonth}</span>
                <span className="txn-desc">
                  {r.merchant}
                  <ItemTags r={r} />
                  {r.active
                    ? <span className="muted"> · הבא: {dayLabel(r.nextDate)}</span>
                    : <span className="muted"> · אחרון: {dayLabel(r.lastDate)}</span>}
                  {r.cadence !== 'monthly' && (
                    <span className="muted"> · {ILS0.format(-r.monthlyAmount)}/חודש בממוצע</span>
                  )}
                </span>
                <Amount value={r.amount} />
                <button className="link danger" onClick={() => mute(r)} title="זיהוי שגוי? הפריט יוסתר מהתוכנית ומהמדדים (אפשר להחזיר למטה)">לא חוזר</button>
              </li>
            ))}
          </ul>
          {muted.length > 0 && (
            <>
              <div className="label" style={{ marginTop: 14 }}>מושתקים</div>
              <ul className="txns">
                {muted.map((r) => (
                  <li className="txn muted-txn" key={`${r.merchant}|${r.kind}`}>
                    <span className="txn-desc">{r.merchant}<ItemTags r={r} /></span>
                    <Amount value={r.amount} />
                    <button className="link" onClick={() => unmute(r)}>בטל השתקה</button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
