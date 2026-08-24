/**
 * Foreign-exchange support: every manual holding may be denominated in any supported
 * currency; the app converts into shekels (or the chosen primary currency) using rates
 * fetched from free public providers and cached locally.
 *
 * Privacy note (the app's doctrine is "everything local"): the ONLY outbound call this
 * feature makes is an anonymous GET for public exchange rates — no account data, no
 * amounts, nothing personal leaves the machine — and it happens only when the user
 * actually holds a foreign-currency asset (or refreshes manually). ILS-only users
 * never trigger a network request.
 *
 * Honesty doctrine applies to rates like to balances: a rate is a fact with a decay
 * rate, so the cache carries fetched_at and the UI names the age.
 */

export const ILS = 'ILS';

export interface CurrencyInfo {
  code: string;
  nameHe: string;
  symbol: string;
}

/** The intersection both providers serve (the ECB reference set + ILS). Order = the form's order. */
export const CURRENCIES: CurrencyInfo[] = [
  { code: 'ILS', nameHe: 'שקל חדש', symbol: '₪' },
  { code: 'USD', nameHe: 'דולר אמריקאי', symbol: '$' },
  { code: 'EUR', nameHe: 'אירו', symbol: '€' },
  { code: 'GBP', nameHe: 'לירה שטרלינג', symbol: '£' },
  { code: 'CHF', nameHe: 'פרנק שוויצרי', symbol: 'CHF' },
  { code: 'JPY', nameHe: 'ין יפני', symbol: '¥' },
  { code: 'CAD', nameHe: 'דולר קנדי', symbol: 'CA$' },
  { code: 'AUD', nameHe: 'דולר אוסטרלי', symbol: 'A$' },
  { code: 'NZD', nameHe: 'דולר ניו־זילנדי', symbol: 'NZ$' },
  { code: 'CNY', nameHe: 'יואן סיני', symbol: 'CN¥' },
  { code: 'HKD', nameHe: 'דולר הונג־קונגי', symbol: 'HK$' },
  { code: 'SGD', nameHe: 'דולר סינגפורי', symbol: 'S$' },
  { code: 'INR', nameHe: 'רופי הודי', symbol: '₹' },
  { code: 'KRW', nameHe: 'וון דרום־קוריאני', symbol: '₩' },
  { code: 'THB', nameHe: 'באט תאילנדי', symbol: '฿' },
  { code: 'SEK', nameHe: 'כתר שוודי', symbol: 'SEK' },
  { code: 'NOK', nameHe: 'כתר נורווגי', symbol: 'NOK' },
  { code: 'DKK', nameHe: 'כתר דני', symbol: 'DKK' },
  { code: 'ISK', nameHe: 'כתר איסלנדי', symbol: 'ISK' },
  { code: 'PLN', nameHe: 'זלוטי פולני', symbol: 'zł' },
  { code: 'CZK', nameHe: 'קורונה צ׳כית', symbol: 'Kč' },
  { code: 'HUF', nameHe: 'פורינט הונגרי', symbol: 'Ft' },
  { code: 'RON', nameHe: 'לאו רומני', symbol: 'RON' },
  { code: 'BGN', nameHe: 'לב בולגרי', symbol: 'BGN' },
  { code: 'TRY', nameHe: 'לירה טורקית', symbol: '₺' },
  { code: 'MXN', nameHe: 'פסו מקסיקני', symbol: 'MX$' },
  { code: 'BRL', nameHe: 'ריאל ברזילאי', symbol: 'R$' },
  { code: 'ZAR', nameHe: 'ראנד דרום־אפריקאי', symbol: 'R' },
  { code: 'MYR', nameHe: 'רינגיט מלזי', symbol: 'RM' },
  { code: 'IDR', nameHe: 'רופיה אינדונזית', symbol: 'Rp' },
  { code: 'PHP', nameHe: 'פסו פיליפיני', symbol: '₱' },
];

const SUPPORTED = new Set(CURRENCIES.map((c) => c.code));

export function isSupportedCurrency(code: unknown): code is string {
  return typeof code === 'string' && SUPPORTED.has(code);
}

/** ILS per one unit of each foreign currency, plus where the numbers came from. */
export interface RatesResult {
  ratesIlsPerUnit: Record<string, number>;
  source: 'frankfurter' | 'open-er-api';
}

/** How long a cached rate is considered fresh enough to skip a refetch. FX moves, but for
 *  a personal balance sheet a half-day-old official-style rate is honest — the UI names the age. */
export const RATE_FRESH_HOURS = 12;

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

async function fetchJson(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP error from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Both providers answer "how much of X is one ILS worth" — inverted here to ILS-per-unit,
 *  which is the number every conversion in the app multiplies by. */
function invertRates(rates: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = { [ILS]: 1 };
  for (const info of CURRENCIES) {
    if (info.code === ILS) continue;
    const perIls = rates[info.code];
    if (typeof perIls !== 'number' || !Number.isFinite(perIls) || perIls <= 0) continue;
    out[info.code] = Math.round((1 / perIls) * 10_000) / 10_000;
  }
  return out;
}

/**
 * Fetch current rates: frankfurter.app first (keyless, ECB reference rates), and when it
 * fails — open.er-api.com (keyless as well). Throws only when BOTH are unreachable or
 * return garbage; the caller falls back to the cached rates and their honest age.
 */
export async function fetchIlsRates(
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = 6_000,
): Promise<RatesResult> {
  try {
    const body = await fetchJson(fetchImpl, 'https://api.frankfurter.app/latest?from=ILS', timeoutMs) as {
      rates?: Record<string, unknown>;
    };
    const rates = invertRates(body?.rates ?? {});
    if (rates.USD && rates.EUR) return { ratesIlsPerUnit: rates, source: 'frankfurter' };
    throw new Error('frankfurter returned no usable rates');
  } catch {
    const body = await fetchJson(fetchImpl, 'https://open.er-api.com/v6/latest/ILS', timeoutMs) as {
      result?: string;
      rates?: Record<string, unknown>;
    };
    if (body?.result !== 'success') throw new Error('both rate providers failed');
    const rates = invertRates(body.rates ?? {});
    if (!rates.USD || !rates.EUR) throw new Error('both rate providers failed');
    return { ratesIlsPerUnit: rates, source: 'open-er-api' };
  }
}
