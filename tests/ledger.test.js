import test from 'node:test';
import assert from 'node:assert/strict';
import { summary, transferSummary, cashValue, trends, categoryTotals, transactionSchema, makeDemo, budgetSummary, fixedDate, backupSchema } from '../shared/ledger.js';

test('monthly totals isolate months and preserve negative balances', () => {
  const items = [
    { date: '2026-10-01', type: 'income', amount: 10000, category: 'salary' },
    { date: '2026-10-20', type: 'expense', amount: 13000, category: 'food' },
    { date: '2026-09-30', type: 'expense', amount: 2000, category: 'food' },
  ];
  const result = summary(items, '2026-10');
  assert.equal(result.income, 10000);
  assert.equal(result.expense, 13000);
  assert.equal(result.balance, -3000);
  assert.equal(result.rate, -30);
  assert.equal(categoryTotals(result.items)[0].value, 13000);
  assert.equal(summary([], '2026-10').rate, null);
});

test('old backups retain discontinued categories and can be exported again after restore', () => {
  const transaction = { id: '00000000-0000-4000-8000-000000000001', type: 'expense', date: '2026-10-01', title: '이전 쇼핑 내역', category: 'shopping', method: '현금', amount: 1000 };
  const fixed = { id: '00000000-0000-4000-8000-000000000002', month: '2026-10', title: '이전 예정 항목', category: 'shopping', method: '현금', amount: 1000, day: 1 };
  assert.equal(transactionSchema.safeParse(transaction).success, false);
  for (const version of [1, 2]) {
    const restored = backupSchema.parse({ version, transactions: [transaction], budgets: {}, ...(version === 2 ? { fixedExpenses: [fixed] } : {}) });
    assert.equal(restored.transactions[0].category, 'shopping');
    assert.equal(restored.categories.find(c => c.id === 'shopping').name, '쇼핑');
    assert.ok(backupSchema.safeParse({ ...restored, version: 4 }).success);
  }
});
test('six month trends cross years and include empty months', () => {
  const result = trends([], '2026-02');
  assert.deepEqual(result.map(t => t.key), ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02']);
  assert.ok(result.every(t => t.income === 0 && t.expense === 0));
});
test('validation rejects impossible dates, fractional amounts and category mismatch', () => {
  const item = { date: '2024-02-29', type: 'expense', amount: 1, category: 'food', title: '점심', method: '현금' };
  assert.ok(transactionSchema.safeParse(item).success);
  for (const patch of [{ date: '2025-02-29' }, { date: '2026-13-01' }, { amount: 0 }, { amount: -10 }, { amount: 1.5 }, { title: ' ' }, { category: 'salary' }]) {
    assert.equal(transactionSchema.safeParse({ ...item, ...patch }).success, false);
  }
});
test('demo records are valid, uniquely identified and separate from storage', () => {
  const demo = makeDemo('2026-10');
  assert.equal(Object.keys(demo.budgets).length, 6);
  assert.equal(new Set(demo.transactions.map(t => t.id)).size, demo.transactions.length);
  assert.ok(demo.transactions.every(t => transactionSchema.safeParse(t).success));
  assert.ok(backupSchema.safeParse({ version: 5, ...demo }).success);
});
test('budget reserves unpaid plans and counts actual fixed payments only once', () => {
  const data = { budgets: { '2026-10': 1000 }, fixedExpenses: [
    { id: 'rent', month: '2026-10', amount: 600 }, { id: 'phone', month: '2026-10', amount: 100 },
    { id: 'future', month: '2026-11', amount: 9999 },
  ], transactions: [
    { date: '2026-10-05', type: 'expense', amount: 550, fixedExpenseId: 'rent' },
    { date: '2026-10-06', type: 'expense', amount: 200 },
    { date: '2026-10-01', type: 'income', amount: 2000 },
  ] };
  const b = budgetSummary(data, '2026-10');
  assert.equal(b.planned, 700);
  assert.equal(b.pending, 100);
  assert.equal(b.paid, 550);
  assert.equal(b.variable, 200);
  assert.equal(b.actual, 750);
  assert.equal(b.remaining, 250);
  assert.equal(b.available, 150);
  assert.equal(b.variableBudget, 300);
  data.transactions = data.transactions.filter(t => !t.fixedExpenseId);
  assert.equal(budgetSummary(data, '2026-10').pending, 700);
});
test('fixed due dates clamp to month end, including leap years', () => {
  assert.equal(fixedDate({ month: '2026-02', day: 31 }), '2026-02-28');
  assert.equal(fixedDate({ month: '2024-02', day: 31 }), '2024-02-29');
  assert.equal(fixedDate({ month: '2026-04', day: 31 }), '2026-04-30');
  assert.equal(fixedDate({ month: '2026-10', day: 5 }), '2026-10-05');
});
test('category totals use edited names and custom categories while subtracting refunds', () => {
  const list = [{ id: 'custom', type: 'expense', name: '편집한 이름' }, { id: 'pay', type: 'income', name: '수입' }];
  const totals = categoryTotals([
    { type: 'expense', category: 'custom', amount: 10000 },
    { type: 'expense', category: 'custom', amount: 2000, isRefund: true },
    { type: 'income', category: 'pay', amount: 20000 },
  ], list);
  assert.equal(totals.length, 1);
  assert.equal(totals[0].name, '편집한 이름');
  assert.equal(totals[0].value, 8000);
});
test('transfer cash signs are preserved while income, expenses, budgets and trends exclude them', () => {
  const transfers = [
    { date: '2026-10-01', type: 'transfer', category: 'transfer', amount: 100000, transferDirection: 'in' },
    { date: '2026-10-02', type: 'transfer', category: 'transfer', amount: 50000, transferDirection: 'out' },
  ];
  const transactions = [...transfers,
    { date: '2026-10-03', type: 'income', category: 'salary', amount: 20000 },
    { date: '2026-10-04', type: 'expense', category: 'food', amount: 5000 },
  ];
  assert.equal(cashValue(transfers[0]), 100000);
  assert.equal(cashValue(transfers[1]), -50000);
  assert.deepEqual(transferSummary(transactions), { incoming: 100000, outgoing: 50000, balance: 50000, count: 2 });
  assert.equal(summary(transactions, '2026-10').income, 20000);
  assert.equal(summary(transactions, '2026-10').expense, 5000);
  assert.equal(summary(transactions, '2026-10').balance, 15000);
  assert.equal(trends(transactions, '2026-10').at(-1).balance, 15000);
  assert.equal(budgetSummary({ transactions, budgets: { '2026-10': 10000 } }, '2026-10').remaining, 5000);
  assert.deepEqual(categoryTotals(transfers), []);
});
test('transfer schemas reject missing direction, refunds and fixed plan links', () => {
  const transfer = { type: 'transfer', amount: 100, date: '2026-10-01', title: '이체', method: '통장', category: 'transfer', transferDirection: 'out' };
  assert.ok(transactionSchema.safeParse(transfer).success);
  for (const patch of [{ transferDirection: null }, { transferDirection: 'wrong' }, { category: 'food' }, { isRefund: true }, { fixedExpenseId: '00000000-0000-4000-8000-000000000001' }, { type: 'expense', category: 'food' }]) {
    assert.equal(transactionSchema.safeParse({ ...transfer, ...patch }).success, false);
  }
});

test('savings and withdrawals are separate from spending while monthly cash balance includes both', () => {
  const transactions = [
    { date: '2026-10-01', type: 'income', amount: 100000, category: 'salary' },
    { date: '2026-10-02', type: 'expense', amount: 20000, category: 'food' },
    { date: '2026-10-03', type: 'saving', amount: 30000, category: 'food' },
    { date: '2026-10-04', type: 'saving', amount: 5000, category: 'food', isRefund: true },
    { date: '2026-10-05', type: 'transfer', amount: 999999, category: 'transfer', transferDirection: 'in' },
    { date: '2026-09-01', type: 'saving', amount: 999, category: 'other' },
  ];
  const result = summary(transactions, '2026-10');
  assert.equal(result.income, 100000);
  assert.equal(result.expense, 20000);
  assert.equal(result.saving, 25000);
  assert.equal(result.balance, 55000);
  assert.ok(Math.abs(result.rate - 55) < 1e-10);
  assert.equal(cashValue(transactions[2]), -30000);
  assert.equal(cashValue(transactions[3]), 5000);
  assert.equal(budgetSummary({ transactions, budgets: { '2026-10': 50000 } }, '2026-10').remaining, 30000);
  assert.equal(categoryTotals(result.items)[0].value, 20000);
  const months = trends(transactions, '2026-10');
  assert.equal(months.at(-1).saving, 25000);
  assert.equal(months.at(-2).saving, 999);
  assert.equal(months.at(-3).saving, 0);
});

test('savings use expense classifications and require v5 backups without fixed-payment links', () => {
  const saving = { id: '00000000-0000-4000-8000-000000000001', type: 'saving', amount: 10000, date: '2026-10-01', title: '적금', category: 'other', method: '저축 통장' };
  assert.ok(transactionSchema.safeParse(saving).success);
  assert.ok(transactionSchema.safeParse({ ...saving, isRefund: true }).success);
  for (const patch of [{ category: 'salary' }, { transferDirection: 'out' }, { fixedExpenseId: '00000000-0000-4000-8000-000000000002' }]) {
    assert.equal(transactionSchema.safeParse({ ...saving, ...patch }).success, false);
  }
  const backup = { ...makeDemo('2026-10'), version: 5, transactions: [saving], fixedExpenses: [] };
  assert.ok(backupSchema.safeParse(backup).success);
  assert.equal(backupSchema.safeParse({ ...backup, version: 4 }).success, false);
});
