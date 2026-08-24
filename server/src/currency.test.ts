import { describe, expect, test } from 'vitest';
import { CURRENCIES, fetchIlsRates, isSupportedCurrency } from './currency.js';

type FakeResponse = { ok: boolean; json(): Promise<unknown> };
const respond = (body: unknown, ok = true): FakeResponse => ({ ok, json: async () => body });

describe('isSupportedCurrency', () => {
  test('accepts the list, rejects everything else', () => {
    expect(isSupportedCurrency('ILS')).toBe(true);
    expect(isSupportedCurrency('USD')).toBe(true);
    expect(isSupportedCurrency('usd')).toBe(false); // codes are exact — the client sends them verbatim
    expect(isSupportedCurrency('BTC')).toBe(false);
    expect(isSupportedCurrency(7)).toBe(false);
  });

  test('every listed currency has a Hebrew name and a symbol', () => {
    for (const c of CURRENCIES) {
      expect(c.nameHe.length).toBeGreaterThan(1);
      expect(c.symbol.length).toBeGreaterThan(0);
    }
  });
});

describe('fetchIlsRates', () => {
  test('primary provider: inverts one-ILS-buys-X into ILS-per-unit', async () => {
    const fetchImpl = async (url: string) => {
      expect(url).toContain('frankfurter');
      return respond({ base: 'ILS', rates: { USD: 0.27, EUR: 0.25, GBP: 0.21 } });
    };
    const res = await fetchIlsRates(fetchImpl);
    expect(res.source).toBe('frankfurter');
    expect(res.ratesIlsPerUnit.USD).toBeCloseTo(1 / 0.27, 3);
    expect(res.ratesIlsPerUnit.EUR).toBeCloseTo(4, 1);
    expect(res.ratesIlsPerUnit.ILS).toBe(1);
  });

  test('falls back to the second provider when the first fails', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      if (url.includes('frankfurter')) throw new Error('down');
      return respond({ result: 'success', rates: { ILS: 1, USD: 0.27, EUR: 0.25 } });
    };
    const res = await fetchIlsRates(fetchImpl);
    expect(res.source).toBe('open-er-api');
    expect(res.ratesIlsPerUnit.USD).toBeCloseTo(3.7037, 3);
    expect(calls).toHaveLength(2);
  });

  test('garbage rates are skipped, and a response without the majors falls through', async () => {
    const fetchImpl = async (url: string) => {
      if (url.includes('frankfurter')) return respond({ rates: { USD: -3, EUR: 'four' } }); // unusable
      return respond({ result: 'success', rates: { USD: 0.27, EUR: 0.25, THB: 0 } });
    };
    const res = await fetchIlsRates(fetchImpl);
    expect(res.source).toBe('open-er-api');
    expect(res.ratesIlsPerUnit.THB).toBeUndefined(); // zero rate is garbage, not a number to divide by
  });

  test('throws only when BOTH providers fail — the caller falls back to the cache', async () => {
    const fetchImpl = async () => respond({}, false);
    await expect(fetchIlsRates(fetchImpl)).rejects.toThrow();
  });
});
