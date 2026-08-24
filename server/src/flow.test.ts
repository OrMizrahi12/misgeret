import { describe, expect, test } from 'vitest';
import { flagExcluded } from './companies.js';
import { applyLens, buildFlowCalendar, effectiveDate, flowMonthOf, monthsBack } from './flow.js';
import { row } from './test-helpers.js';

describe('flowMonthOf', () => {
  test('anchor 1 is a plain calendar month in Israel local time', () => {
    expect(flowMonthOf('2026-07-13', 1)).toBe('2026-07');
    expect(flowMonthOf('2026-06-30T21:30:00.000Z', 1)).toBe('2026-07'); // UTC evening = July 1st in Israel
  });

  test('anchor 10: days before the 10th belong to the previous flow month', () => {
    expect(flowMonthOf('2026-07-09', 10)).toBe('2026-06');
    expect(flowMonthOf('2026-07-10', 10)).toBe('2026-07');
    expect(flowMonthOf('2026-07-31', 10)).toBe('2026-07');
  });

  test('wraps the year: early January belongs to December', () => {
    expect(flowMonthOf('2026-01-05', 10)).toBe('2025-12');
  });
});

describe('monthsBack', () => {
  test('walks back across year boundaries', () => {
    expect(monthsBack('2026-07', 0)).toBe('2026-07');
    expect(monthsBack('2026-07', 6)).toBe('2026-01');
    expect(monthsBack('2026-02', 3)).toBe('2025-11');
  });
});

describe('effectiveDate', () => {
  const card = { date: '2026-06-25T10:00:00.000Z', processedDate: '2026-07-10T10:00:00.000Z', company: 'isracard' };
  const bank = { ...card, company: 'leumi' };

  test('charge lens: card rows follow the debit date, banks follow the transaction date', () => {
    expect(effectiveDate(card, 'charge')).toBe(card.processedDate);
    expect(effectiveDate(bank, 'charge')).toBe(bank.date);
  });

  test('purchase lens: everything follows the transaction date', () => {
    expect(effectiveDate(card, 'purchase')).toBe(card.date);
  });
});

describe('applyLens', () => {
  const TODAY = '2026-07-13';
  const purchase = (day: string, processedDay: string, month: string) =>
    row({
      date: `2026-${day}T10:00:00.000Z`,
      processedDate: `2026-${processedDay}T10:00:00.000Z`,
      amount: -100,
      description: 'קניה',
      company: 'isracard',
      month: `2026-${month}`,
    });

  test('charge lens: next-cycle rows are excluded as future', () => {
    const rows = flagExcluded([purchase('07-05', '08-10', '08')], new Set());
    const out = applyLens(rows, { lens: 'charge', anchorDay: 1 }, TODAY);
    expect(out[0].excluded).toBe(true);
    expect(out[0].excludeReason).toBe('future');
  });

  test('purchase lens: the same row counts NOW, in its purchase month — you already spent the money', () => {
    const rows = flagExcluded([purchase('07-05', '08-10', '08')], new Set());
    const out = applyLens(rows, { lens: 'purchase', anchorDay: 1 }, TODAY);
    expect(out[0].excluded).toBe(false);
    expect(out[0].month).toBe('2026-07');
  });

  test('purchase lens re-buckets a cross-month charge back to its purchase month', () => {
    const rows = flagExcluded([purchase('06-25', '07-10', '07')], new Set());
    const out = applyLens(rows, { lens: 'purchase', anchorDay: 1 }, TODAY);
    expect(out[0].month).toBe('2026-06');
    expect(out[0].excluded).toBe(false);
  });

  test('anchor day shifts bank rows into the correct flow month', () => {
    const salary = row({ date: '2026-07-01T10:00:00.000Z', amount: 12400, description: 'משכורת', company: 'leumi' });
    const out = applyLens(flagExcluded([salary], new Set()), { lens: 'charge', anchorDay: 10 }, TODAY);
    expect(out[0].month).toBe('2026-06'); // July 1st is still June's flow month when months start on the 10th
  });

  test('settlement/transfer exclusions from flagExcluded survive untouched', () => {
    // the settlement matches the card details' net, so the details win and the settlement is excluded
    const settlement = row({ date: '2026-07-10T10:00:00.000Z', amount: -100, description: 'ישראכרט בעמ', company: 'leumi' });
    const cardCover = purchase('07-02', '07-10', '07');
    const flagged = flagExcluded([settlement, cardCover], new Set(['isracard']));
    const out = applyLens(flagged, { lens: 'purchase', anchorDay: 1 }, TODAY);
    const s = out.find((r) => r.company === 'leumi')!;
    expect(s.excluded).toBe(true);
    expect(s.excludeReason).toBe('settlement');
  });

  test('identity settings return rows unchanged', () => {
    const r = row({ date: '2026-07-05T10:00:00.000Z', amount: -50, description: 'קפה', company: 'leumi' });
    const flagged = flagExcluded([r], new Set());
    const out = applyLens(flagged, { lens: 'charge', anchorDay: 1 }, TODAY);
    expect(out[0]).toBe(flagged[0]);
  });
});

/* ——— the RiseUp-exact calendar: hard window; only a recurring main income waits for its month ——— */
describe('buildFlowCalendar', () => {
  const CHARGE_10 = { lens: 'charge' as const, anchorDay: 10 };
  const salary = (day: string, amount = 12_000) =>
    row({ date: `${day}T10:00:00.000Z`, amount, description: 'משכורת', company: 'leumi' });
  const flagged = (rows: ReturnType<typeof row>[]) => flagExcluded(rows, new Set());
  const SALARIES = [salary('2026-05-07'), salary('2026-06-08'), salary('2026-07-08')];

  test('the recurring salary of the 8th WAITS for the month starting on the 10th', () => {
    // RiseUp: "אם המשכורת נכנסת ב-9 ביולי, תזרים יולי (שמתחיל ב-10) מושך אליו את המשכורת"
    const cal = buildFlowCalendar(flagged(SALARIES), CHARGE_10);
    const july = flagged(SALARIES)[2];
    expect(cal.monthOfRow(july)).toBe('2026-07');
    // the window itself stays nominal — the month flips on the 10th, not on the salary
    expect(cal.startOf('2026-07')).toBe('2026-07-10');
    expect(cal.endOf('2026-06')).toBe('2026-07-09');
    expect(cal.monthOf('2026-07-08')).toBe('2026-06');
  });

  test('an expense in the pull zone obeys the hard window — rent of the 9th ends the old month', () => {
    // RiseUp: "סופרת כל הוצאה כאילו היא מחויבת בבנק ביום שבו היא בוצעה"
    const rent = row({ date: '2026-07-09T10:00:00.000Z', amount: -3500, description: 'שכר דירה', company: 'leumi' });
    const cal = buildFlowCalendar(flagged([...SALARIES, rent]), CHARGE_10);
    expect(cal.monthOfRow(flagged([rent])[0])).toBe('2026-06');
  });

  test('even a salary from the very start of the calendar month waits for its anchor', () => {
    // RiseUp: "גם אם המשכורת נכנסת ב-1 ביולי או אפילו ב-30 ביוני — ימתינו לתזרים יולי"
    const early = [salary('2026-05-01'), salary('2026-06-30'), salary('2026-08-01')];
    const cal = buildFlowCalendar(flagged(early), CHARGE_10);
    expect(cal.monthOfRow(flagged(early)[1])).toBe('2026-07'); // 30.6 funds the 10.7 flow
    expect(cal.monthOfRow(flagged(early)[2])).toBe('2026-08'); // 1.8 funds the 10.8 flow
  });

  test('a small refund near the anchor never changes months', () => {
    const refund = row({ date: '2026-07-08T10:00:00.000Z', amount: 250, description: 'החזר', company: 'leumi' });
    const cal = buildFlowCalendar(flagged([...SALARIES, refund]), CHARGE_10);
    expect(cal.monthOfRow(flagged([refund])[0])).toBe('2026-06');
  });

  test('a large ONE-OFF income obeys the hard window — only recurring incomes wait', () => {
    const check = row({ date: '2026-07-05T10:00:00.000Z', amount: 9_000, description: 'הפקדת שיק', company: 'leumi' });
    const cal = buildFlowCalendar(flagged([...SALARIES, check]), CHARGE_10);
    expect(cal.monthOfRow(flagged([check])[0])).toBe('2026-06');
  });

  test('a late salary needs no rule — the 12th is simply inside its month', () => {
    const late = [salary('2026-05-12'), salary('2026-06-12'), salary('2026-07-12')];
    const cal = buildFlowCalendar(flagged(late), CHARGE_10);
    expect(cal.monthOfRow(flagged(late)[2])).toBe('2026-07');
  });

  test('a sporadic big transfer is VARIABLE income — it obeys the hard window', () => {
    // RiseUp pulls "הכנסות קבועות" only. A ביט transfer of 2,740 ₪ that landed on the 8th is
    // not a salary, and treating it as one moved 2,727 ₪ into the wrong month — the entire
    // gap against RiseUp's June figure was this single row.
    const bit = row({ date: '2026-07-08T10:00:00.000Z', amount: 2_740, description: 'הפועלים-ביט', company: 'leumi' });
    const cal = buildFlowCalendar(flagged([
      ...SALARIES, salary('2026-04-08'), salary('2026-03-08'),
      row({ date: '2026-03-20T10:00:00.000Z', amount: 3_000, description: 'הפועלים-ביט', company: 'leumi' }),
      bit,
    ]), CHARGE_10);
    expect(cal.monthOfRow(flagged([bit])[0])).toBe('2026-06');
    // ...while the salary of the same day still waits for the month it funds
    expect(cal.monthOfRow(flagged(SALARIES)[2])).toBe('2026-07');
  });

  test('a payslip month with two payslips does not disqualify the salary', () => {
    // frequency, not occurrence count: two of his 24 months hold two payslips, and one
    // exception in two years must not unseat the most obviously fixed income there is
    const extra = row({ date: '2026-05-20T10:00:00.000Z', amount: 9_000, description: 'משכורת', company: 'leumi' });
    const cal = buildFlowCalendar(flagged([...SALARIES, salary('2026-04-08'), extra]), CHARGE_10);
    expect(cal.monthOfRow(flagged(SALARIES)[2])).toBe('2026-07');
  });

  test('a card credit can never wait — main income arrives at the bank', () => {
    const credit = [
      row({ date: '2026-06-08T10:00:00.000Z', amount: 5_000, description: 'זיכוי', company: 'max' }),
      row({ date: '2026-07-08T10:00:00.000Z', amount: 5_000, description: 'זיכוי', company: 'max' }),
    ];
    const cal = buildFlowCalendar(flagged([...SALARIES, ...credit]), CHARGE_10);
    expect(cal.monthOfRow(flagged(credit)[1])).toBe('2026-06');
  });

  test('anchor 1 stays a pure calendar month — no waiting zone', () => {
    const cal = buildFlowCalendar(flagged([salary('2026-06-28'), salary('2026-07-29')]), { lens: 'charge', anchorDay: 1 });
    expect(cal.startOf('2026-07')).toBe('2026-07-01');
    expect(cal.endOf('2026-07')).toBe('2026-07-31');
    expect(cal.monthOfRow(flagged([salary('2026-07-29')])[0])).toBe('2026-07');
  });

  test('applyLens end-to-end: salary waits forward, rent stays back — like his RiseUp screen', () => {
    const rows = flagged([
      ...SALARIES,
      row({ date: '2026-07-09T10:00:00.000Z', amount: -3500, description: 'שכר דירה', company: 'leumi' }),
    ]);
    const out = applyLens(rows, CHARGE_10, '2026-07-26');
    expect(out.find((r) => r.amount === 12_000 && r.date.startsWith('2026-07'))!.month).toBe('2026-07');
    expect(out.find((r) => r.amount === -3500)!.month).toBe('2026-06');
  });

  test('before its month opens, a waiting salary is future — "ימתינו וייכנסו לחישוב"', () => {
    const rows = flagged(SALARIES);
    const onTheNinth = applyLens(rows, CHARGE_10, '2026-07-09');
    const waiting = onTheNinth.find((r) => r.date.startsWith('2026-07'))!;
    expect(waiting).toMatchObject({ month: '2026-07', excluded: true, excludeReason: 'future' });
    const onTheTenth = applyLens(rows, CHARGE_10, '2026-07-10');
    expect(onTheTenth.find((r) => r.date.startsWith('2026-07'))!).toMatchObject({ month: '2026-07', excluded: false });
  });
});
