/**
 * The living frame — מסגרת 2.0.
 * A rounded frame that never fully closes: the gap is the breathing room in
 * your budget, and the amber sun sits inside it. pathLength=100 lets the gap
 * be expressed in percent, so future budget-linked states are a prop away.
 */
export function Logo({ size = 30, gap = 14 }: { size?: number; gap?: number }) {
  const clamped = Math.min(Math.max(gap, 0), 40);
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" aria-hidden="true">
      <rect
        x="9" y="9" width="78" height="78" rx="24"
        fill="none" stroke="var(--accent)" strokeWidth="11" strokeLinecap="round"
        pathLength={100} strokeDasharray={`${100 - clamped} ${clamped}`}
      />
      {clamped > 0 && <circle cx="15.5" cy="15.5" r="8" fill="var(--accent-2)" />}
    </svg>
  );
}
