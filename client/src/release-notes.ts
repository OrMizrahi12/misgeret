/** User-facing release notes, newest first. */

export interface WhatsNewEntry {
  version: string;
  title: string;
  bullets: string[];
}

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    version: '1.0.0',
    title: 'ברוכים הבאים למסגרת',
    bullets: [
      'התמונה הפיננסית שלך מרוכזת במקום אחד — חודש, שנה, דפוסים, תחזית, בריאות והון.',
      'אפשר לחבר בנקים וכרטיסי אשראי ישראליים ולסנכרן ישירות מהמחשב.',
      'הנתונים נשמרים מקומית, אין צורך בחשבון, והתוכנה חינמית ובקוד פתוח.',
    ],
  },
];

/** 'x.y.z' compare: negative when a < b. Non-numeric parts compare as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Everything the user has not seen yet: seen < version ≤ current, newest first, capped. */
export function entriesSince(seen: string, current: string, cap = 5): WhatsNewEntry[] {
  return WHATS_NEW
    .filter((e) => compareVersions(e.version, seen) > 0 && compareVersions(e.version, current) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version))
    .slice(0, cap);
}
