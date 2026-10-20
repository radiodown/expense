import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readSheet } from 'read-excel-file/node';
import { parseLedgerRows, parseXlsx, describeImport } from '../server/xlsx-import.js';
import { summary, transferSummary, budgetSummary, backupSchema, categories, transactionValue } from '../shared/ledger.js';

const headers = ['날짜', '시간', '타입', '대분류', '소분류', '내용', '금액', '화폐', '결제수단', '메모'];
const row = ['2026-10-02', 0.5, '지출', '점심', '미분류', '식사', -12000, 'KRW', '개인 카드', '원본 메모'];
const fixture = new URL('../sample/2025-10-20~2026-10-20.xlsx', import.meta.url);

test('second-sheet parser preserves dates, time, method, memo and original classifications', () => {
  const parsed = parseLedgerRows([headers, [new Date('2026-10-02T00:00:00Z'), ...row.slice(1)]], 'test.xlsx');
  const t = parsed.records[0].transaction;
  assert.equal(t.date, '2026-10-02');
  assert.equal(t.amount, 12000);
  assert.equal(t.category, 'food');
  assert.equal(t.method, '개인 카드');
  assert.equal(t.note, '원본 메모');
  assert.equal(t.importSource.time, '12:00:00');
  assert.equal(t.importSource.category, '점심');
  assert.equal(t.importSource.row, 2);
  assert.equal(t.importSource.originalAmount, -12000);
});

test('imports recognize the configured defaults without dropping discontinued categories', () => {
  const rows = categories.map(c => ['2026-10-02', 0.5, c.type === 'income' ? '수입' : '지출', c.name, '미분류', '기본 분류', c.type === 'income' ? 1000 : -1000, 'KRW', '현금', '']);
  rows.push(row.map((value, index) => index === 3 ? '쇼핑' : value));
  rows.push(row.map((value, index) => index === 3 ? '고정' : index === 4 ? '보험' : value));
  const parsed = parseLedgerRows([headers, ...rows], 'defaults.xlsx');
  assert.equal(parsed.skipped.length, 0);
  assert.deepEqual(parsed.records.slice(0, categories.length).map(record => record.transaction.category), categories.map(c => c.id));
  assert.equal(parsed.records.at(-2).transaction.category, 'other');
  assert.equal(parsed.records.at(-1).transaction.category, categories.find(c => c.type === 'expense' && c.name === '보험').id);
  assert.equal(parsed.records.at(-2).transaction.importSource.category, '쇼핑');
});
test('unsupported types, zero amounts, other currencies and invalid rows are explicitly excluded', () => {
  const invalid = [
    row.map((v, i) => i === 2 ? '알 수 없음' : v),
    row.map((v, i) => i === 6 ? 0 : v),
    row.map((v, i) => i === 7 ? 'USD' : v),
    row.map((v, i) => i === 0 ? '2026-02-30' : v),
    row.map((v, i) => i === 6 ? null : v),
  ];
  const parsed = parseLedgerRows([headers, ...invalid], 'test.xlsx');
  assert.equal(parsed.records.length, 0);
  assert.equal(parsed.skipped.length, 5);
  assert.ok(parsed.skipped.some(r => r.reason === '지원하지 않는 타입'));
  assert.ok(parsed.skipped.some(r => r.reason === '0원'));
  assert.throws(() => parseLedgerRows([['날짜', '내용']], 'test.xlsx'), /두 번째 시트/);
});
test('transfer rows are imported as expenses with incoming amounts deducted and source metadata retained', () => {
  const outbound = row.map((v, i) => i === 2 ? '이체' : v);
  const inbound = outbound.map((v, i) => i === 6 ? 12000 : i === 8 ? '다른 계좌' : v);
  const parsed = parseLedgerRows([headers, outbound, inbound, outbound.map((v, i) => i === 6 ? 0 : v)], 'transfers.xlsx');
  const transfers = parsed.records.map(r => r.transaction);
  assert.equal(transfers.length, 2);
  assert.equal(transfers[0].isRefund, false);
  assert.equal(transfers[1].isRefund, true);
  assert.ok(transfers.every(t => t.type === 'expense' && t.category === 'food' && t.importSource.type === '이체' && t.transferDirection === null && !t.fixedExpenseId));
  assert.equal(transfers[0].importSource.originalAmount, -12000);
  assert.equal(transfers[1].method, '다른 계좌');
  assert.equal(transfers[1].importSource.row, 3);
  assert.notEqual(transfers[0].importKey, transfers[1].importKey);
  assert.equal(parsed.skipped[0].reason, '0원');
  const preview = describeImport(parsed, new Set());
  assert.equal(preview.months[0].transferCount, 2);
  assert.equal(preview.months[0].transferIn, 12000);
  assert.equal(preview.months[0].transferOut, 12000);
  assert.equal(preview.months[0].income, 0);
  assert.equal(preview.months[0].expenseCount, 2);
  assert.equal(preview.months[0].expense, 0);
  assert.equal(describeImport(parsed, new Set([transfers[0].importKey])).months[0].transferOut, 0);
});
test('refunds reduce expense totals and budget usage; original cash sign is preserved', () => {
  const parsed = parseLedgerRows([headers, row, row.map((v, i) => i === 6 ? 2000 : v)], 'test.xlsx');
  const transactions = parsed.records.map(r => r.transaction);
  assert.equal(transactions[1].isRefund, true);
  assert.equal(transactionValue(transactions[1]), -2000);
  assert.equal(summary(transactions, '2026-10').expense, 10000);
  assert.equal(budgetSummary({ transactions, budgets: { '2026-10': 20000 }, fixedExpenses: [] }, '2026-10').remaining, 10000);
});
test('import identities survive renamed files and shifted rows but preserve repeated identical transactions', () => {
  const a = parseLedgerRows([headers, row, row], 'first.xlsx');
  const b = parseLedgerRows([['파일 제목'], headers, row, row], 'renamed.xlsx');
  assert.notEqual(a.records[0].transaction.importKey, a.records[1].transaction.importKey);
  assert.deepEqual(a.records.map(r => r.transaction.importKey), b.records.map(r => r.transaction.importKey));
  const preview = describeImport(b, new Set([a.records[0].transaction.importKey]));
  assert.equal(preview.months[0].duplicates, 1);
  assert.equal(preview.months[0].available, 1);
});
test('actual sample second sheet matches independent monthly sums, with every row accounted for', { skip: !existsSync(fixture) }, async () => {
  const buffer = readFileSync(fixture);
  const parsed = await parseXlsx(buffer, 'sample.xlsx');
  const raw = await readSheet(buffer, 2);
  assert.equal(parsed.records.length, 1937);
  assert.equal(parsed.records.filter(r => r.transaction.importSource.type === '이체').length, 281);
  assert.ok(parsed.records.every(r => r.transaction.type !== 'transfer'));
  assert.equal(parsed.skipped.length, 23);
  assert.equal(parsed.records.filter(r => r.transaction.isRefund && r.transaction.importSource.type !== '이체').length, 32);
  assert.equal(parsed.months.length, 13);
  const transactions = parsed.records.map(r => r.transaction);
  for (const month of parsed.months) {
    const rows = raw.slice(1).filter(r => r[0].toISOString().startsWith(month));
    const income = rows.filter(r => r[2] === '수입').reduce((s, r) => s + r[6], 0);
    const expense = -rows.filter(r => r[2] === '지출' || r[2] === '이체').reduce((s, r) => s + r[6], 0);
    assert.equal(summary(transactions, month).income, income, `${month} income`);
    assert.equal(summary(transactions, month).expense, expense, `${month} expense`);
    const transfers = transferSummary(transactions.filter(t => t.date.startsWith(month)));
    assert.equal(transfers.incoming, rows.filter(r => r[2] === '이체' && r[6] > 0).reduce((s, r) => s + r[6], 0), `${month} transfer in`);
    assert.equal(transfers.outgoing, rows.filter(r => r[2] === '이체' && r[6] < 0).reduce((s, r) => s - r[6], 0), `${month} transfer out`);
  }
  assert.equal(parsed.records.length + parsed.skipped.length, raw.length - 1);
  assert.ok(backupSchema.safeParse({ version: 4, transactions: transactions.map((t, i) => ({ ...t, id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` })), budgets: {}, fixedExpenses: [], categories, categoryBudgets: {} }).success);
});
