import { describe, expect, test } from 'vitest';
import { alertsFromInsights, forecastFloorAlert } from './alerts.js';
import type { Insight } from './insights.js';

const insight = (over: Partial<Insight> & { type: Insight['type'] }): Insight => ({
  textHe: 'טקסט', amount: 100, refs: ['t1'], ...over,
});

describe('alertsFromInsights', () => {
  test('only duplicate-charge and price-hike interrupt; the rest stay quiet', () => {
    const alerts = alertsFromInsights([
      insight({ type: 'duplicate-charge', refs: ['b', 'a'] }),
      insight({ type: 'price-hike', refs: ['t9'] }),
      insight({ type: 'fee' }),
      insight({ type: 'new-recurring' }),
    ]);
    expect(alerts.map((a) => a.type)).toEqual(['duplicate-charge', 'price-hike']);
  });

  test('keys are stable facts: same rows in any order → same key; wording changes nothing', () => {
    const first = alertsFromInsights([insight({ type: 'duplicate-charge', refs: ['b', 'a'], textHe: 'ניסוח א' })]);
    const second = alertsFromInsights([insight({ type: 'duplicate-charge', refs: ['a', 'b'], textHe: 'ניסוח ב' })]);
    expect(first[0].key).toBe(second[0].key);
    expect(first[0].key).toBe('dup|a|b');
  });

  test('an insight pointing at no rows cannot be keyed — dropped, not invented', () => {
    expect(alertsFromInsights([insight({ type: 'duplicate-charge', refs: [] })])).toEqual([]);
  });
});

describe('forecastFloorAlert', () => {
  const path = [
    { date: '2026-07-25', balance: 4000 },
    { date: '2026-08-02', balance: -900 },
    { date: '2026-08-09', balance: -6000 },
  ];

  test('no overdraft frame: the floor is zero', () => {
    const a = forecastFloorAlert(path, 0, '2026-07-24');
    expect(a).not.toBeNull();
    expect(a!.key).toBe('floor|2026-08');
    expect(a!.target).toBe('future');
    expect(a!.bodyHe).toContain('מתחת לאפס');
  });

  test('with a frame, a dip WITHIN it stays quiet; crossing it alerts', () => {
    expect(forecastFloorAlert(path.slice(0, 2), 2000, '2026-07-24')).toBeNull();
    const a = forecastFloorAlert(path, 2000, '2026-07-24');
    expect(a).not.toBeNull();
    expect(a!.key).toBe('floor|2026-08');
    expect(a!.bodyHe).toContain('מסגרת האשראי');
  });

  test('a path that never dips → no alert; past dips are not news', () => {
    expect(forecastFloorAlert([{ date: '2026-08-01', balance: 12 }], 0, '2026-07-24')).toBeNull();
    expect(forecastFloorAlert([{ date: '2026-07-20', balance: -50 }], 0, '2026-07-24')).toBeNull();
  });
});
