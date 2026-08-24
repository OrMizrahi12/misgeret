import { useEffect, useRef, useState } from 'react';

const FORMATTERS = new Map<string, Intl.NumberFormat>();
function fmtFor(currency: string, decimals: 0 | 2): Intl.NumberFormat {
  const key = `${currency}|${decimals}`;
  let f = FORMATTERS.get(key);
  if (!f) {
    f = new Intl.NumberFormat('he-IL', {
      style: 'currency',
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    FORMATTERS.set(key, f);
  }
  return f;
}

/** Hero amounts count up softly on mount; respects prefers-reduced-motion. */
function useCountUp(target: number, enabled: boolean): number {
  const [value, setValue] = useState(enabled ? 0 : target);
  const first = useRef(true);
  useEffect(() => {
    // no animation when the tab is hidden — rAF is suspended there, which would freeze the value at 0
    if (!enabled || !first.current || document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setValue(target);
      return;
    }
    first.current = false;
    const start = performance.now();
    const dur = 700;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      const eased = 1 - (1 - p) ** 3;
      setValue(target * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, enabled]);
  return value;
}

/** The only way money is rendered: he-IL bidi-safe formatting inside <bdi>,
 *  tabular lining figures (via .amount class), true minus U+2212, agorot always shown.
 *  `currency` defaults to shekels; the balance sheet passes its primary currency through.
 *  `decimals={0}` is for ROUND intentions — a frame, a derivation, a goal — where agorot are
 *  noise; every other caller keeps the accounting default of two. */
export function Amount({ value, hero = false, tone, currency = 'ILS', decimals = 2 }: {
  value: number;
  hero?: boolean;
  tone?: 'positive' | 'negative';
  currency?: string;
  decimals?: 0 | 2;
}) {
  const shown = useCountUp(value, hero);
  const parts = fmtFor(currency, decimals).formatToParts(shown).map((p) => (p.type === 'minusSign' ? { ...p, value: '−' } : p));
  const cls = ['amount', hero ? 'amount-hero' : '', tone ? `amount-${tone}` : ''].filter(Boolean).join(' ');
  return (
    <bdi className={cls}>
      {parts.map((p, i) =>
        hero && (p.type === 'fraction' || p.type === 'decimal') ? (
          <span key={i} className="agorot">{p.value}</span>
        ) : (
          <span key={i}>{p.value}</span>
        ),
      )}
    </bdi>
  );
}
