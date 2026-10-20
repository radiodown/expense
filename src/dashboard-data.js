import { addDays, differenceInCalendarDays, endOfMonth, format, getDay, parseISO } from 'date-fns';
import { categories as defaultCategories, shiftMonth, transactionValue } from '../shared/ledger.js';

// Fixed won thresholds keep the same color meaningful when the period changes.
export const expenseLevels = [
  { level: 0, label: '0원' },
  { level: 1, label: '1원 ~ 3만원 미만' },
  { level: 2, label: '3만원 ~ 10만원 미만' },
  { level: 3, label: '10만원 ~ 30만원 미만' },
  { level: 4, label: '30만원 이상' },
];
export function expenseLevel(amount) {
  if (amount <= 0) return 0;
  if (amount < 30000) return 1;
  if (amount < 100000) return 2;
  return amount < 300000 ? 3 : 4;
}

export function expenseCalendar(transactions, month) {
  const start = `${shiftMonth(month, -11)}-01`;
  const first = parseISO(start);
  const last = endOfMonth(parseISO(`${month}-01`));
  const end = format(last, 'yyyy-MM-dd');
  const offset = getDay(first);
  const length = differenceInCalendarDays(last, first) + 1;
  const totals = new Map();
  let amount = 0, count = 0;
  for (const transaction of transactions) {
    if (transaction.type !== 'expense' || transaction.isRefund || transaction.date < start || transaction.date > end) continue;
    const day = totals.get(transaction.date) || { amount: 0, count: 0 };
    const value = transaction.amount;
    day.amount += value;
    day.count++;
    totals.set(transaction.date, day);
    amount += value;
    count++;
  }
  const days = Array.from({ length }, (_, index) => {
    const date = format(addDays(first, index), 'yyyy-MM-dd');
    const total = totals.get(date) || { amount: 0, count: 0 };
    return { date, ...total, level: expenseLevel(total.amount), column: Math.floor((offset + index) / 7), row: (offset + index) % 7 };
  });
  // Use the first full week for month labels to avoid overlapping adjacent labels.
  const months = days.filter(day => day.date.endsWith('-01')).map(day => ({
    key: day.date.slice(0, 7), label: `${Number(day.date.slice(5, 7))}월`, column: day.column + (day.row === 0 ? 0 : 1),
  }));
  return { start, end, days, months, weeks: Math.ceil((offset + length) / 7), amount, count };
}

export function categoryExpenseTrends(transactions, month, categories = defaultCategories) {
  const series = categories.filter(category => category.type === 'expense').map((category, index) => ({
    ...category, dataKey: `category${index}`, colorIndex: index % 10 + 1, count: 0,
  }));
  const categoryMap = new Map(series.map(category => [category.id, category]));
  const months = Array.from({ length: 6 }, (_, index) => {
    const key = shiftMonth(month, index - 5);
    return { key, name: `${Number(key.slice(5))}월`, total: 0, ...Object.fromEntries(series.map(category => [category.dataKey, 0])) };
  });
  const monthMap = new Map(months.map(row => [row.key, row]));
  for (const transaction of transactions) {
    if (transaction.type !== 'expense') continue;
    const row = monthMap.get(transaction.date.slice(0, 7));
    const category = categoryMap.get(transaction.category);
    if (!row || !category) continue;
    const value = transactionValue(transaction);
    row[category.dataKey] += value;
    row.total += value;
    category.count++;
  }
  // Keep categories with transactions even when refunds cancel their net total.
  return { months, series: series.filter(category => category.count > 0) };
}
