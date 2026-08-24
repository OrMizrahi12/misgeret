import { SCRAPERS } from 'israeli-bank-scrapers';
import { merchantFromMemo, normalizePattern } from './categories.js';
import { savingsShape } from './savings.js';
import type { TxnRow } from './txns.js';

export type CompanyKind = 'bank' | 'card' | 'other';

const COMPANY_META: Record<string, { nameHe: string; kind: CompanyKind }> = {
  hapoalim: { nameHe: 'בנק הפועלים', kind: 'bank' },
  leumi: { nameHe: 'בנק לאומי', kind: 'bank' },
  mizrahi: { nameHe: 'מזרחי-טפחות', kind: 'bank' },
  discount: { nameHe: 'בנק דיסקונט', kind: 'bank' },
  mercantile: { nameHe: 'בנק מרכנתיל', kind: 'bank' },
  otsarHahayal: { nameHe: 'בנק אוצר החייל', kind: 'bank' },
  union: { nameHe: 'בנק איגוד', kind: 'bank' },
  beinleumi: { nameHe: 'הבנק הבינלאומי', kind: 'bank' },
  massad: { nameHe: 'בנק מסד', kind: 'bank' },
  yahav: { nameHe: 'בנק יהב', kind: 'bank' },
  pagi: { nameHe: 'בנק פאג"י', kind: 'bank' },
  visaCal: { nameHe: 'כאל', kind: 'card' },
  max: { nameHe: 'מקס', kind: 'card' },
  isracard: { nameHe: 'ישראכרט', kind: 'card' },
  amex: { nameHe: 'אמריקן אקספרס', kind: 'card' },
  beyahadBishvilha: { nameHe: 'ביחד בשבילך', kind: 'other' },
  behatsdaa: { nameHe: 'בהצדעה', kind: 'other' },
  // user-entered cash transactions — count in months/categories, never in bank-balance math
  manual: { nameHe: 'ידני', kind: 'other' },
};

const FIELD_LABELS_HE: Record<string, string> = {
  username: 'שם משתמש',
  password: 'סיסמה',
  id: 'תעודת זהות',
  userCode: 'קוד משתמש',
  num: 'קוד מזדהה',
  card6Digits: '6 ספרות אחרונות של הכרטיס',
  nationalID: 'תעודת זהות',
  email: 'אימייל',
};

// Login fields that require interactive 2FA — companies using them are not offered
const INTERACTIVE_FIELDS = new Set(['otpCodeRetriever', 'otpLongTermToken', 'phoneNumber']);

const SECRET_FIELDS = new Set(['password', 'card6Digits']);

const KIND_ORDER: Record<CompanyKind, number> = { bank: 0, card: 1, other: 2 };

/** Institutions the scraping library still defines but that no longer exist. Bank Igud was absorbed
 *  into Mizrahi-Tefahot and the merger completed at the end of 2022; measured 30.7.2026,
 *  `hb.unionbank.co.il` — the only host its scraper knows — does not resolve at all, while
 *  `bankleumi.co.il` resolves from the same machine. Because the picker is built from SCRAPERS at
 *  RUN TIME, a bank that died four years ago still shows up in it with a full Hebrew name and a
 *  guaranteed failure behind it. The COMPANY_META entry deliberately stays: a profile that holds
 *  Igud rows from before must still read 'בנק איגוד' and not a raw id. Only the OFFER is withdrawn. */
const RETIRED_COMPANIES = new Set(['union']);

/** The hard ceiling each scraper clamps its own start date to (`moment.max(default, requested)`),
 *  in months, measured from the library source — NOT from its README, which claims six months for
 *  Yahav where the code says three. Asking for more than the ceiling is harmless (it is clamped);
 *  asking without KNOWING it is how a surface promises two years of history and quietly shows one. */
export const HISTORY_CEILING_MONTHS: Record<string, number> = {
  leumi: 36,
  max: 48,
  visaCal: 18,
  yahav: 3,
  hapoalim: 12,
  mizrahi: 12,
  discount: 12,
  mercantile: 12,
  beinleumi: 12,
  massad: 12,
  otsarHahayal: 12,
  pagi: 12,
  isracard: 12,
  amex: 12,
  beyahadBishvilha: 12,
  behatsdaa: 12,
};

/** An institution we have not measured gets the commonest ceiling, never an optimistic one. */
const DEFAULT_HISTORY_CEILING_MONTHS = 12;

export function historyCeilingMonths(companyId: string): number {
  return HISTORY_CEILING_MONTHS[companyId] ?? DEFAULT_HISTORY_CEILING_MONTHS;
}

/** Our own sync depth. Deliberately deeper than any display window: data an institution ages out
 *  can never be fetched later, so depth is never coupled to the lens. */
export const SYNC_WINDOW_MONTHS = 24;

/** How deep this institution is ACTUALLY synced — ours or theirs, whichever is shallower.
 *  This is the number a surface may quote to a person. The 24 on its own is a promise we cannot
 *  keep for eleven of the sixteen institutions we offer. */
export function syncWindowMonths(companyId: string): number {
  return Math.min(SYNC_WINDOW_MONTHS, historyCeilingMonths(companyId));
}

export interface CompanyOutage {
  /** The day the institution's own site changed under the scraper (YYYY-MM-DD). */
  since: string;
  noteHe: string;
  issueUrl: string;
}

/** Breakages that live in the scraping library, not here. Listed so the app can say the true thing
 *  instead of letting a person wait out a ten-minute timeout and then read "try again in a few
 *  minutes" — advice that is worse than silence when the bank has replaced its login page and the
 *  library has not caught up. Verified 30.7.2026 against israeli-bank-scrapers 6.8.0: the login URL
 *  the Hapoalim scraper drives now redirects to a new portal that contains none of the three things
 *  it reaches for (#userCode, #password, .login-btn), so it waits for a redirect that never comes.
 *  DELETE AN ENTRY the day a release fixes it — a stale warning here is its own kind of lie. */
export const KNOWN_OUTAGES: Record<string, CompanyOutage> = {
  hapoalim: {
    since: '2026-06-02',
    noteHe:
      'בנק הפועלים החליף את מסך ההתחברות שלו, והספרייה שדרכה מסגרת מתחברת עדיין לא הותאמה. '
      + 'הסנכרון ייתקע עד שייגמר הזמן — זה לא הפרטים שלך, והחלפת סיסמה לא תעזור. '
      + 'ברגע שהתיקון ישוחרר, עדכון של מסגרת יחזיר את החיבור לפעולה.',
    issueUrl: 'https://github.com/eshaham/israeli-bank-scrapers/issues/1120',
  },
};

export function companyOutage(companyId: string): CompanyOutage | null {
  return KNOWN_OUTAGES[companyId] ?? null;
}

/** Failure shapes a known outage explains. A wrong password, an expired one or a blocked account are
 *  the person's own business and are reported exactly as they came — only a hang, or a failure the
 *  library could not attribute, get re-labelled. Getting this backwards would hide a real
 *  "your password is wrong" behind "the bank is broken". */
const OUTAGE_MASKABLE = new Set(['TIMEOUT', 'GENERIC', 'GENERAL_ERROR']);

/** The single place a scrape failure becomes a stored error code. Sanitises first — the string
 *  arrives from a third-party library and ends up in the database and on screen — and then, only
 *  for the shapes above, tells the truth about a known outage. */
export function syncErrorType(companyId: string, errorType: string): string {
  const safe = /^[A-Z0-9_]+$/.test(errorType) ? errorType : 'GENERIC';
  return companyOutage(companyId) && OUTAGE_MASKABLE.has(safe) ? 'PROVIDER_OUTAGE' : safe;
}

export interface CompanyInfo {
  id: string;
  nameHe: string;
  kind: CompanyKind;
  loginFields: { name: string; labelHe: string; secret: boolean }[];
  /** Months of history this institution actually delivers under our sync window. */
  historyMonths: number;
  outage: CompanyOutage | null;
}

export function listCompanies(): CompanyInfo[] {
  return Object.entries(SCRAPERS as Record<string, { name: string; loginFields: string[] }>)
    .filter(([id, meta]) => !RETIRED_COMPANIES.has(id) && !meta.loginFields.some((f) => INTERACTIVE_FIELDS.has(f)))
    .map(([id, meta]) => ({
      id,
      nameHe: COMPANY_META[id]?.nameHe ?? meta.name,
      kind: COMPANY_META[id]?.kind ?? ('other' as CompanyKind),
      loginFields: meta.loginFields.map((name) => ({
        name,
        labelHe: FIELD_LABELS_HE[name] ?? name,
        secret: SECRET_FIELDS.has(name),
      })),
      historyMonths: syncWindowMonths(id),
      outage: companyOutage(id),
    }))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.nameHe.localeCompare(b.nameHe, 'he'));
}

export function companyKind(companyId: string): CompanyKind {
  return COMPANY_META[companyId]?.kind ?? 'other';
}

export function companyNameHe(companyId: string): string {
  return COMPANY_META[companyId]?.nameHe ?? companyId;
}

/** Bank-statement description patterns that identify a card company's monthly settlement debit.
 *  Patterns of ≤3 letters match whole words only ('כאל' must not match 'מיכאל');
 *  longer patterns match as substrings. Maintained by hand; the UI shows excluded rows. */
export const CARD_SETTLEMENT_PATTERNS: Record<string, string[]> = {
  isracard: ['ישראכרט'],
  visaCal: ['כאל', 'כ.א.ל', 'ויזה כאל', 'CAL'],
  // Max cards issued through Leumi debit as "לאומי ויזה" — the same Max account can settle
  // under both names in the same month (one debit per physical card)
  max: ['מקס איט', 'לאומי קארד', 'לאומי ויזה', 'מקס'],
  amex: ['אמריקן אקספרס', 'אמקס'],
};

function tokenize(description: string): string[] {
  return description.toUpperCase().split(/[^A-Zא-ת0-9]+/).filter(Boolean);
}

function matchesPattern(description: string, tokens: string[], pattern: string): boolean {
  if (pattern.length <= 3 && !pattern.includes('.')) return tokens.includes(pattern.toUpperCase());
  return description.toUpperCase().includes(pattern.toUpperCase());
}

/** Which card company's settlement this bank description looks like, or null. */
export function settlementCompany(description: string): string | null {
  const tokens = tokenize(description);
  for (const [company, patterns] of Object.entries(CARD_SETTLEMENT_PATTERNS)) {
    if (patterns.some((p) => matchesPattern(description, tokens, p))) return company;
  }
  return null;
}

export function isCardSettlement(description: string, connectedCardCompanies: ReadonlySet<string>): boolean {
  const company = settlementCompany(description);
  return company !== null && connectedCardCompanies.has(company);
}

/** Bank descriptions that talk like a card SETTLEMENT we cannot attribute to a company — a silent
 *  double count the moment that card gets connected. A card BRAND stands alone (a bank row saying
 *  דיינרס is settling one; that is the shape CARD_SETTLEMENT_PATTERNS itself is made of), but the
 *  generic noun כרטיס needs a settlement verb beside it: bare 'כרטיס' is the everyday debit and
 *  fee vocabulary — 'כרטיס דביט' describes every Leumi purchase and 'עמלת דמי כרטיס' a ₪40 fee —
 *  so matching it alone turns a Leumi user's entire spending into a false alarm that never
 *  retires. 'אשראי' is left out entirely: 'חיוב לכרטיס אשראי' is caught by כרטיס anyway, while
 *  'הקצאת אשראי' and 'חיוב ריבית אשראי' are fees that are nobody's double count. */
export const SETTLEMENT_SHAPED =
  /ויזה|קארד|מאסטרקארד|מסטרקארד|דיינרס|VISA|MASTERCARD|DINERS|(?:חיוב|פרעון|פירעון|תשלום)[^\n]{0,12}כרטיס/i;

/** A settlement pays a CARD, never a merchant — so a row whose memo names one is a purchase,
 *  whatever its description says. This is the shape /reconciliation and /flow-candidates hunt. */
export function isSettlementShaped(description: string, memo?: string | null): boolean {
  return SETTLEMENT_SHAPED.test(description) && merchantFromMemo(memo ?? null) === null;
}

export type ExcludeReason = 'settlement' | 'transfer' | 'future' | 'partial' | 'savings' | 'manual';

/** What the user taught about a pattern: 'internal' = pot-to-pot, never a flow; 'flow' = real
 *  money entering or leaving their world, hands off. Keys are normalizePattern()'d. */
export type FlowClass = 'internal' | 'flow';
export type FlowOverrides = ReadonlyMap<string, FlowClass>;

export type FlaggedTxn = TxnRow & { excluded: boolean; excludeReason?: ExcludeReason };

/** Description patterns that mark a money movement between own accounts / P2P rails.
 *  Short words ('ביט', 'BIT') match whole words only — 'ביטוח' and 'ביטול' are NOT transfers. */
export const TRANSFER_PATTERNS = ['העברה עצמית', 'העברה ב BIT', 'העברה בביט', 'ביט', 'BIT', 'PAYBOX', 'פייבוקס'];

export function isTransferLike(description: string): boolean {
  const tokens = tokenize(description);
  return TRANSFER_PATTERNS.some((p) => matchesPattern(description, tokens, p));
}

/** Read-time exclusion flags — never persisted. Reality-based and lens-free.
 *  Card spending exists twice in the data: as the card's own transaction rows and as the bank-side
 *  settlement rows (debits AND refund credits). Per (company, charge month) exactly ONE
 *  representation may count:
 *  - the card's own rows, when their net covers at least the settled net — the normal case;
 *  - the bank rows, when the card rows fall short — a history that starts mid-cycle gives a
 *    partial first month, and the bank's debit is the only complete record ('partial' reason);
 *  - the bank rows, when there are no card rows at all for that month.
 *  Months here are the persisted charge-calendar months; the display lens never changes them.
 *  Also excluded: what the user taught as internal; savings principal moving between the person's
 *  own pots; and internal-transfer pairs between bank accounts — exact opposite amounts,
 *  different accounts, ≤3 days apart, at least one side transfer-like, completed rows only.
 *  Future-cycle flagging lives in flow.ts applyLens — it depends on the viewing lens. */
export function flagExcluded(
  rows: TxnRow[],
  connectedCardCompanies: ReadonlySet<string>,
  flowOverrides: FlowOverrides = new Map(),
): FlaggedTxn[] {
  // net card activity per `${company}|${month}` — refunds included, pending rows are not data yet
  const cardNet = new Map<string, number>();
  for (const r of rows) {
    if (companyKind(r.company) !== 'card' || r.status !== 'completed') continue;
    const k = `${r.company}|${r.month}`;
    cardNet.set(k, (cardNet.get(k) ?? 0) + r.amount);
  }

  // settlement activity per `${company}|${month}` over bank rows of connected card companies —
  // debits and credits tracked separately: a credit may be a refund already netted inside the
  // details, or extra money (cashback, interest refund) the details know nothing about
  const settleAs = new Map<TxnRow, string>();
  const settleNet = new Map<string, number>();
  const settleDebits = new Map<string, number>();
  for (const r of rows) {
    if (companyKind(r.company) !== 'bank' || r.status !== 'completed') continue;
    const company = settlementCompany(r.description);
    if (!company || !connectedCardCompanies.has(company)) continue;
    settleAs.set(r, company);
    const k = `${company}|${r.month}`;
    settleNet.set(k, (settleNet.get(k) ?? 0) + r.amount);
    if (r.amount < 0) settleDebits.set(k, (settleDebits.get(k) ?? 0) + r.amount);
  }

  // Which representation counts for a (company, month)? ±1 ₪ tolerance absorbs rounding.
  // 'debits': details mirror the debits exactly → exclude only the debits, credits are income.
  // 'all':    details cover the settled net → exclude every matched bank row.
  // 'bank':   details fall short (partial history) or don't exist → the bank rows count.
  const modeFor = (k: string): 'debits' | 'all' | 'bank' => {
    const details = cardNet.get(k);
    if (details === undefined) return 'bank';
    const net = settleNet.get(k) ?? 0;
    const debits = settleDebits.get(k) ?? 0;
    if (debits !== net && Math.abs(details - debits) <= 1) return 'debits';
    if (Math.abs(details) >= Math.abs(net) - 1) return 'all';
    return 'bank';
  };

  // The user is authority over MEANING — not over which of two records of one payment counts.
  // A settled row is arbitrated by modeFor and by nothing else: a second opinion on top of it
  // produces either a double count or an artificially green month.
  const overrideOf = rows.map((r) =>
    settleAs.has(r) ? undefined : flowOverrides.get(normalizePattern(r.description)),
  );

  const flagged: FlaggedTxn[] = rows.map((r, i) => {
    const company = settleAs.get(r);
    if (company) {
      const mode = modeFor(`${company}|${r.month}`);
      if (mode === 'all' || (mode === 'debits' && r.amount < 0)) {
        return { ...r, excluded: true, excludeReason: 'settlement' };
      }
      return { ...r, excluded: false };
    }
    if (companyKind(r.company) === 'card' && r.status === 'completed') {
      const k = `${r.company}|${r.month}`;
      if (cardNet.has(k) && settleNet.has(k) && modeFor(k) === 'bank') {
        return { ...r, excluded: true, excludeReason: 'partial' };
      }
    }
    const override = overrideOf[i];
    if (override === 'internal') return { ...r, excluded: true, excludeReason: 'manual' };
    if (override === 'flow') return { ...r, excluded: false };
    // The principal of a savings instrument, either sign, pairing-free: money into a deposit in
    // March and back out in September is not an expense in March nor income in September. The
    // bank-only guard is what makes this safe to run on a credit.
    // description + memo, exactly as resolveCategory reads it: one vocabulary on two different
    // inputs cannot be right in both places, and this tier silently overrules the other — reading
    // description alone deletes a 'ריבית זכות' memo's real interest and misses a bank that keeps
    // the instrument name in the memo.
    if (
      companyKind(r.company) === 'bank' && r.status === 'completed' &&
      savingsShape(`${r.description} ${r.memo ?? ''}`) === 'principal'
    ) {
      return { ...r, excluded: true, excludeReason: 'savings' };
    }
    return { ...r, excluded: false };
  });

  // a row the user pinned is never re-judged by the pairing loop below
  const pinned = new Set(flagged.filter((_, i) => overrideOf[i] !== undefined));

  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
  const candidates = flagged
    .filter((r) => !r.excluded && !pinned.has(r) && r.status === 'completed' && r.amount !== 0 && companyKind(r.company) === 'bank')
    .sort((a, b) => a.date.localeCompare(b.date));
  const paired = new Set<FlaggedTxn>();

  for (const neg of candidates) {
    if (neg.amount >= 0 || paired.has(neg)) continue;
    for (const pos of candidates) {
      if (pos.amount <= 0 || paired.has(pos)) continue;
      if (pos.amount !== -neg.amount || pos.account === neg.account) continue;
      if (Math.abs(new Date(pos.date).getTime() - new Date(neg.date).getTime()) > THREE_DAYS_MS) continue;
      if (!isTransferLike(neg.description) && !isTransferLike(pos.description)) continue;
      paired.add(neg);
      paired.add(pos);
      neg.excluded = true;
      neg.excludeReason = 'transfer';
      pos.excluded = true;
      pos.excludeReason = 'transfer';
      break;
    }
  }
  return flagged;
}
