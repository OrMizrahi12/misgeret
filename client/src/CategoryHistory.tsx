import { History } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessageHe } from './api';
import { categoryColor } from './charts';
import { ChargeChart, MerchantHistoryModal, monthHe } from './MerchantHistory';
import type { CategoryHistory, TxnMark } from './types';
import { categoryNameHe } from './types';

const ILS0 = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });

/**
 * "היסטוריית התשלומים" — one category's whole life, month by month.
 *
 * The same chart the merchant popup draws (`ChargeChart`), fed a different unit: a bar is a MONTH,
 * not a charge. A category has hundreds of charges a year — plotted individually they would be
 * hair-thin noise; plotted monthly they answer the question the row actually asks, "how much does
 * this cost me in a normal month", and the dashed line names it.
 *
 * Beneath it, the merchants behind the category — each a door into its own history popup, so the
 * user can descend קטגוריה ← עסק ← חיובים without leaving the year.
 */
export function CategoryHistoryModal({ category, onClose }: {
  category: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<CategoryHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drill, setDrill] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    // Escape closes the merchant popup first when it is open — it owns its own key handler, and
    // closing both at once would drop the user two levels for one press.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !drill) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, drill]);

  async function load() {
    try {
      setData(await api.categoryHistory(category));
    } catch (e) {
      setError(errorMessageHe(e));
    }
  }

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    api.categoryHistory(category)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(errorMessageHe(e)); });
    return () => { alive = false; };
  }, [category]);

  async function mark(merchant: string, m: TxnMark | null, anchor: number) {
    setBusy(merchant);
    try {
      const withAnchor = m === 'subscription' || m === 'fixed';
      await api.applyMerchantMark(merchant, m, withAnchor ? anchor : undefined);
      await load();
    } catch (e) {
      setError(errorMessageHe(e));
    } finally {
      setBusy(null);
    }
  }

  const nameHe = categoryNameHe(category);
  const drilled = data?.topMerchants.find((m) => m.merchant === drill) ?? null;

  // The merchant popup is a SIBLING of this backdrop, not a child: React events bubble along the
  // component tree even through a portal, so nesting it would make every click inside it reach this
  // backdrop's onClick and close the category behind it.
  return createPortal(
    <>
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal mh-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`היסטוריית התשלומים · ${nameHe}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="hero-top" style={{ marginBottom: 4 }}>
          <div className="label">
            <span className="ch-dot" style={{ background: categoryColor(category) }} aria-hidden />
            היסטוריית התשלומים · {nameHe}
          </div>
          <button className="link" onClick={onClose}>סגירה ✕</button>
        </div>

        {!data && !error && <p className="muted mh-state">טוען היסטוריה…</p>}
        {error && <p className="mh-state mh-error">{error}</p>}

        {data && (
          <>
            <div className="mh-sub">
              <span>
                {ILS0.format(data.totalAmount)} בסך הכול · {data.chargeCount} חיובים
                {' · '}מאז {monthHe(data.firstMonth)}
              </span>
            </div>

            <ChargeChart data={data} hover={hover} setHover={setHover} monthly />

            {data.topMerchants.length > 0 && (
              <div className="ch-merchants">
                <div className="ch-merchants-q">מי מקבל את הכסף הזה</div>
                <ul className="txns">
                  {data.topMerchants.map((m) => (
                    <li className="txn" key={m.merchant}>
                      {m.drillable ? (
                        <button
                          type="button"
                          className="txn-mark txn-history"
                          aria-label={`היסטוריה ודפוס · ${m.name}`}
                          title="היסטוריה ודפוס — גרף של חיובי העבר, ומשם אפשר גם לסווג"
                          onClick={() => setDrill(m.merchant)}
                        ><History size={15} strokeWidth={2} aria-hidden /></button>
                      ) : (
                        <span className="ch-nodrill" aria-hidden />
                      )}
                      <span className="txn-desc">{m.name}</span>
                      <span className="tag">{m.count} חיובים</span>
                      <span className="amount">{ILS0.format(m.total)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>

      {drilled && (
        <MerchantHistoryModal
          merchant={drilled.merchant}
          title={drilled.name}
          mark={drilled.mark}
          busy={busy === drilled.merchant}
          onMark={(m) => void mark(drilled.merchant, m, Math.round(drilled.total / Math.max(1, drilled.count)))}
          onClose={() => setDrill(null)}
        />
      )}
    </>,
    document.body,
  );
}
