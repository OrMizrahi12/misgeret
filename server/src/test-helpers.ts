import { makeTxnKey, monthKey, type TxnRow } from './txns.js';

/** Builds a complete TxnRow from a partial — for tests only. */
export function row(partial: Partial<TxnRow> & { date: string; amount: number }): TxnRow {
  return {
    key: makeTxnKey(partial.account ?? 'acc-1', partial.date, partial.amount, partial.description ?? 'desc', null),
    account: 'acc-1',
    processedDate: null,
    originalAmount: partial.amount,
    currency: 'ILS',
    description: 'desc',
    memo: null,
    status: 'completed',
    month: monthKey(partial.date),
    company: 'leumi',
    connectionId: 1,
    type: 'normal' as const,
    installmentNumber: null,
    installmentTotal: null,
    chargedCurrency: null,
    issuerCategory: null,
    category: null,
    categorySource: null,
    ...partial,
  };
}
