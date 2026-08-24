import type { CSSProperties } from 'react';

/**
 * The real marks of the real institutions.
 *
 * Every logo is bundled INTO the app at build time — a local-first app never fetches brand
 * assets at runtime, and the connections screen must look whole with the network cable cut.
 * Sources: the institutions' current logos as published on their Wikipedia articles (Leumi
 * 2026, Hapoalim 2018, Isracard 2023, Max 2019, Cal 2019, Discount, Mizrahi-Tefahot, Amex
 * 2018, Igud), and for the rest — the favicon each institution serves on its own website.
 * The four FIBI-group banks (הבינלאומי, מסד, פאג"י, אוצר החייל) genuinely serve one shared
 * group icon from each of their domains; the repetition is theirs, not a bug here.
 */
const LOGOS = import.meta.glob('./assets/companies/*.{png,svg,ico}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

function logoUrl(companyId: string): string | null {
  for (const ext of ['png', 'svg', 'ico']) {
    const url = LOGOS[`./assets/companies/${companyId}.${ext}`];
    if (url) return url;
  }
  return null;
}

/** A company's mark on a clean white chip — per the brand law, colour lives in the logo
 *  itself, never painted around it. Falls back to an initial when no asset exists (e.g.
 *  'ידני'), so an unknown id degrades to a letter, not to a broken-image glyph. */
export function CompanyLogo({ companyId, nameHe, size = 38 }: {
  companyId: string;
  nameHe: string;
  size?: number;
}) {
  const url = logoUrl(companyId);
  const style: CSSProperties = { width: size, height: size };
  if (!url) {
    return (
      <span className="company-logo is-fallback" style={style} aria-hidden>
        {nameHe.replace(/^בנק /, '').trim().charAt(0) || '?'}
      </span>
    );
  }
  // decorative next to the company's visible name — never the only carrier of the identity.
  // Eager on purpose: seventeen tiny local files gain nothing from lazy-loading, and lazy
  // images simply never appear in any non-compositing context.
  return <img className="company-logo" style={style} src={url} alt="" aria-hidden />;
}
