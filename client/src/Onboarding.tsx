import { ArrowLeft, Check, Compass, CreditCard, Landmark, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from './api';
import type { Company, Connection } from './types';

/** What the new-user journey has already crossed. Everything is DERIVED from real data —
 *  no onboarding flags to migrate or forget: connect → it shows connected, sync → it hides. */
export interface OnboardingSnapshot {
  bankConnected: boolean;
  cardConnected: boolean;
  synced: boolean;
}

export function readTourDone(): boolean {
  try {
    return window.localStorage.getItem('misgeret-tour-done') === '1';
  } catch {
    return true; // a locked-down store must not nag forever
  }
}

export function markTourDone(): void {
  try {
    window.localStorage.setItem('misgeret-tour-done', '1');
  } catch {
    // best effort
  }
}

function connectedKinds(connections: Connection[], companies: Company[]): { bank: boolean; card: boolean } {
  const kindOf = new Map(companies.map((c) => [c.id, c.kind]));
  let bank = false;
  let card = false;
  for (const conn of connections) {
    const kind = kindOf.get(conn.company);
    if (kind === 'bank') bank = true;
    if (kind === 'card') card = true;
  }
  return { bank, card };
}

/** One checklist row: done = quiet green check, current = the loud step with the CTA. */
function Step({ done, current, index, title, sub, action }: {
  done: boolean;
  current: boolean;
  index: number;
  title: string;
  sub: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className={done ? 'onb-step done' : current ? 'onb-step current' : 'onb-step'}>
      <span className="onb-step-mark" aria-hidden="true">
        {done ? <Check size={15} strokeWidth={2.6} /> : index}
      </span>
      <span className="onb-step-text">
        <span className="onb-step-title">{title}</span>
        <span className="onb-step-sub">{sub}</span>
      </span>
      {current && action && (
        <button className="primary onb-step-cta" onClick={action.onClick}>
          {action.label}
          <ArrowLeft size={14} strokeWidth={2.2} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/**
 * The Home welcome guide — the first thing a brand-new user sees. Visible only while the
 * install is genuinely unbootstrapped (no connections, or never synced); the moment real
 * data exists it disappears for good, because the derived steps are all complete.
 */
export function OnboardingGuide({ onOpenConnections, onSyncNow, onStartTour, syncing }: {
  onOpenConnections: () => void;
  onSyncNow: () => void;
  onStartTour: () => void;
  syncing: boolean;
}) {
  const [snap, setSnap] = useState<OnboardingSnapshot | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all([api.status(), api.connections(), api.companies()])
      .then(([status, connections, companies]) => {
        if (!alive) return;
        const kinds = connectedKinds(connections, companies);
        setSnap({ bankConnected: kinds.bank, cardConnected: kinds.card, synced: status.lastSyncAt !== null });
      })
      .catch(() => {
        // no snapshot — show nothing rather than a wrong guide
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!snap) return null;
  const connected = snap.bankConnected || snap.cardConnected;
  if (connected && snap.synced) return null; // bootstrapped — the guide's work is done

  // the current step = the first not-done one, in journey order
  const steps = [
    {
      done: snap.bankConnected,
      title: 'חבר את חשבון הבנק שלך',
      sub: 'הפרטים נשמרים מוצפנים, רק על המחשב הזה — כלום לא עולה לאינטרנט 🔒',
      action: { label: 'לחיבורים', onClick: onOpenConnections },
    },
    {
      done: snap.cardConnected,
      title: 'חבר גם את כרטיס האשראי',
      sub: 'בבנק רואים רק סכום אחד גדול. עם הכרטיס — רואים כל קנייה 🔍',
      action: { label: 'לחיבורים', onClick: onOpenConnections },
    },
    {
      done: snap.synced,
      title: 'הפעל סנכרון ראשון',
      sub: 'מסגרת מושכת את ההיסטוריה ובונה את התמונה. לוקח כמה דקות ☕',
      action: { label: syncing ? 'מסנכרן…' : 'סנכרן עכשיו', onClick: onSyncNow },
    },
    {
      done: readTourDone(),
      title: 'צא לסיור קצר',
      sub: 'דקה אחת — ותדע איפה למצוא כל תשובה 🧭',
      action: { label: 'התחל סיור', onClick: onStartTour },
    },
  ];
  const currentIdx = steps.findIndex((s) => !s.done);

  return (
    <section className="onb-guide" aria-label="צעדים ראשונים במסגרת">
      <div className="onb-head">
        <span className="onb-head-icon" aria-hidden="true"><Compass size={19} strokeWidth={2} /></span>
        <span className="onb-head-text">
          <span className="onb-title">ברוכים הבאים למסגרת</span>
          <span className="onb-sub">ארבעה צעדים קטנים — ותראה את כל הכסף שלך במקום אחד.</span>
        </span>
      </div>
      <div className="onb-steps">
        {steps.map((s, i) => (
          <Step key={i} done={s.done} current={i === currentIdx} index={i + 1} title={s.title} sub={s.sub} action={s.action} />
        ))}
      </div>
    </section>
  );
}

/**
 * The Connections screen coach: tells a new user WHAT to connect and why — bank first,
 * then the credit card (the bank shows card charges as one opaque monthly sum; the card
 * connection unlocks the per-transaction detail). Hides once both kinds exist.
 */
export function ConnectionsCoach({ connections, companies }: {
  connections: Connection[];
  companies: Company[];
}) {
  const kinds = connectedKinds(connections, companies);
  if (kinds.bank && kinds.card) return null;

  return (
    <div className="onb-coach" role="note">
      <div className="onb-coach-chips">
        <span className={kinds.bank ? 'onb-chip done' : 'onb-chip'}>
          <Landmark size={14} strokeWidth={2} aria-hidden="true" />
          חשבון בנק {kinds.bank ? <Check size={13} strokeWidth={2.6} aria-hidden="true" /> : null}
        </span>
        <span className={kinds.card ? 'onb-chip done' : 'onb-chip'}>
          <CreditCard size={14} strokeWidth={2} aria-hidden="true" />
          כרטיס אשראי {kinds.card ? <Check size={13} strokeWidth={2.6} aria-hidden="true" /> : null}
        </span>
      </div>
      {!kinds.bank ? (
        <p className="onb-coach-text">
          מתחילים מ<strong>חשבון הבנק</strong> — הוא הבסיס. בחר את הבנק שלך מהרשימה והזן את פרטי
          ההתחברות לאתר הבנק. הפרטים נשמרים <strong>מוצפנים, רק על המחשב הזה</strong> 🔒
        </p>
      ) : (
        <p className="onb-coach-text">
          מעולה! עכשיו <strong>כרטיס האשראי</strong> (אם יש לך): בבנק רואים רק סכום אחד גדול —
          עם הכרטיס רואים <strong>כל קנייה</strong> 🔍 וזה מה שנותן לקטגוריות ולדפוסים את הדיוק שלהם.
        </p>
      )}
      <p className="onb-coach-more">
        אחרי החיבור, לחץ <strong>סנכרון</strong> — ומסגרת תבנה את התמונה מההיסטוריה.
        {' '}<RefreshCw size={13} strokeWidth={2.2} className="ic ic-muted" aria-hidden="true" />
      </p>
    </div>
  );
}
