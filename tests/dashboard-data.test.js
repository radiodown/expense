import test from 'node:test';
import assert from 'node:assert/strict';
import { expenseCalendar, expenseLevel, categoryExpenseTrends } from '../src/dashboard-data.js';

test('expense calendar covers twelve complete months, leap days and Sunday-based weeks', () => {
  const calendar = expenseCalendar([], '2024-02');
  assert.equal(calendar.start, '2023-03-01');
  assert.equal(calendar.end, '2024-02-29');
  assert.equal(calendar.days.length, 366);
  assert.equal(calendar.weeks, 53);
  assert.equal(calendar.months.length, 12);
  assert.deepEqual(calendar.days[0], { date: '2023-03-01', amount: 0, count: 0, level: 0, column: 0, row: 3 });
  assert.equal(calendar.days[4].date, '2023-03-05');
  assert.equal(calendar.days[4].row, 0);
  assert.equal(calendar.days[4].column, 1);
  assert.equal(calendar.days.at(-1).date, '2024-02-29');
  assert.equal(new Set(calendar.days.map(day => day.date)).size, 366);
  for (const day of calendar.days) assert.ok(day.column < calendar.weeks && day.row >= 0 && day.row <= 6);
});

test('daily spending sums expenses and outgoing transfers without subtracting refunds or incoming transfers', () => {
  const transactions = [
    { date: '2025-11-01', type: 'expense', amount: 100000 },
    { date: '2025-11-01', type: 'expense', amount: 25000, isRefund: true },
    { date: '2026-10-31', type: 'expense', amount: 10000, importSource: { type: '\uC774\uCCB4' } },
    { date: '2026-10-31', type: 'expense', amount: 20000, isRefund: true, importSource: { type: '\uC774\uCCB4' } },
    { date: '2026-10-30', type: 'expense', amount: 50000, isRefund: true },
    { date: '2025-10-31', type: 'expense', amount: 900000 },
    { date: '2026-11-01', type: 'expense', amount: 900000 },
    { date: '2026-10-31', type: 'saving', amount: 900000 },
    { date: '2026-10-31', type: 'income', amount: 900000 },
  ];
  const original = structuredClone(transactions);
  const calendar = expenseCalendar(transactions, '2026-10');
  assert.equal(calendar.amount, 110000);
  assert.equal(calendar.count, 2);
  assert.equal(calendar.days[0].amount, 100000);
  assert.equal(calendar.days[0].count, 1);
  assert.equal(calendar.days[0].level, 3);
  assert.equal(calendar.days.at(-1).amount, 10000);
  assert.equal(calendar.days.at(-1).level, 1);
  assert.equal(calendar.days.at(-1).count, 1);
  assert.equal(calendar.days.at(-2).amount, 0);
  assert.equal(calendar.days.at(-2).count, 0);
  assert.equal(calendar.days.at(-2).level, 0);
  assert.equal(calendar.days[1].count, 0);
  assert.equal(calendar.days[1].level, 0);
  assert.deepEqual(transactions, original);
});

test('expense colors use consistent won boundaries and have no negative spending level', () => {
  const amounts = [-1000, 0, 1, 29999, 30000, 99999, 100000, 299999, 300000, 1000000];
  assert.deepEqual(amounts.map(expenseLevel), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
});

test('monthly category series span year boundaries, fill absent months and preserve edited classifications', () => {
  const categories = [
    { id: 'custom', name: 'Renamed category', type: 'expense' },
    { id: 'salary', name: 'Salary', type: 'income' },
    { id: 'other', name: 'Other', type: 'expense' },
    { id: 'unused', name: 'Unused', type: 'expense' },
  ];
  const transactions = [
    { date: '2025-09-01', type: 'expense', category: 'custom', amount: 900000 },
    { date: '2025-10-01', type: 'expense', category: 'custom', amount: 100000 },
    { date: '2026-01-01', type: 'expense', category: 'other', amount: 8000 },
    { date: '2026-03-31', type: 'expense', category: 'custom', amount: 20000 },
    { date: '2026-03-31', type: 'expense', category: 'custom', amount: 30000, isRefund: true, importSource: { type: '\uC774\uCCB4' } },
    { date: '2026-03-31', type: 'saving', category: 'custom', amount: 900000 },
    { date: '2026-03-31', type: 'income', category: 'salary', amount: 900000 },
    { date: '2026-04-01', type: 'expense', category: 'custom', amount: 900000 },
  ];
  const original = structuredClone({ transactions, categories });
  const { months, series } = categoryExpenseTrends(transactions, '2026-03', categories);
  assert.deepEqual(months.map(row => row.key), ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03']);
  assert.deepEqual(months.map(row => row.total), [100000, 0, 0, 8000, 0, -10000]);
  assert.deepEqual(series.map(category => category.id), ['custom', 'other']);
  assert.equal(series[0].name, 'Renamed category');
  assert.equal(series[0].count, 3);
  assert.equal(series[1].count, 1);
  assert.deepEqual(months.map(row => row[series[0].dataKey]), [100000, 0, 0, 0, 0, -10000]);
  assert.deepEqual(months.map(row => row[series[1].dataKey]), [0, 0, 0, 8000, 0, 0]);
  assert.deepEqual({ transactions, categories }, original);
});

test('net-zero categories remain available, and empty periods still have six months', () => {
  const categories = [{ id: 'a', type: 'expense', name: 'A' }];
  const transactions = [
    { date: '2026-10-01', type: 'expense', category: 'a', amount: 5000 },
    { date: '2026-10-01', type: 'expense', category: 'a', amount: 5000, isRefund: true },
  ];
  const { months, series } = categoryExpenseTrends(transactions, '2026-10', categories);
  assert.equal(series.length, 1);
  assert.equal(series[0].count, 2);
  assert.equal(months.at(-1).total, 0);
  const empty = categoryExpenseTrends([], '2026-10', categories);
  assert.equal(empty.months.length, 6);
  assert.deepEqual(empty.series, []);
  const day = expenseCalendar(transactions, '2026-10').days.find(item => item.date === '2026-10-01');
  assert.equal(day.count, 1);
  assert.equal(day.amount, 5000);
  assert.equal(day.level, 1);
});
