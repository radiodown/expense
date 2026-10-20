import { categoryOf, transactionLabel, refundLabel } from '../shared/ledger.js';

export const transactionColumns = [
  { key: 'date', label: '날짜' },
  { key: 'type', label: '구분' },
  { key: 'title', label: '내용' },
  { key: 'category', label: '카테고리' },
  { key: 'method', label: '계좌·결제수단' },
  { key: 'amount', label: '금액', numeric: true },
];

const textOrder = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

export function sortTransactions(items, sort, categories) {
  const direction = sort.direction === 'asc' ? 1 : -1;
  function value(item) {
    if (sort.key === 'category') return categoryOf(item.category, categories).name;
    if (sort.key === 'type') return `${item.fixedExpenseId ? '고정지출' : transactionLabel(item)}${item.isRefund ? ` ${refundLabel(item.type)}` : ''}`;
    return item[sort.key];
  }
  return [...items].sort((a, b) => {
    const comparison = sort.key === 'amount' ? a.amount - b.amount : textOrder.compare(value(a), value(b));
    return comparison * direction || b.date.localeCompare(a.date);
  });
}
