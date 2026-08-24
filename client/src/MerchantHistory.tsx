import { useEffect, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessageHe } from './api';
import { categoryColor } from './charts';
import type { MerchantChargeHistory, TxnMark } from './types';
import { categoryNameHe } from './types';

const ILS0 = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });

/** Local-noon parse keeps a YYYY-MM(-DD) on its own calendar day regardless of timezone. */
export function monthHe(ym: string): string {
  return new Date(`${ym}-01T12:00:00`).toLocaleDateString('he-IL', { month: 'short', year: '2-digit' });
}
function dateHe(d: string): string {
  return new Date(`${d}T12:00:00`).toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Everything the chart needs — a structural subset both a merchant's charges and a category's
 *  months satisfy. One chart, two callers, no fork. */
export interface ChargeSeries {
  charges: { date: string; month: string; amount: number }[];
  count: number;
  typicalAmount: number;
  minAmount: number;
  maxAmount: number;
  varied: boolean;
}

/** The charge-over-time chart — one bar per past charge, oldest→newest (LTR, like every time series).
 *  A dashed line marks the typical (median) charge, so a spike or a step-up reads at a glance.
 *  `monthly` switches the unit: a bar is a whole month, and the readout counts months, not charges. */
export function ChargeChart({ data, hover, setHover, monthly = false }: {
  data: ChargeSeries;
  hover: number | null;
  setHover: (i: number | null) => void;
  monthly?: boolean;
}) {
  const { charges, maxAmount, typicalAmount } = data;
  const max = Math.max(maxAmount, 1);
  const typicalPct = Math.round((typicalAmount / max) * 100);
  const active = hover != null ? charges[hover] : null;

  return (
    <div className="mh-chart">
      <div className="mh-readout">
        {active ? (
          <><strong>{ILS0.format(active.amount)}</strong> · {monthly ? monthHe(active.month) : dateHe(active.date)}</>
        ) : (
          <>
            בדרך כלל <strong>{ILS0.format(typicalAmount)}</strong> · {data.count} {monthly ? 'חודשים' : 'חיובים'}
            {data.varied && <> · נע בין {ILS0.format(data.minAmount)} ל-{ILS0.format(data.maxAmount)}</>}
          </>
        )}
      </div>
      <div className="mh-plot">
        <div className="mh-typical" style={{ bottom: `${typicalPct}%` }} aria-hidden>
          <span>הרגיל</span>
        </div>
        <div className="mh-bars">
          {charges.map((c, i) => {
            const h = Math.max(4, Math.round((c.amount / max) * 100));
            const cls = c.amount > typicalAmount * 1.15 ? ' up' : c.amount < typicalAmount * 0.85 ? ' down' : '';
            return (
              <button
                key={`${c.date}|${i}`}
                type="button"
                className={`mh-bar${cls}${hover === i ? ' hot' : ''}`}
                style={{ height: `${h}%` }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                aria-label={`${monthly ? monthHe(c.month) : dateHe(c.date)}: ${ILS0.format(c.amount)}`}
              />
            );
          })}
        </div>
      </div>
      <div className="mh-axis">
        <span>{monthHe(charges[0].month)}</span>
        {charges.length > 1 && <span>{monthHe(charges[charges.length - 1].month)}</span>}
      </div>
    </div>
  );
}

/** "היסטוריה ודפוס" — a popup that visualizes one merchant's past charges and lets the user classify
 *  it (מנוי / מחזורי / הרגל) right there. Opened from a transaction row; the classification applies
 *  to the whole merchant, exactly like the inline row buttons. */
export function MerchantHistoryModal({ merchant, title, mark, busy, onMark, onClose }: {
  merchant: string;
  title: string;
  /** The merchant's current verdict, kept fresh by the parent from the latest data. */
  mark: TxnMark | null;
  busy: boolean;
  onMark: (mark: TxnMark | null) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<MerchantChargeHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    api.merchantHistory(merchant)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(errorMessageHe(e)); });
    return () => { alive = false; };
  }, [merchant]);

  return createPortal(
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal mh-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`היסטוריה ודפוס · ${title}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="hero-top" style={{ marginBottom: 4 }}>
          <div className="label">היסטוריה ודפוס · {title}</div>
          <button className="link" onClick={onClose}>סגירה ✕</button>
        </div>

        {!data && !error && <p className="muted mh-state">טוען היסטוריה…</p>}
        {error && <p className="mh-state mh-error">{error}</p>}

        {data && (
          <>
            <div className="mh-sub">
              {data.category && (
                <span className="tag cat" style={{ '--cat': categoryColor(data.category) } as CSSProperties}>
                  {categoryNameHe(data.category)}
                </span>
              )}
              <span>
                {data.cadenceHe}
                {data.dayOfMonth != null && <> · ב-{data.dayOfMonth} בכל חודש</>}
                {' · '}{data.count} חיובים · מאז {monthHe(data.charges[0].month)}
              </span>
            </div>

            <ChargeChart data={data} hover={hover} setHover={setHover} />

            {data.varied && (
              <p className="mh-note">
                הסכום <strong>משתנה בין חיוב לחיוב</strong> — זה לא חיוב בסכום קבוע. אם תסמן אותו, הסכום
                שסימנת יהפוך לעוגן, ותקבל התראה כשחיוב עתידי יחרוג ממנו.
              </p>
            )}

            <div className="mh-classify">
              <div className="mh-classify-q">איך לסווג את {title}?</div>
              <span className="txn-classify" role="group" aria-label={`סיווג ${title}`}>
                <button
                  type="button"
                  className={mark === 'subscription' ? 'txn-mark on-sub' : 'txn-mark'}
                  disabled={busy}
                  aria-pressed={mark === 'subscription'}
                  onClick={() => onMark(mark === 'subscription' ? null : 'subscription')}
                >מנוי</button>
                <button
                  type="button"
                  className={mark === 'fixed' ? 'txn-mark on-fixed' : 'txn-mark'}
                  disabled={busy}
                  aria-pressed={mark === 'fixed'}
                  onClick={() => onMark(mark === 'fixed' ? null : 'fixed')}
                >קבוע</button>
                <button
                  type="button"
                  className={mark === 'habit' ? 'txn-mark on-habit' : 'txn-mark'}
                  disabled={busy}
                  aria-pressed={mark === 'habit'}
                  title="התנהגות שחוזרת בקצב אבל בשליטתך — נספרת כתובנה, לא כהתחייבות"
                  onClick={() => onMark(mark === 'habit' ? null : 'habit')}
                >הרגל</button>
              </span>
              <p className="mh-classify-note">
                הסימון חל על כל החיובים של הסוחר. מנוי וקבוע נכנסים לתחזית ולמפת ההתחייבויות;
                הרגל נספר כתובנה ב"מה יורד לי כל חודש?" — לעולם לא כהתחייבות.
              </p>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
