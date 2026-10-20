import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createApp } from '../server/app.js';
import { DatabaseSync } from 'node:sqlite';
import { categories, summary, budgetSummary } from '../shared/ledger.js';

const sample = { type: 'expense', amount: 12000, date: '2026-10-20', title: '점심', category: 'food', method: '체크카드', note: '기록' };
async function setup(t, dbPath = ':memory:') {
  const { app, db } = createApp(dbPath);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    db.close();
  };
  t.after(stop);
  // Use raw HTTP so security-header tests exercise the exact supplied Host/Fetch headers.
  const request = (url, method = 'GET', body, headers = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(base + url, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: res.statusCode === 204 ? null : JSON.parse(text) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { request, stop, db };
}
test('API creates, updates, lists and deletes real SQLite records', async t => {
  const { request } = await setup(t);
  assert.deepEqual((await request('/api/state')).body, { transactions: [], budgets: {}, fixedExpenses: [], categories, categoryBudgets: {} });
  const created = await request('/api/transactions', 'POST', sample);
  assert.equal(created.status, 201);
  assert.equal(created.body.title, '점심');
  const url = `/api/transactions/${created.body.id}`;
  assert.equal((await request(url, 'PUT', { ...sample, amount: 18000 })).status, 200);
  assert.equal((await request('/api/state')).body.transactions[0].amount, 18000);
  assert.equal((await request(url, 'DELETE')).status, 204);
  assert.equal((await request(url, 'DELETE')).status, 404);
  assert.equal((await request(url, 'PUT', sample)).status, 404);
  assert.equal((await request('/api/state')).body.transactions.length, 0);
});
test('invalid requests never add a transaction', async t => {
  const { request } = await setup(t);
  for (const patch of [{ amount: -1 }, { amount: 1.2 }, { date: '2026-02-30' }, { category: 'salary' }, { title: ' ' }]) {
    assert.equal((await request('/api/transactions', 'POST', { ...sample, ...patch })).status, 400);
  }
  assert.equal((await request('/api/state')).body.transactions.length, 0);
  assert.equal((await request('/api/budgets/2026-13', 'PUT', { amount: 10 })).status, 400);
});
test('backup roundtrip restores transactions and budgets; corrupt backup preserves existing data', async t => {
  const { request } = await setup(t);
  await request('/api/transactions', 'POST', sample);
  await request('/api/budgets/2026-10', 'PUT', { amount: 100000 });
  const backup = (await request('/api/backup')).body;
  await request('/api/transactions', 'POST', { ...sample, title: '추가 기록' });
  await request('/api/budgets/2026-10', 'PUT', { amount: 200000 });
  assert.equal((await request('/api/restore', 'POST', { ...backup, transactions: [{ ...backup.transactions[0], amount: -1 }] })).status, 400);
  assert.equal((await request('/api/state')).body.transactions.length, 2);
  assert.equal((await request('/api/restore', 'POST', { ...backup, transactions: [backup.transactions[0], backup.transactions[0]] })).status, 400);
  assert.equal((await request('/api/restore', 'POST', backup)).status, 200);
  const restored = (await request('/api/state')).body;
  assert.equal(restored.transactions.length, 1);
  assert.equal(restored.budgets['2026-10'], 100000);
  assert.equal(restored.transactions[0].id, backup.transactions[0].id);
});
test('records and budgets survive database close and server restart', async t => {
  const file = path.join(tmpdir(), `moa-test-${randomUUID()}.sqlite`);
  const first = await setup(t, file);
  await first.request('/api/transactions', 'POST', sample);
  await first.request('/api/budgets/2026-10', 'PUT', { amount: 300000 });
  await first.request('/api/fixed-expenses', 'POST', { month: '2026-10', title: '보험료', amount: 50000, day: 15, category: 'health', method: '계좌이체' });
  const custom = (await first.request('/api/categories', 'POST', { name: '구독료', type: 'expense' })).body;
  await first.request('/api/budgets/2026-10/categories', 'PUT', { amounts: { [custom.id]: 40000 } });
  await first.request('/api/categories/cafe', 'DELETE');
  await first.stop();
  const second = await setup(t, file);
  const state = (await second.request('/api/state')).body;
  assert.equal(state.transactions[0].title, sample.title);
  assert.equal(state.budgets['2026-10'], 300000);
  assert.equal(state.fixedExpenses[0].title, '보험료');
  assert.equal(state.categoryBudgets['2026-10'][custom.id], 40000);
  assert.ok(state.categories.some(c => c.id === custom.id && c.name === '구독료'));
  assert.ok(!state.categories.some(c => c.id === 'cafe'), 'Deleted default categories must not be reseeded on restart');
  await second.stop();
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(file + suffix)) unlinkSync(file + suffix);
});

const fixedSample = { month: '2026-10', title: '월세', amount: 650000, day: 5, category: 'home', method: '계좌이체', note: '' };
test('fixed plans support CRUD and reject invalid dates and income categories', async t => {
  const { request } = await setup(t);
  for (const patch of [{ day: 0 }, { day: 32 }, { day: 1.5 }, { amount: -1 }, { month: '2026-13' }, { category: 'salary' }]) {
    assert.equal((await request('/api/fixed-expenses', 'POST', { ...fixedSample, ...patch })).status, 400);
  }
  const created = await request('/api/fixed-expenses', 'POST', fixedSample);
  assert.equal(created.status, 201);
  const url = `/api/fixed-expenses/${created.body.id}`;
  assert.equal((await request(url, 'PUT', { ...fixedSample, amount: 700000 })).status, 200);
  assert.equal((await request(url, 'PUT', { ...fixedSample, month: '2026-11' })).status, 400);
  assert.equal((await request('/api/state')).body.fixedExpenses[0].amount, 700000);
  assert.equal((await request(url, 'DELETE')).status, 204);
  assert.equal((await request(url, 'DELETE')).status, 404);
});
test('linked payments reject duplicates and wrong months; deleting a plan keeps the actual payment', async t => {
  const { request } = await setup(t);
  const f = (await request('/api/fixed-expenses', 'POST', fixedSample)).body;
  const payment = { ...sample, category: 'home', amount: 630000, fixedExpenseId: f.id };
  assert.equal((await request('/api/transactions', 'POST', { ...payment, date: '2026-11-05' })).status, 400);
  assert.equal((await request('/api/transactions', 'POST', { ...payment, type: 'income', category: 'salary' })).status, 400);
  const actual = await request('/api/transactions', 'POST', payment);
  assert.equal(actual.status, 201);
  assert.equal((await request('/api/transactions', 'POST', payment)).status, 409);
  assert.equal((await request(`/api/fixed-expenses/${f.id}`, 'PUT', { ...fixedSample, amount: 700000 })).status, 200);
  assert.equal((await request('/api/state')).body.transactions[0].amount, 630000);
  assert.equal((await request(`/api/transactions/${actual.body.id}`, 'PUT', { ...payment, amount: 640000 })).status, 200);
  await request(`/api/fixed-expenses/${f.id}`, 'DELETE');
  const state = (await request('/api/state')).body;
  assert.equal(state.fixedExpenses.length, 0);
  assert.equal(state.transactions[0].amount, 640000);
  assert.equal(state.transactions[0].fixedExpenseId, null);
});
test('deleting an actual payment allows recording the fixed expense again', async t => {
  const { request } = await setup(t);
  const f = (await request('/api/fixed-expenses', 'POST', fixedSample)).body;
  const payment = { ...sample, fixedExpenseId: f.id };
  const tx = (await request('/api/transactions', 'POST', payment)).body;
  await request(`/api/transactions/${tx.id}`, 'DELETE');
  assert.equal((await request('/api/transactions', 'POST', payment)).status, 201);
  assert.equal((await request('/api/state')).body.fixedExpenses.length, 1);
});
test('previous month copy has fresh IDs, no actual payments and refuses duplicate copying', async t => {
  const { request } = await setup(t);
  const f = (await request('/api/fixed-expenses', 'POST', fixedSample)).body;
  await request('/api/transactions', 'POST', { ...sample, fixedExpenseId: f.id });
  assert.equal((await request('/api/budgets/2026-11/copy-fixed', 'POST', {})).status, 201);
  assert.equal((await request('/api/budgets/2026-11/copy-fixed', 'POST', {})).status, 409);
  assert.equal((await request('/api/budgets/2026-09/copy-fixed', 'POST', {})).status, 404);
  const state = (await request('/api/state')).body;
  const next = state.fixedExpenses.find(item => item.month === '2026-11');
  assert.notEqual(next.id, f.id);
  assert.equal(next.amount, f.amount);
  assert.equal(state.transactions.length, 1);
});
test('current backup preserves payment links and rejects corrupt references; v1 remains supported', async t => {
  const { request } = await setup(t);
  const f = (await request('/api/fixed-expenses', 'POST', fixedSample)).body;
  await request('/api/transactions', 'POST', { ...sample, fixedExpenseId: f.id });
  const backup = (await request('/api/backup')).body;
  assert.equal(backup.version, 5);
  assert.equal((await request('/api/restore', 'POST', { ...backup, fixedExpenses: [] })).status, 400);
  assert.equal((await request('/api/restore', 'POST', { ...backup, fixedExpenses: undefined })).status, 400);
  assert.equal((await request('/api/restore', 'POST', { ...backup, transactions: [...backup.transactions, { ...backup.transactions[0], id: randomUUID() }] })).status, 400);
  assert.equal((await request('/api/restore', 'POST', backup)).status, 200);
  const restored = (await request('/api/state')).body;
  assert.equal(restored.transactions[0].fixedExpenseId, restored.fixedExpenses[0].id);
  const legacy = { version: 1, transactions: [{ ...sample, id: randomUUID() }], budgets: { '2026-10': 1000000 } };
  assert.equal((await request('/api/restore', 'POST', legacy)).status, 200);
  const legacyState = (await request('/api/state')).body;
  assert.equal(legacyState.transactions[0].fixedExpenseId, null);
  assert.equal(legacyState.fixedExpenses.length, 0);
  assert.equal(legacyState.budgets['2026-10'], 1000000);
});
test('legacy SQLite migration preserves existing transactions and budget', async t => {
  const file = path.join(tmpdir(), `moa-migration-${randomUUID()}.sqlite`);
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE transactions (id TEXT PRIMARY KEY,type TEXT,amount INTEGER,date TEXT,title TEXT,category TEXT,method TEXT,note TEXT);
    CREATE TABLE budgets (month TEXT PRIMARY KEY,amount INTEGER);
    INSERT INTO transactions VALUES ('legacy','expense',12345,'2026-10-10','기존 내역','shopping','현금','');
    INSERT INTO budgets VALUES ('2026-10',100000);`);
  old.close();
  const migrated = await setup(t, file);
  const state = (await migrated.request('/api/state')).body;
  assert.equal(state.transactions[0].amount, 12345);
  assert.equal(state.transactions[0].fixedExpenseId, null);
  assert.equal(state.transactions[0].category, 'shopping');
  assert.ok(state.categories.some(c => c.id === 'shopping' && c.type === 'expense'));
  assert.equal(state.budgets['2026-10'], 100000);
  assert.deepEqual(state.fixedExpenses, []);
  await migrated.stop();
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(file + suffix)) unlinkSync(file + suffix);
});
test('local server refuses cross-site requests, remote hosts and unsafe content types', async t => {
  const { request } = await setup(t);
  assert.equal((await request('/api/state', 'GET', undefined, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await request('/api/state', 'GET', undefined, { Host: 'attacker.example' })).status, 403);
  assert.equal((await request('/api/transactions', 'POST', sample, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await request('/api/transactions', 'POST', sample, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await request('/api/state', 'GET', undefined, { Origin: 'http://localhost:4173' })).status, 200);
});

const sampleWorkbook = new URL('../sample/2025-10-20~2026-10-20.xlsx', import.meta.url);
test('XLSX import saves only multiple selected months and is repeatable without duplicates', { skip: !existsSync(sampleWorkbook) }, async t => {
  const { request } = await setup(t);
  const fileName = '2025-10-20~2026-10-20.xlsx';
  const listed = await request('/api/imports/files');
  assert.ok(listed.body.files.includes(fileName));
  assert.equal((await request('/api/imports/preview', 'POST', { fileName: '../package.xlsx' })).status, 404);
  const preview = await request('/api/imports/preview', 'POST', { fileName });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.sheet, 2);
  assert.equal((await request('/api/state')).body.transactions.length, 0, 'Preview must not write records');
  assert.equal((await request('/api/imports/commit', 'POST', { previewId: preview.body.previewId, months: [] })).status, 400);
  assert.equal((await request('/api/imports/commit', 'POST', { previewId: preview.body.previewId, months: ['2020-01'] })).status, 400);
  const months = ['2026-08', '2026-10'];
  const expected = preview.body.records.filter(r => months.includes(r.month)).length;
  const commit = await request('/api/imports/commit', 'POST', { previewId: preview.body.previewId, months });
  assert.equal(commit.status, 200);
  assert.equal(commit.body.imported, expected);
  const state = (await request('/api/state')).body;
  assert.ok(state.transactions.every(t => months.includes(t.date.slice(0, 7))));
  assert.equal(state.transactions.length, expected);
  assert.ok(state.transactions.some(t => t.isRefund));
  assert.deepEqual(state.fixedExpenses, [], 'Actual imports must not invent budget plans');
  const repeat = await request('/api/imports/commit', 'POST', { previewId: preview.body.previewId, months });
  assert.equal(repeat.body.imported, 0);
  assert.equal(repeat.body.duplicates, expected);
  const tx = state.transactions[0];
  await request(`/api/transactions/${tx.id}`, 'PUT', { ...tx, title: '사용자 수정 내역' });
  const renamed = await request('/api/imports/preview', 'POST', { fileName: 'renamed.xlsx', content: readFileSync(sampleWorkbook).toString('base64') });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.months.filter(m => months.includes(m.month)).reduce((s, m) => s + m.duplicates, 0), expected);
  assert.ok(renamed.body.months.some(m => !months.includes(m.month) && m.available > 0));
  const backup = (await request('/api/backup')).body;
  assert.equal((await request('/api/restore', 'POST', backup)).status, 200);
  assert.equal((await request('/api/imports/commit', 'POST', { previewId: renamed.body.previewId, months })).body.imported, 0);
});
test('XLSX import transaction rolls back the whole selection on a storage failure', { skip: !existsSync(sampleWorkbook) }, async t => {
  t.mock.method(console, 'error', () => {});
  const { request, db } = await setup(t);
  await request('/api/transactions', 'POST', sample);
  const preview = (await request('/api/imports/preview', 'POST', { fileName: '2025-10-20~2026-10-20.xlsx' })).body;
  db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON transactions WHEN NEW.date LIKE '2026-09%' BEGIN SELECT RAISE(ABORT, 'test rollback'); END;");
  const result = await request('/api/imports/commit', 'POST', { previewId: preview.previewId, months: ['2026-10', '2026-09'] });
  assert.equal(result.status, 500);
  assert.equal((await request('/api/state')).body.transactions.length, 1);
  db.exec('DROP TRIGGER fail_import');
});

test('editable categories validate references and preserve linked records when renamed or deleted', async t => {
  const { request } = await setup(t);
  const created = await request('/api/categories', 'POST', { name: '보험료', type: 'expense' });
  assert.equal(created.status, 201);
  const c = created.body;
  assert.equal((await request('/api/categories', 'POST', { name: ' 보험료 ', type: 'expense' })).status, 409);
  assert.equal((await request('/api/categories', 'POST', { name: ' ', type: 'income' })).status, 400);
  const tx = await request('/api/transactions', 'POST', { ...sample, category: c.id });
  assert.equal(tx.status, 201);
  assert.equal((await request('/api/transactions', 'POST', { ...sample, type: 'income', category: c.id })).status, 400);
  const f = await request('/api/fixed-expenses', 'POST', { ...fixedSample, category: c.id });
  assert.equal(f.status, 201);
  assert.equal((await request(`/api/categories/${c.id}`, 'PUT', { ...c, name: '테스트 보험', type: 'income' })).status, 400);
  assert.equal((await request(`/api/categories/${c.id}`, 'PUT', { ...c, name: '테스트 보험' })).status, 200);
  assert.equal((await request('/api/state')).body.categories.find(item => item.id === c.id).name, '테스트 보험');
  await request('/api/budgets/2026-10/categories', 'PUT', { amounts: { [c.id]: 60000, other: 10000 } });
  await request('/api/budgets/2026-11/categories', 'PUT', { amounts: { [c.id]: 30000 } });
  assert.equal((await request(`/api/categories/${c.id}`, 'DELETE')).status, 204);
  const state = (await request('/api/state')).body;
  assert.equal(state.transactions[0].category, 'other');
  assert.equal(state.transactions[0].amount, sample.amount);
  assert.equal(state.fixedExpenses[0].category, 'other');
  assert.deepEqual(state.categoryBudgets, { '2026-10': { other: 70000 }, '2026-11': { other: 30000 } });
  assert.equal((await request('/api/categories/other', 'DELETE')).status, 400);
  assert.equal((await request('/api/categories/income-other', 'DELETE')).status, 400);
  assert.equal((await request('/api/transactions', 'POST', { ...sample, category: c.id })).status, 400);
  assert.equal((await request('/api/categories/missing', 'DELETE')).status, 404);
});

test('category budgets isolate months, allow explicit zero and validate before replacing saved limits', async t => {
  const { request } = await setup(t);
  const url = '/api/budgets/2026-10/categories';
  assert.equal((await request(url, 'PUT', { amounts: { food: 150000, cafe: 0 } })).status, 200);
  assert.equal((await request('/api/budgets/2026-11/categories', 'PUT', { amounts: { food: 250000 } })).status, 200);
  for (const amounts of [{ food: -1 }, { food: 1.5 }, { salary: 100 }, { unknown: 10 }, { food: 999999999999, cafe: 1 }]) {
    assert.equal((await request(url, 'PUT', { amounts })).status, 400);
  }
  assert.equal((await request('/api/budgets/invalid/categories', 'PUT', {})).status, 400);
  const state = (await request('/api/state')).body;
  assert.deepEqual(state.categoryBudgets['2026-10'], { food: 150000, cafe: 0 });
  assert.deepEqual(state.budgets, {}, 'Category allocations must not silently overwrite monthly total limits');
  assert.equal((await request(url, 'PUT', { amounts: {} })).status, 200);
  assert.deepEqual((await request('/api/state')).body.categoryBudgets, { '2026-11': { food: 250000 } });
});

test('existing expense becomes a paid fixed plan once without duplicating actual expenses', async t => {
  const { request } = await setup(t);
  const c = (await request('/api/categories', 'POST', { name: '테스트 구독', type: 'expense' })).body;
  const tx = (await request('/api/transactions', 'POST', { ...sample, category: c.id, method: '내 카드 1234', date: '2026-10-31', importKey: 'a'.repeat(64) })).body;
  const url = `/api/transactions/${tx.id}/fixed-expense`;
  const conversion = await request(url, 'POST', {});
  assert.equal(conversion.status, 201);
  assert.equal(conversion.body.day, 31);
  assert.equal(conversion.body.month, '2026-10');
  assert.equal(conversion.body.method, '내 카드 1234');
  assert.equal(conversion.body.category, c.id);
  assert.equal((await request(url, 'POST', {})).status, 409);
  const state = (await request('/api/state')).body;
  assert.equal(state.transactions.length, 1);
  assert.equal(state.transactions[0].id, tx.id);
  assert.equal(state.transactions[0].importKey, tx.importKey);
  assert.equal(state.transactions[0].fixedExpenseId, conversion.body.id);
  assert.equal(state.fixedExpenses.length, 1);
  await request('/api/budgets/2026-11/copy-fixed', 'POST', {});
  const next = (await request('/api/state')).body;
  assert.equal(next.fixedExpenses.length, 2);
  assert.equal(next.transactions.length, 1);
  for (const patch of [{ type: 'income', category: 'salary' }, { isRefund: true }]) {
    const invalid = (await request('/api/transactions', 'POST', { ...sample, ...patch })).body;
    assert.equal((await request(`/api/transactions/${invalid.id}/fixed-expense`, 'POST', {})).status, 400);
  }
  assert.equal((await request('/api/transactions/missing/fixed-expense', 'POST', {})).status, 404);
});

test('converting an expense and deleting a category roll back completely on storage failure', async t => {
  t.mock.method(console, 'error', () => {});
  const { request, db } = await setup(t);
  const tx = (await request('/api/transactions', 'POST', sample)).body;
  db.exec("CREATE TRIGGER fail_link BEFORE UPDATE OF fixedExpenseId ON transactions BEGIN SELECT RAISE(ABORT, 'test rollback'); END;");
  assert.equal((await request(`/api/transactions/${tx.id}/fixed-expense`, 'POST', {})).status, 500);
  let state = (await request('/api/state')).body;
  assert.equal(state.fixedExpenses.length, 0);
  assert.equal(state.transactions[0].fixedExpenseId, null);
  db.exec('DROP TRIGGER fail_link');
  db.exec("CREATE TRIGGER fail_category_delete BEFORE DELETE ON categories BEGIN SELECT RAISE(ABORT, 'test rollback'); END;");
  await request('/api/budgets/2026-10/categories', 'PUT', { amounts: { food: 100 } });
  assert.equal((await request('/api/categories/food', 'DELETE')).status, 500);
  state = (await request('/api/state')).body;
  assert.equal(state.transactions[0].category, 'food');
  assert.deepEqual(state.categoryBudgets['2026-10'], { food: 100 });
  assert.ok(state.categories.some(c => c.id === 'food'));
});

test('current backup restores custom categories and budgets; invalid references leave current data intact; v2/v3 are supported', async t => {
  const { request } = await setup(t);
  const c = (await request('/api/categories', 'POST', { name: '용돈', type: 'income' })).body;
  const tx = (await request('/api/transactions', 'POST', { ...sample, type: 'income', category: c.id })).body;
  await request('/api/categories/cafe', 'DELETE');
  await request('/api/budgets/2026-10/categories', 'PUT', { amounts: { food: 100000, other: 0 } });
  const backup = (await request('/api/backup')).body;
  assert.equal((await request('/api/restore', 'POST', { ...backup, categories: backup.categories.filter(item => item.id !== c.id) })).status, 400);
  assert.equal((await request('/api/restore', 'POST', { ...backup, categoryBudgets: { '2026-10': { [c.id]: 200 } } })).status, 400);
  assert.equal((await request('/api/restore', 'POST', { ...backup, categories: [...backup.categories, backup.categories[0]] })).status, 400);
  assert.equal((await request('/api/state')).body.transactions[0].category, c.id);
  await request(`/api/categories/${c.id}`, 'DELETE');
  assert.equal((await request('/api/state')).body.transactions[0].category, 'income-other');
  assert.equal((await request('/api/restore', 'POST', backup)).status, 200);
  assert.equal((await request('/api/restore', 'POST', { ...backup, version: 3 })).status, 200);
  const state = (await request('/api/state')).body;
  assert.deepEqual(state.categories, backup.categories);
  assert.deepEqual(state.categoryBudgets, backup.categoryBudgets);
  assert.equal(state.transactions[0].category, c.id);
  const legacy = { version: 2, transactions: [{ ...sample, id: tx.id }], fixedExpenses: [], budgets: {} };
  assert.equal((await request('/api/restore', 'POST', legacy)).status, 200);
  const restored = (await request('/api/state')).body;
  assert.ok(restored.categories.some(item => item.id === 'cafe'));
  assert.deepEqual(restored.categoryBudgets, {});
});

test('XLSX import remains valid when a mapped category is deleted before or after preview', { skip: !existsSync(sampleWorkbook) }, async t => {
  const { request } = await setup(t);
  await request('/api/categories/food', 'DELETE');
  const preview = (await request('/api/imports/preview', 'POST', { fileName: '2025-10-20~2026-10-20.xlsx' })).body;
  assert.ok(!preview.records.some(r => r.transaction.category === 'food'));
  await request('/api/categories/home', 'DELETE');
  assert.equal((await request('/api/imports/commit', 'POST', { previewId: preview.previewId, months: ['2026-10'] })).status, 200);
  const state = (await request('/api/state')).body;
  assert.ok(state.transactions.every(t => t.type === 'transfer' ? t.category === 'transfer' : state.categories.some(c => c.id === t.category && c.type === t.type)));
  assert.ok(state.transactions.some(t => t.category === 'other'));
  const backup = (await request('/api/backup')).body;
  assert.equal((await request('/api/restore', 'POST', backup)).status, 200);
});
test('XLSX endpoints reject malformed files and unknown previews without changing the ledger', async t => {
  const { request } = await setup(t);
  assert.equal((await request('/api/imports/preview', 'POST', { fileName: 'bad.xlsx', content: 'not-base64!' })).status, 400);
  assert.equal((await request('/api/imports/preview', 'POST', { fileName: 'bad.xlsx', content: Buffer.from('not a workbook').toString('base64') })).status, 400);
  assert.equal((await request('/api/imports/commit', 'POST', { previewId: randomUUID(), months: ['2026-10'] })).status, 410);
  assert.equal((await request('/api/state')).body.transactions.length, 0);
});

test('legacy transfer requests become expenses and retain their signed cash value through backup', async t => {
  const { request } = await setup(t);
  const transfer = { ...sample, type: 'transfer', category: 'transfer', transferDirection: 'out', method: '원본 계좌' };
  const created = await request('/api/transactions', 'POST', transfer);
  assert.equal(created.status, 201);
  assert.equal(created.body.type, 'expense');
  assert.equal(created.body.isRefund, false);
  const url = `/api/transactions/${created.body.id}`;
  assert.equal((await request(url, 'PUT', { ...transfer, transferDirection: 'in' })).status, 200);
  assert.equal((await request(`${url}/fixed-expense`, 'POST', {})).status, 400);
  for (const patch of [{ transferDirection: null }, { isRefund: true }, { category: 'food' }, { fixedExpenseId: randomUUID() }]) {
    assert.equal((await request('/api/transactions', 'POST', { ...transfer, ...patch })).status, 400);
  }
  const backup = (await request('/api/backup')).body;
  assert.equal(backup.version, 5);
  assert.equal(backup.transactions[0].type, 'expense');
  assert.equal(backup.transactions[0].isRefund, true);
  assert.equal(backup.transactions[0].transferDirection, null);
  assert.equal((await request('/api/restore', 'POST', { ...backup, transactions: [{ ...backup.transactions[0], transferDirection: 'in' }] })).status, 400);
  assert.equal((await request('/api/restore', 'POST', { ...backup, version: 3 })).status, 200);
  assert.equal((await request(url, 'DELETE')).status, 204);
  assert.equal((await request('/api/restore', 'POST', backup)).status, 200);
  const restored = (await request('/api/state')).body;
  assert.equal(restored.transactions[0].isRefund, true);
  assert.equal(restored.transactions[0].transferDirection, null);
  assert.equal(restored.transactions[0].method, '원본 계좌');
  assert.equal(summary(restored.transactions, '2026-10').balance, sample.amount);
});

test('reimporting a previously imported workbook adds only missing transfers in selected months', { skip: !existsSync(sampleWorkbook) }, async t => {
  const { request } = await setup(t);
  const preview = (await request('/api/imports/preview', 'POST', { fileName: '2025-10-20~2026-10-20.xlsx' })).body;
  const months = ['2026-08', '2026-10'];
  const selected = preview.records.filter(r => months.includes(r.month)).map(r => r.transaction);
  const legacyTransactions = selected.filter(t => t.importSource?.type !== '이체').map(t => ({ ...t, id: randomUUID() }));
  const legacy = { version: 3, transactions: legacyTransactions, fixedExpenses: [], budgets: { '2026-10': 100000 }, categoryBudgets: { '2026-10': { food: 50000 } }, categories };
  assert.equal((await request('/api/restore', 'POST', legacy)).status, 200);
  const newPreview = (await request('/api/imports/preview', 'POST', { fileName: '2025-10-20~2026-10-20.xlsx' })).body;
  const expected = selected.filter(t => t.importSource?.type === '이체').length;
  assert.ok(expected > 0);
  for (const m of newPreview.months.filter(m => months.includes(m.month))) {
    assert.equal(m.incomeCount, 0);
    assert.equal(m.expenseCount, m.transferCount);
    assert.equal(m.available, m.transferCount);
  }
  const result = await request('/api/imports/commit', 'POST', { previewId: newPreview.previewId, months });
  assert.equal(result.status, 200);
  assert.equal(result.body.imported, expected);
  assert.equal(result.body.transfer, expected);
  assert.equal(result.body.income, 0);
  assert.equal(result.body.expense, expected);
  assert.equal(result.body.duplicates, legacyTransactions.length);
  const state = (await request('/api/state')).body;
  assert.equal(state.transactions.length, selected.length);
  assert.ok(state.transactions.every(t => months.includes(t.date.slice(0, 7))));
  for (const m of months) {
    assert.equal(summary(state.transactions, m).income, summary(legacyTransactions, m).income);
    assert.equal(summary(state.transactions, m).expense, summary(selected, m).expense);
  }
  assert.equal(budgetSummary(state, '2026-10').remaining, 100000 - summary(selected, '2026-10').expense);
  assert.deepEqual(state.categoryBudgets, legacy.categoryBudgets);
  assert.equal((await request('/api/imports/commit', 'POST', { previewId: newPreview.previewId, months })).body.imported, 0);
  assert.equal((await request('/api/restore', 'POST', (await request('/api/backup')).body)).status, 200);
});

test('transfer schema migration preserves IDs, import metadata, payment links and custom budgets across restart', async t => {
  const file = path.join(tmpdir(), `moa-transfer-migration-${randomUUID()}.sqlite`);
  const first = await setup(t, file);
  const c = (await first.request('/api/categories', 'POST', { name: '테스트 구독', type: 'expense' })).body;
  const f = (await first.request('/api/fixed-expenses', 'POST', { ...fixedSample, category: c.id })).body;
  await first.request('/api/transactions', 'POST', { ...sample, category: c.id, fixedExpenseId: f.id, importKey: 'c'.repeat(64),
    importSource: { fileName: 'old.xlsx', sheet: 2, row: 9, category: '구독', subcategory: '', time: '12:00:00', originalAmount: -sample.amount } });
  await first.request('/api/budgets/2026-10/categories', 'PUT', { amounts: { [c.id]: 50000 } });
  const before = (await first.request('/api/state')).body;
  await first.stop();
  const old = new DatabaseSync(file);
  old.exec(`ALTER TABLE transactions RENAME TO transactions_current;
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,type TEXT NOT NULL CHECK(type IN ('income','expense')),amount INTEGER NOT NULL CHECK(amount > 0),
      date TEXT NOT NULL,title TEXT NOT NULL,category TEXT NOT NULL,method TEXT NOT NULL,note TEXT NOT NULL,
      fixedExpenseId TEXT,isRefund INTEGER NOT NULL DEFAULT 0,importKey TEXT,importSource TEXT);
    INSERT INTO transactions SELECT id,type,amount,date,title,category,method,note,fixedExpenseId,isRefund,importKey,importSource FROM transactions_current;
    DROP TABLE transactions_current;
    CREATE INDEX transaction_date ON transactions(date);
    CREATE UNIQUE INDEX fixed_payment ON transactions(fixedExpenseId) WHERE fixedExpenseId IS NOT NULL;
    CREATE UNIQUE INDEX imported_record ON transactions(importKey) WHERE importKey IS NOT NULL;`);
  old.close();
  const migrated = await setup(t, file);
  assert.deepEqual((await migrated.request('/api/state')).body, before);
  assert.equal((await migrated.request('/api/transactions', 'POST', { ...sample, type: 'transfer', category: 'transfer', transferDirection: 'out' })).status, 201);
  const indexes = migrated.db.prepare('PRAGMA index_list(transactions)').all().map(i => i.name);
  assert.ok(indexes.includes('fixed_payment') && indexes.includes('imported_record') && indexes.includes('transaction_date'));
  await migrated.stop();
  const restarted = await setup(t, file);
  assert.equal((await restarted.request('/api/state')).body.transactions.find(t => t.category === 'other').type, 'expense');
  await restarted.stop();
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(file + suffix)) unlinkSync(file + suffix);
});

test('moving expenses to savings preserves source data, avoids duplicates and can be reversed', async t => {
  const { request } = await setup(t);
  const original = { ...sample, title: '정기 적금', importKey: 'd'.repeat(64), importSource: { fileName: 'original.xlsx', sheet: 2, row: 7, category: '고정', subcategory: '적금', time: '12:00:00', originalAmount: -sample.amount } };
  const expense = (await request('/api/transactions', 'POST', original)).body;
  await request('/api/budgets/2026-10', 'PUT', { amount: 100000 });
  const before = (await request('/api/state')).body;
  const moveUrl = `/api/transactions/${expense.id}/move`;
  assert.equal((await request(moveUrl, 'POST', { type: 'saving' })).status, 200);
  assert.equal((await request(moveUrl, 'POST', { type: 'saving' })).status, 409);
  let state = (await request('/api/state')).body;
  assert.equal(state.transactions.length, 1);
  assert.deepEqual(state.transactions[0], { ...before.transactions[0], type: 'saving' });
  assert.equal(summary(state.transactions, '2026-10').saving, sample.amount);
  assert.equal(summary(state.transactions, '2026-10').expense, 0);
  assert.equal(summary(state.transactions, '2026-10').balance, summary(before.transactions, '2026-10').balance);
  assert.equal(budgetSummary(state, '2026-10').remaining, 100000);
  const backup = (await request('/api/backup')).body;
  assert.equal(backup.version, 5);
  assert.equal((await request('/api/restore', 'POST', { ...backup, version: 4 })).status, 400);
  assert.equal((await request('/api/restore', 'POST', backup)).status, 200);
  assert.equal((await request(moveUrl, 'POST', { type: 'expense' })).status, 200);
  state = (await request('/api/state')).body;
  assert.deepEqual(state.transactions, before.transactions);
  assert.equal((await request(moveUrl, 'POST', { type: 'income' })).status, 400);
  assert.equal((await request('/api/transactions/missing/move', 'POST', { type: 'saving' })).status, 404);
  const income = (await request('/api/transactions', 'POST', { ...sample, type: 'income', category: 'salary' })).body;
  assert.equal((await request(`/api/transactions/${income.id}/move`, 'POST', { type: 'saving' })).status, 409);
});

test('savings support CRUD, refund amounts and category deletion without fixed-plan classification', async t => {
  const { request } = await setup(t);
  const category = (await request('/api/categories', 'POST', { name: '저축 분류 테스트', type: 'expense' })).body;
  const saving = { ...sample, type: 'saving', category: category.id };
  const created = await request('/api/transactions', 'POST', saving);
  assert.equal(created.status, 201);
  const url = `/api/transactions/${created.body.id}`;
  assert.equal((await request(url, 'PUT', { ...saving, amount: 5000, isRefund: true })).status, 200);
  assert.equal((await request(`${url}/fixed-expense`, 'POST', {})).status, 400);
  for (const patch of [{ category: 'salary' }, { transferDirection: 'out' }, { fixedExpenseId: randomUUID() }]) {
    assert.equal((await request('/api/transactions', 'POST', { ...saving, ...patch })).status, 400);
  }
  assert.equal((await request(`/api/categories/${category.id}`, 'DELETE')).status, 204);
  const state = (await request('/api/state')).body;
  assert.equal(state.transactions[0].category, 'other');
  assert.equal(summary(state.transactions, '2026-10').saving, -5000);
  assert.equal(summary(state.transactions, '2026-10').balance, 5000);
  assert.equal((await request('/api/restore', 'POST', (await request('/api/backup')).body)).status, 200);
  assert.equal((await request(url, 'DELETE')).status, 204);
  assert.equal((await request('/api/state')).body.transactions.length, 0);
});

test('moving a linked expense to savings preserves its plan and releases the payment link', async t => {
  const { request } = await setup(t);
  const plan = (await request('/api/fixed-expenses', 'POST', fixedSample)).body;
  const expense = (await request('/api/transactions', 'POST', { ...sample, category: plan.category, fixedExpenseId: plan.id })).body;
  assert.equal((await request(`/api/transactions/${expense.id}/move`, 'POST', { type: 'saving' })).status, 200);
  const state = (await request('/api/state')).body;
  assert.equal(state.transactions[0].fixedExpenseId, null);
  assert.equal(state.fixedExpenses[0].id, plan.id);
  assert.equal(budgetSummary(state, '2026-10').paid, 0);
  assert.equal(budgetSummary(state, '2026-10').pending, plan.amount);
  assert.equal((await request('/api/transactions', 'POST', { ...sample, category: plan.category, fixedExpenseId: plan.id })).status, 201);
});

test('reimporting an expense moved to savings keeps its classification and skips duplicates', { skip: !existsSync(sampleWorkbook) }, async t => {
  const { request } = await setup(t);
  const payload = { fileName: '2025-10-20~2026-10-20.xlsx' };
  const preview = (await request('/api/imports/preview', 'POST', payload)).body;
  const months = ['2026-10'];
  assert.equal((await request('/api/imports/commit', 'POST', { previewId: preview.previewId, months })).status, 200);
  const before = (await request('/api/state')).body;
  const expense = before.transactions.find(t => t.type === 'expense');
  assert.equal((await request(`/api/transactions/${expense.id}/move`, 'POST', { type: 'saving' })).status, 200);
  const nextPreview = (await request('/api/imports/preview', 'POST', payload)).body;
  assert.equal(nextPreview.months.find(m => m.month === '2026-10').available, 0);
  const imported = await request('/api/imports/commit', 'POST', { previewId: nextPreview.previewId, months });
  assert.equal(imported.body.imported, 0);
  const state = (await request('/api/state')).body;
  assert.equal(state.transactions.length, before.transactions.length);
  assert.equal(state.transactions.find(t => t.id === expense.id).type, 'saving');
});

test('existing transfer-capable databases upgrade for savings without changing records or categories', async t => {
  const file = path.join(tmpdir(), `moa-saving-migration-${randomUUID()}.sqlite`);
  const first = await setup(t, file);
  await first.request('/api/transactions', 'POST', sample);
  await first.request('/api/transactions', 'POST', { ...sample, type: 'transfer', category: 'transfer', transferDirection: 'in' });
  await first.request('/api/budgets/2026-10', 'PUT', { amount: 100000 });
  const before = (await first.request('/api/state')).body;
  await first.stop();
  const old = new DatabaseSync(file);
  const schema = old.prepare("SELECT sql FROM sqlite_master WHERE name='transactions'").get().sql;
  old.exec('ALTER TABLE transactions RENAME TO before_saving');
  old.exec(schema.replace("'saving',", ''));
  old.exec('INSERT INTO transactions SELECT * FROM before_saving; DROP TABLE before_saving;');
  old.close();
  const migrated = await setup(t, file);
  assert.deepEqual((await migrated.request('/api/state')).body, before);
  assert.equal((await migrated.request('/api/transactions', 'POST', { ...sample, type: 'saving' })).status, 201);
  await migrated.stop();
  const restarted = await setup(t, file);
  assert.equal((await restarted.request('/api/state')).body.transactions.find(t => t.type === 'saving').amount, sample.amount);
  await restarted.stop();
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(file + suffix)) unlinkSync(file + suffix);
});

test('stored transfers and old backups become expenses without changing IDs, import keys or cash direction', async t => {
  const file = path.join(tmpdir(), `moa-transfer-expenses-${randomUUID()}.sqlite`);
  const first = await setup(t, file);
  await first.request('/api/transactions', 'POST', sample);
  await first.request('/api/budgets/2026-10', 'PUT', { amount: 100000 });
  const add = first.db.prepare("INSERT INTO transactions (id,type,amount,date,title,category,method,note,transferDirection,importKey,importSource) VALUES (?,'transfer',?,?,?,'transfer','original account','original note',?,?,?)");
  const source = { fileName: 'old.xlsx', sheet: 2, row: 2, category: '이체', subcategory: '', time: '12:00:00', originalAmount: -5000 };
  const outgoing = randomUUID(), incoming = randomUUID();
  add.run(outgoing, 5000, '2026-10-05', 'outgoing', 'out', 'e'.repeat(64), JSON.stringify(source));
  add.run(incoming, 3000, '2026-10-06', 'incoming', 'in', 'f'.repeat(64), JSON.stringify({ ...source, row: 3, originalAmount: 3000 }));
  const before = (await first.request('/api/state')).body;
  const rowids = first.db.prepare('SELECT id,rowid FROM transactions ORDER BY rowid').all();
  await first.stop();
  const migrated = await setup(t, file);
  const state = (await migrated.request('/api/state')).body;
  assert.equal(state.transactions.length, before.transactions.length);
  assert.deepEqual(state.categories, before.categories);
  assert.deepEqual(migrated.db.prepare('SELECT id,rowid FROM transactions ORDER BY rowid').all(), rowids);
  for (const [id, deducted, amount, key] of [[outgoing, false, 5000, 'e'], [incoming, true, 3000, 'f']]) {
    const record = state.transactions.find(tx => tx.id === id);
    assert.equal(record.type, 'expense');
    assert.equal(record.category, 'other');
    assert.equal(record.isRefund, deducted);
    assert.equal(record.amount, amount);
    assert.equal(record.importKey, key.repeat(64));
    assert.equal(record.importSource.type, '이체');
    assert.equal(record.importSource.originalAmount, deducted ? amount : -amount);
    assert.equal(record.transferDirection, null);
    assert.equal(record.method, 'original account');
    assert.equal(record.note, 'original note');
  }
  assert.equal(summary(state.transactions, '2026-10').expense, sample.amount + 2000);
  assert.equal(budgetSummary(state, '2026-10').remaining, 100000 - sample.amount - 2000);
  assert.equal((await migrated.request('/api/restore', 'POST', { ...before, version: 4 })).status, 200);
  assert.deepEqual((await migrated.request('/api/state')).body, state);
  await migrated.stop();
  const restarted = await setup(t, file);
  assert.deepEqual((await restarted.request('/api/state')).body, state);
  await restarted.stop();
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(file + suffix)) unlinkSync(file + suffix);
});

test('converting old transfers rolls back all rows on a storage error', () => {
  const file = path.join(tmpdir(), `moa-transfer-expenses-rollback-${randomUUID()}.sqlite`);
  const original = createApp(file);
  original.db.exec("INSERT INTO transactions (id,type,amount,date,title,category,method,note,transferDirection) VALUES ('first','transfer',5000,'2026-10-01','outgoing','transfer','account','','out'),('second','transfer',3000,'2026-10-02','incoming','transfer','account','','in'); CREATE TRIGGER fail_transfer_conversion BEFORE UPDATE ON transactions WHEN OLD.id='second' BEGIN SELECT RAISE(ABORT, 'test conversion rollback'); END;");
  original.db.close();
  assert.throws(() => createApp(file), /test conversion rollback/);
  const retained = new DatabaseSync(file);
  assert.equal(retained.prepare("SELECT count(*) AS count FROM transactions WHERE type='transfer'").get().count, 2);
  assert.equal(retained.prepare('SELECT sum(amount) AS amount FROM transactions').get().amount, 8000);
  retained.close();
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(file + suffix)) unlinkSync(file + suffix);
});

test('failed transfer migration rolls back the table rebuild without losing original records', () => {
  const file = path.join(tmpdir(), `moa-transfer-rollback-${randomUUID()}.sqlite`);
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE transactions (
    id TEXT PRIMARY KEY,type TEXT CHECK(type IN ('income','expense')),amount INTEGER,date TEXT,title TEXT,category TEXT,method TEXT,note TEXT,
    fixedExpenseId TEXT,isRefund INTEGER DEFAULT 0,importKey TEXT,importSource TEXT);
    INSERT INTO transactions VALUES ('first','expense',100,'2026-10-01','원본','food','현금','',NULL,0,'duplicate',NULL);
    INSERT INTO transactions VALUES ('second','expense',200,'2026-10-02','원본2','food','현금','',NULL,0,'duplicate',NULL);`);
  old.close();
  assert.throws(() => createApp(file), /UNIQUE/);
  const retained = new DatabaseSync(file);
  assert.equal(retained.prepare('SELECT count(*) AS count FROM transactions').get().count, 2);
  assert.equal(retained.prepare('SELECT sum(amount) AS total FROM transactions').get().total, 300);
  assert.equal(retained.prepare("SELECT name FROM sqlite_master WHERE name='transactions_legacy'").get(), undefined);
  assert.ok(!retained.prepare("SELECT sql FROM sqlite_master WHERE name='transactions'").get().sql.includes("'transfer'"));
  retained.close();
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(file + suffix)) unlinkSync(file + suffix);
});
