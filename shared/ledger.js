import { z } from 'zod';
import { format, subMonths, parseISO, getDaysInMonth } from 'date-fns';
import { categories, legacyCategories } from './categories.js';
import { storedAssetSchema, makeAssetDemo } from './assets.js';

export { categories };
export const methods = ['신용카드', '체크카드', '계좌이체', '현금'];
export const transactionTypes = { income: '수입', expense: '지출', saving: '저축', transfer: '이체' };
// '지출' ends in ㄹ, so it takes 로; the others take 으로.
export const toTypeLabel = type => `${transactionTypes[type]}${type === 'expense' ? '로' : '으로'}`;
export const categoryType = type => type === 'saving' ? 'expense' : type;
export const refundLabel = (type, source) => type === 'saving' ? '취소·인출' : type === 'expense' && source?.type === '이체' ? '입금 (지출 차감)' : '취소·환급';
export const transferCategory = { id: 'transfer', name: '이체', type: 'transfer', color: '#636366' };
export const transactionLabel = t => t.type === 'transfer' ? `이체 ${t.transferDirection === 'in' ? '입금' : '출금'}` : t.type === 'expense' && t.importSource?.type === '이체' ? `이체 ${t.isRefund ? '입금' : '출금'}` : transactionTypes[t.type];
export function normalizeTransfer(t) {
  if (t.type !== 'transfer') return t;
  return { ...t, type: 'expense', category: 'other', isRefund: t.transferDirection === 'in', transferDirection: null, fixedExpenseId: null,
    importSource: t.importSource ? { ...t.importSource, type: '이체' } : null };
}
export const fallbackCategory = type => type === 'income' ? 'income-other' : 'other';
// Corrections between ledgers. Crossing expense/income switches category lists, so the row lands in that side's 기타 as a plain entry.
export const moveTargets = { expense: ['saving', 'income'], saving: ['expense'], income: ['expense'] };
export function movedTransaction(t, type) {
  const crossesCategories = categoryType(t.type) !== categoryType(type);
  return { ...t, type, fixedExpenseId: null, ...(crossesCategories ? { category: fallbackCategory(type), isRefund: false } : {}) };
}
const categoryIdSchema = z.string().regex(/^[a-zA-Z0-9-]{1,64}$/);
export const categorySchema = z.object({
  name: z.string().trim().min(1).max(40),
  type: z.enum(['income', 'expense']),
  color: z.string().regex(/^#[a-fA-F0-9]{6}$/).default('#8e8e93'),
  icon: z.string().max(40).default('Ellipsis'),
});
const storedCategorySchema = categorySchema.extend({ id: categoryIdSchema });
const amountSchema = z.number().int().min(0).max(999_999_999_999);
export const categoryBudgetSchema = z.object({
  amounts: z.record(categoryIdSchema, amountSchema),
}).refine(v => Object.values(v.amounts).reduce((s, a) => s + a, 0) <= 999_999_999_999, '카테고리 예산 합계가 너무 큽니다.');
export const today = () => format(new Date(), 'yyyy-MM-dd');
export const currentMonth = () => today().slice(0, 7);
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).refine(v => v >= '1900-01' && v <= '2100-12');
const transactionFields = z.object({
  type: z.enum(['income', 'expense', 'saving', 'transfer']),
  amount: z.number().int().min(1).max(999_999_999_999),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
    const d = new Date(`${v}T00:00:00Z`);
    return !isNaN(d) && d.toISOString().slice(0, 10) === v && v >= '1900-01-01' && v <= '2100-12-31';
  }, '올바른 날짜를 입력해 주세요.'),
  title: z.string().trim().min(1).max(100),
  category: categoryIdSchema,
  method: z.string().trim().min(1).max(100),
  note: z.string().trim().max(500).default(''),
  fixedExpenseId: z.string().uuid().nullable().default(null),
  isRefund: z.boolean().default(false),
  transferDirection: z.enum(['in', 'out']).nullable().default(null),
  importKey: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  importSource: z.object({
    type: z.enum(['수입', '지출', '이체']).optional(),
    fileName: z.string().max(255), sheet: z.literal(2), row: z.number().int().min(1),
    category: z.string().max(100), subcategory: z.string().max(100),
    time: z.string().max(30), originalAmount: z.number().finite(),
  }).nullable().default(null),
});
const validTransactionType = (t, list) => t.type === 'transfer'
  ? t.category === 'transfer' && ['in', 'out'].includes(t.transferDirection) && !t.isRefund && !t.fixedExpenseId
  : t.transferDirection === null && (t.type !== 'saving' || !t.fixedExpenseId) && list.some(c => c.id === t.category && c.type === categoryType(t.type));
export const createTransactionSchema = (list = categories) => transactionFields.refine(v => validTransactionType(v, list), {
  message: '거래 구분에 맞는 카테고리와 이체 방향을 확인해 주세요.', path: ['category'],
});
export const transactionSchema = createTransactionSchema();
export const budgetSchema = z.object({ amount: z.number().int().min(0).max(999_999_999_999) });
const fixedExpenseFields = z.object({
  month: monthSchema,
  title: z.string().trim().min(1).max(100),
  amount: z.number().int().min(1).max(999_999_999_999),
  day: z.number().int().min(1).max(31),
  category: categoryIdSchema,
  method: z.string().trim().min(1).max(100),
  note: z.string().trim().max(500).default(''),
});
export const createFixedExpenseSchema = (list = categories) => fixedExpenseFields.refine(v => list.some(c => c.id === v.category && c.type === 'expense'), { path: ['category'], message: '지출 카테고리를 선택해 주세요.' });
export const fixedExpenseSchema = createFixedExpenseSchema();
const backupFields = {
  transactions: z.array(transactionFields.extend({ id: z.string().uuid() })).max(100000),
  budgets: z.record(monthSchema, z.number().int().min(0).max(999_999_999_999)),
};
const fixedBackup = z.array(fixedExpenseFields.extend({ id: z.string().uuid() })).max(100000);
const modernBackupFields = {
  ...backupFields, fixedExpenses: fixedBackup,
  categories: z.array(storedCategorySchema).min(2).max(500),
  categoryBudgets: z.record(monthSchema, z.record(categoryIdSchema, amountSchema)),
};
const legacyAssets = z.array(storedAssetSchema).max(0).default([]);
export const backupSchema = z.union([
  z.object({ version: z.literal(1), ...backupFields, assets: legacyAssets }).transform(v => ({ ...v, fixedExpenses: [], categories: legacyCategories, categoryBudgets: {} })),
  z.object({ version: z.literal(2), ...backupFields, fixedExpenses: fixedBackup, assets: legacyAssets }).transform(v => ({ ...v, categories: legacyCategories, categoryBudgets: {} })),
  z.object({ version: z.union([z.literal(3), z.literal(4), z.literal(5)]), ...modernBackupFields, assets: legacyAssets }),
  z.object({ version: z.literal(6), ...modernBackupFields, assets: z.array(storedAssetSchema).max(1000) }),
]).superRefine((v, ctx) => {
  const invalid = message => ctx.addIssue({ code: 'custom', message });
  if (new Set(v.assets.map(asset => asset.id)).size !== v.assets.length) invalid('중복된 자산 ID가 있습니다.');
  const categoryMap = new Map(v.categories.map(c => [c.id, c]));
  if (categoryMap.has('transfer')) invalid('이체 전용 분류는 사용자 카테고리로 등록할 수 없습니다.');
  if (categoryMap.size !== v.categories.length) invalid('중복된 카테고리 ID가 있습니다.');
  if (new Set(v.categories.map(c => `${c.type}:${c.name.toLowerCase()}`)).size !== v.categories.length) invalid('중복된 카테고리 이름이 있습니다.');
  for (const type of ['income', 'expense']) {
    if (categoryMap.get(fallbackCategory(type))?.type !== type) invalid('기본 기타 카테고리가 필요합니다.');
  }
  for (const t of v.transactions) {
    if (!validTransactionType(t, v.categories)) invalid('거래 구분 또는 카테고리가 올바르지 않습니다.');
    if (t.type === 'transfer' && v.version < 4) invalid('이체 내역에는 버전 4 백업이 필요합니다.');
    if (t.type === 'saving' && v.version < 5) invalid('저축 내역에는 버전 5 백업이 필요합니다.');
  }
  for (const f of v.fixedExpenses) if (categoryMap.get(f.category)?.type !== 'expense') invalid('고정지출 카테고리가 올바르지 않습니다.');
  for (const amounts of Object.values(v.categoryBudgets)) {
    if (!categoryBudgetSchema.safeParse({ amounts }).success || Object.keys(amounts).some(id => categoryMap.get(id)?.type !== 'expense')) invalid('카테고리 예산이 올바르지 않습니다.');
  }
  if (new Set(v.transactions.map(t => t.id)).size !== v.transactions.length) invalid('중복된 기록 ID가 있습니다.');
  const fixed = new Map(v.fixedExpenses.map(f => [f.id, f]));
  if (fixed.size !== v.fixedExpenses.length) invalid('중복된 고정지출 ID가 있습니다.');
  const linked = new Set();
  const imported = new Set();
  for (const t of v.transactions) {
    if (t.importKey && imported.has(t.importKey)) invalid('중복된 엑셀 가져오기 내역입니다.');
    if (t.importKey) imported.add(t.importKey);
    if (!t.fixedExpenseId) continue;
    const f = fixed.get(t.fixedExpenseId);
    if (!f || t.isRefund || t.type !== 'expense' || !t.date.startsWith(f.month) || linked.has(f.id)) invalid('고정지출 연결이 올바르지 않습니다.');
    linked.add(t.fixedExpenseId);
  }
}).transform(v => ({ ...v, transactions: v.transactions.map(normalizeTransfer) }));
export const fixedDate = item => `${item.month}-${String(Math.min(item.day, getDaysInMonth(parseISO(`${item.month}-01`)))).padStart(2, '0')}`;
export function budgetSummary(data, month) {
  const actual = summary(data.transactions, month);
  const fixed = (data.fixedExpenses || []).filter(f => f.month === month);
  const links = new Map(actual.items.filter(t => t.fixedExpenseId).map(t => [t.fixedExpenseId, t]));
  const planned = fixed.reduce((sum, f) => sum + f.amount, 0);
  const pending = fixed.filter(f => !links.has(f.id)).reduce((sum, f) => sum + f.amount, 0);
  const paid = actual.items.filter(t => t.type === 'expense' && t.fixedExpenseId).reduce((sum, t) => sum + transactionValue(t), 0);
  const budget = data.budgets[month] || 0;
  return { fixed, links, planned, pending, paid, budget, actual: actual.expense, variable: actual.expense - paid,
    remaining: budget - actual.expense, available: budget - actual.expense - pending, variableBudget: budget - planned };
}
export const won = value => `${new Intl.NumberFormat('ko-KR').format(value)}원`;
export const transactionValue = t => t.type === 'transfer' ? (t.transferDirection === 'in' ? t.amount : -t.amount) : t.isRefund ? -t.amount : t.amount;
export const cashValue = t => (t.type === 'expense' || t.type === 'saving' ? -1 : 1) * transactionValue(t);
export const categoryOf = (id, list = categories) => id === 'transfer' ? transferCategory : list.find(c => c.id === id) || { id, name: '미분류', color: '#8e8e93' };
export function transferSummary(items) {
  const transfers = items.filter(t => t.type === 'transfer' || (t.type === 'expense' && t.importSource?.type === '이체'));
  const isIncoming = t => t.type === 'transfer' ? t.transferDirection === 'in' : t.isRefund;
  const incoming = transfers.filter(isIncoming).reduce((sum, t) => sum + t.amount, 0);
  const outgoing = transfers.filter(t => !isIncoming(t)).reduce((sum, t) => sum + t.amount, 0);
  return { incoming, outgoing, balance: incoming - outgoing, count: transfers.length };
}
export const shiftMonth = (month, delta) => format(subMonths(parseISO(`${month}-01`), -delta), 'yyyy-MM');
export const monthLabel = month => `${Number(month.slice(0, 4))}년 ${Number(month.slice(5))}월`;
export function summary(transactions, month) {
  const items = transactions.filter(t => t.date.startsWith(month));
  const income = items.filter(t => t.type === 'income').reduce((s, t) => s + transactionValue(t), 0);
  const expense = items.filter(t => t.type === 'expense').reduce((s, t) => s + transactionValue(t), 0);
  const saving = items.filter(t => t.type === 'saving').reduce((s, t) => s + transactionValue(t), 0);
  const balance = income - expense - saving;
  return { items, income, expense, saving, balance, rate: income ? balance / income * 100 : null };
}
export function trends(transactions, month) {
  return Array.from({ length: 6 }, (_, i) => {
    const key = shiftMonth(month, i - 5);
    const { income, expense, saving, balance } = summary(transactions, key);
    return { key, name: `${Number(key.slice(5))}월`, income, expense, saving, balance };
  });
}
export function categoryTotals(items, list = categories) {
  return list.filter(c => c.type === 'expense')
    .map(c => ({ ...c, value: items.filter(t => t.type === 'expense' && t.category === c.id).reduce((s, t) => s + transactionValue(t), 0) }))
    .filter(c => c.value !== 0).sort((a, b) => b.value - a.value);
}
export function makeDemo(month) {
  const transactions = [];
  const budgets = {};
  const fixedExpenses = [];
  const add = (m, day, type, amount, title, category, method = '신용카드') => transactions.push({
    id: crypto.randomUUID(), type, amount, title, category, method, note: '',
    date: `${m}-${String(Math.min(day, getDaysInMonth(parseISO(`${m}-01`)))).padStart(2, '0')}`,
  });
  for (let i = 5; i >= 0; i--) {
    const m = shiftMonth(month, -i);
    budgets[m] = 2500000;
    add(m, 1, 'income', 3500000, '월급', 'salary', '계좌이체');
    add(m, 12, 'income', 250000 + i * 30000, '상여금', 'side', '계좌이체');
    add(m, 15, 'saving', 400000 + i * 20000, '정기 적금', 'other', '계좌이체');
    add(m, 5, 'expense', 650000, '월세', 'home', '계좌이체');
    add(m, 10, 'expense', 65000, '통신 요금', 'home');
    for (const [title, amount, day, category] of [['월세', 650000, 5, 'home'], ['통신 요금', 65000, 10, 'home'], ['보험료', 120000, 25, categories.find(c => c.type === 'expense' && c.name === '보험')?.id || 'other']]) {
      const f = { id: crypto.randomUUID(), month: m, title, amount, day, category, method: '계좌이체', note: '' };
      fixedExpenses.push(f);
      const transaction = transactions.find(t => t.date.startsWith(m) && t.title === title);
      if (transaction) transaction.fixedExpenseId = f.id;
    }
    add(m, 15, 'expense', 68000, '대중교통', 'transport', '체크카드');
    add(m, 17, 'expense', 89000 + i * 15000, '생활용품', 'food');
    add(m, 18, 'expense', 29000, '용돈 지급', 'culture');
    add(m, 19, 'expense', 45000, '진료비', 'health');
    for (let day = 2; day <= 20; day += 2) {
      add(m, day, 'expense', 18000 + ((day + i) % 5) * 9000, ['친구와 저녁', '동네 마트', '따뜻한 점심'][day % 3], 'food');
      add(m, day, 'expense', 4500 + (day % 3) * 1500, '오후의 커피', 'cafe');
    }
  }
  return { transactions, budgets, fixedExpenses, categories: categories.map(c => ({ ...c })), categoryBudgets: {}, assets: makeAssetDemo(`${month}-20`) };
}
