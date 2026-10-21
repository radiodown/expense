import test from 'node:test';
import assert from 'node:assert/strict';
import { assetSchema, assetSummary, maturityEstimate, makeAssetDemo } from '../shared/assets.js';
import { backupSchema, categories } from '../shared/ledger.js';

const base = { name: 'Deposit', kind: 'deposit', balance: 1000000, asOf: '2026-10-20', policy: { taxMode: 'standard' }, maturity: { startDate: '2026-10-20', months: 12, principal: 1000000, annualRate: 3 } };
const asset = patch => assetSchema.parse({ ...base, ...patch });

test('asset totals use only current balances and subtract loans without adding maturity proceeds or grants', () => {
  const items = [asset({ policy: { taxMode: 'exempt', grant: 500000 } }),
    asset({ kind: 'installment', balance: 200000, maturity: { startDate: '2026-10-20', months: 12, monthlyPayment: 100000, annualRate: 5 } }),
    asset({ kind: 'stock', balance: 500000, accountType: 'isa', maturity: null }),
    asset({ kind: 'bitcoin', balance: 300000, maturity: null }),
    asset({ kind: 'loan', balance: 700000, maturity: null })];
  const original = structuredClone(items);
  assert.deepEqual(assetSummary(items), { total: 2000000, debt: 700000, net: 1300000, deposits: 1200000 });
  assert.deepEqual(assetSummary([items.at(-1)]), { total: 0, debt: 700000, net: -700000, deposits: 0 });
  assert.deepEqual(assetSummary([]), { total: 0, debt: 0, net: 0, deposits: 0 });
  assert.deepEqual(items, original);
});

test('deposit simple interest applies general tax and clamps a month-end maturity date', () => {
  const result = maturityEstimate(asset({ maturity: { startDate: '2024-01-31', months: 1, principal: 1200000, annualRate: 3 } }));
  assert.equal(result.dueDate, '2024-02-29');
  assert.equal(result.interest, 3000);
  assert.equal(result.tax, 462);
  assert.equal(result.net, 1202538);
});

test('installment savings weight each monthly payment and apply product allowances, custom tax and net grants', () => {
  const saving = asset({ kind: 'installment', policy: { taxMode: 'custom', taxRate: 9.9, taxFreeAllowance: 10000, grant: 50000 }, maturity: { startDate: '2026-10-20', months: 12, monthlyPayment: 100000, annualRate: 6 } });
  const result = maturityEstimate(saving);
  assert.equal(result.principal, 1200000);
  assert.equal(result.interest, 39000);
  assert.equal(result.tax, 2871);
  assert.equal(result.net, 1286129);
  const exempt = maturityEstimate(asset({ ...saving, policy: { taxMode: 'exempt', grant: 50000 } }));
  assert.equal(exempt.tax, 0);
  assert.equal(exempt.net, 1289000);
  const fullAllowance = maturityEstimate(asset({ ...saving, policy: { taxMode: 'custom', taxRate: 9.9, taxFreeAllowance: 999999 } }));
  assert.equal(fullAllowance.tax, 0);
});

test('monthly compounding works for deposits and installment savings, including zero interest', () => {
  const term = { startDate: '2026-10-20', months: 2, annualRate: 12, interestMethod: 'monthlyCompound', principal: 100000, monthlyPayment: 100000 };
  assert.equal(maturityEstimate(asset({ maturity: term })).interest, 2010);
  assert.equal(maturityEstimate(asset({ kind: 'installment', maturity: term })).interest, 3010);
  assert.equal(maturityEstimate(asset({ kind: 'installment', maturity: { ...term, annualRate: 0 } })).net, 200000);
});

test('deferred and unspecified tax never claim an after-tax maturity amount; direct input preserves a zero amount', () => {
  for (const accountType of ['isa', 'isaLowIncome', 'isaFarmer', 'irp', 'pension']) {
    const result = maturityEstimate(asset({ accountType, policy: { taxMode: 'deferred' } }));
    assert.equal(result.interest, 30000);
    assert.equal(result.tax, null);
    assert.equal(result.net, null);
  }
  assert.equal(maturityEstimate(asset({ policy: {} })).net, null);
  const manual = asset({ policy: { taxMode: 'deferred', grant: 999999 }, maturity: { ...base.maturity, mode: 'manual', manualAmount: 0 } });
  assert.equal(maturityEstimate(manual).net, 0);
  assert.equal(maturityEstimate(manual).grant, null, 'manual total already includes all benefits');
});

test('asset validation rejects corrupt balances, policy URLs and unbounded projections without throwing', () => {
  const invalid = [{ balance: -1 }, { balance: 1.5 }, { name: ' ' }, { kind: 'unknown' }, { accountType: 'unknown' }, { asOf: '2026-02-30' },
    { policy: { taxRate: 101 } }, { policy: { taxFreeAllowance: -1 } }, { policy: { sourceUrl: 'javascript:alert(1)' } },
    { maturity: null }, { kind: 'stock' }, { maturity: { ...base.maturity, startDate: '2026-02-30' } },
    { maturity: { ...base.maturity, months: 1e12 } }, { maturity: { ...base.maturity, annualRate: 101 } },
    { maturity: { ...base.maturity, mode: 'manual' } }, { maturity: { ...base.maturity, principal: 0 } },
    { maturity: { ...base.maturity, months: 600, annualRate: 100, interestMethod: 'monthlyCompound' } }];
  for (const patch of invalid) assert.equal(assetSchema.safeParse({ ...base, ...patch }).success, false, JSON.stringify(patch));
  assert.ok(assetSchema.safeParse({ name: 'Empty account', kind: 'cash', balance: 0, asOf: '2026-10-20' }).success);
  assert.ok(makeAssetDemo().every(item => assetSchema.safeParse(item).success));
});

test('v6 backups require assets, preserve product policies and reject duplicate IDs; v1-v5 restore empty assets', () => {
  const items = makeAssetDemo();
  const backup = { version: 6, transactions: [], budgets: {}, fixedExpenses: [], categories, categoryBudgets: {}, assets: items };
  assert.deepEqual(backupSchema.parse(backup).assets, items);
  assert.equal(backupSchema.safeParse({ ...backup, assets: undefined }).success, false);
  assert.equal(backupSchema.safeParse({ ...backup, assets: [items[0], items[0]] }).success, false);
  for (const version of [1, 2, 3, 4, 5]) {
    assert.deepEqual(backupSchema.parse({ ...backup, version, assets: undefined }).assets, []);
    assert.equal(backupSchema.safeParse({ ...backup, version }).success, false);
  }
});
