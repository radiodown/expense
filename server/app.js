import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { categories, categorySchema, categoryBudgetSchema, createTransactionSchema, createFixedExpenseSchema, fallbackCategory, monthSchema, budgetSchema, backupSchema, shiftMonth, normalizeTransfer } from '../shared/ledger.js';
import { legacyCategories } from '../shared/categories.js';
import { assetSchema } from '../shared/assets.js';
import { parseXlsx, describeImport, MAX_XLSX_BYTES } from './xlsx-import.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const transactionTableSql = `CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('income','expense','saving','transfer')),
  amount INTEGER NOT NULL CHECK(amount > 0), date TEXT NOT NULL,
  title TEXT NOT NULL, category TEXT NOT NULL, method TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  fixedExpenseId TEXT, isRefund INTEGER NOT NULL DEFAULT 0, importKey TEXT, importSource TEXT,
  transferDirection TEXT CHECK(transferDirection IN ('in','out'))
)`;
export function createApp(dbPath = path.join(root, 'data', 'ledger.sqlite'), { sampleDirectory = path.join(root, 'sample') } = {}) {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode = WAL;
    ${transactionTableSql};
    CREATE INDEX IF NOT EXISTS transaction_date ON transactions(date);
    CREATE TABLE IF NOT EXISTS budgets (month TEXT PRIMARY KEY, amount INTEGER NOT NULL CHECK(amount >= 0));
    CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, color TEXT NOT NULL, icon TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS category_budgets (month TEXT NOT NULL, category TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount >= 0), PRIMARY KEY(month, category));
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fixed_expenses (
      id TEXT PRIMARY KEY, month TEXT NOT NULL, title TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0),
      day INTEGER NOT NULL CHECK(day BETWEEN 1 AND 31), category TEXT NOT NULL, method TEXT NOT NULL, note TEXT NOT NULL
    );`);
  // Upgrade old schemas while keeping IDs, source metadata and fixed-payment links.
  if (!db.prepare('PRAGMA table_info(transactions)').all().some(c => c.name === 'fixedExpenseId')) {
    db.exec('ALTER TABLE transactions ADD COLUMN fixedExpenseId TEXT');
  }
  const columns = new Set(db.prepare('PRAGMA table_info(transactions)').all().map(c => c.name));
  for (const [name, definition] of [['isRefund', 'INTEGER NOT NULL DEFAULT 0'], ['importKey', 'TEXT'], ['importSource', 'TEXT'], ['transferDirection', 'TEXT']]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE transactions ADD COLUMN ${name} ${definition}`);
  }
  const transactionIndexesSql = `CREATE INDEX IF NOT EXISTS transaction_date ON transactions(date);
    CREATE UNIQUE INDEX IF NOT EXISTS fixed_payment ON transactions(fixedExpenseId) WHERE fixedExpenseId IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS imported_record ON transactions(importKey) WHERE importKey IS NOT NULL;`;
  // SQLite CHECK constraints require a table rebuild. Copy and index creation are atomic.
  if (!db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get().sql.includes("'saving'")) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`ALTER TABLE transactions RENAME TO transactions_legacy;
        ${transactionTableSql};
        INSERT INTO transactions (rowid,id,type,amount,date,title,category,method,note,fixedExpenseId,isRefund,importKey,importSource,transferDirection)
        SELECT rowid,id,type,amount,date,title,category,method,note,fixedExpenseId,isRefund,importKey,importSource,transferDirection FROM transactions_legacy;
        DROP TABLE transactions_legacy;
        ${transactionIndexesSql}`);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  } else db.exec(transactionIndexesSql);
  const putCategory = (id, c) => db.prepare('INSERT INTO categories (id,name,type,color,icon) VALUES (?,?,?,?,?)').run(id, c.name, c.type, c.color, c.icon);
  if (!db.prepare("SELECT value FROM settings WHERE key='categories-initialized'").get()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const referenced = new Set(db.prepare('SELECT category FROM transactions UNION SELECT category FROM fixed_expenses UNION SELECT category FROM category_budgets').all().map(row => row.category));
      const defaults = [...categories, ...legacyCategories.filter(c => referenced.has(c.id) && !categories.some(current => current.id === c.id))];
      for (const c of defaults) putCategory(c.id, c);
      db.prepare('INSERT INTO settings VALUES (?,?)').run('categories-initialized', '1');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const categoryList = () => db.prepare('SELECT * FROM categories ORDER BY rowid').all();
  const oldTransfers = db.prepare("SELECT * FROM transactions WHERE type='transfer'").all();
  if (oldTransfers.length) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const update = db.prepare('UPDATE transactions SET type=?,category=?,isRefund=?,transferDirection=NULL,fixedExpenseId=NULL,importSource=? WHERE id=?');
      for (const row of oldTransfers) {
        const t = normalizeTransfer({ ...row, importSource: row.importSource ? JSON.parse(row.importSource) : null });
        update.run(t.type, t.category, t.isRefund ? 1 : 0, t.importSource ? JSON.stringify(t.importSource) : null, t.id);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  const categoryBudgetState = () => {
    const result = {};
    for (const b of db.prepare('SELECT * FROM category_budgets').all()) (result[b.month] ||= {})[b.category] = b.amount;
    return result;
  };
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    // Loopback binding plus Host/Origin checks keep unrelated websites away from local records.
    const allowedHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;
    if (!allowedHost.test(req.headers.host || '')) return res.status(403).json({ error: '로컬 주소로 접속해 주세요.' });
    if (req.headers.origin) {
      try {
        const origin = new URL(req.headers.origin);
        if (!['http:', 'https:'].includes(origin.protocol) || !allowedHost.test(origin.host)) throw new Error();
      } catch { return res.status(403).json({ error: '허용되지 않은 요청입니다.' }); }
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: '외부 사이트의 요청은 허용되지 않습니다.' });
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'JSON 형식이 필요합니다.' });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '25mb' }));
  const state = () => ({
    transactions: db.prepare('SELECT * FROM transactions ORDER BY date DESC, rowid DESC').all().map(t => ({ ...t, isRefund: !!t.isRefund, importSource: t.importSource ? JSON.parse(t.importSource) : null })),
    budgets: Object.fromEntries(db.prepare('SELECT * FROM budgets').all().map(b => [b.month, b.amount])),
    fixedExpenses: db.prepare('SELECT * FROM fixed_expenses ORDER BY month DESC, day, title').all(),
    categories: categoryList(),
    categoryBudgets: categoryBudgetState(),
    assets: db.prepare('SELECT * FROM assets ORDER BY rowid DESC').all().map(asset => ({ ...JSON.parse(asset.data), id: asset.id })),
  });
  const insert = db.prepare('INSERT INTO transactions (id,type,amount,date,title,category,method,note,fixedExpenseId,isRefund,importKey,importSource,transferDirection) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const put = (id, t) => insert.run(id, t.type, t.amount, t.date, t.title, t.category, t.method, t.note, t.fixedExpenseId || null, t.isRefund ? 1 : 0, t.importKey || null, t.importSource ? JSON.stringify(t.importSource) : null, t.transferDirection || null);
  const fixedInsert = db.prepare('INSERT INTO fixed_expenses (id,month,title,amount,day,category,method,note) VALUES (?,?,?,?,?,?,?,?)');
  const putFixed = (id, f) => fixedInsert.run(id, f.month, f.title, f.amount, f.day, f.category, f.method, f.note);
  const validateLink = (t, id, res) => {
    if (!t.fixedExpenseId) return true;
    const f = db.prepare('SELECT * FROM fixed_expenses WHERE id=?').get(t.fixedExpenseId);
    if (!f || t.isRefund || t.type !== 'expense' || !t.date.startsWith(f.month)) {
      res.status(400).json({ error: '고정지출과 같은 달의 지출 기록만 연결할 수 있습니다.' }); return false;
    }
    const existing = db.prepare('SELECT id FROM transactions WHERE fixedExpenseId=?').get(f.id);
    if (existing && existing.id !== id) { res.status(409).json({ error: '이미 지출로 반영된 항목입니다.' }); return false; }
    return true;
  };
  const parse = (schema, value, res) => {
    const result = schema.safeParse(value);
    if (!result.success) { res.status(400).json({ error: '입력값을 확인해 주세요.', details: result.error.issues }); return null; }
    return result.data;
  };
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/state', (_req, res) => res.json(state()));
  const putAsset = (id, asset) => db.prepare('INSERT INTO assets (id,data) VALUES (?,?)').run(id, JSON.stringify(asset));
  app.post('/api/assets', (req, res) => {
    const asset = parse(assetSchema, req.body, res);
    if (!asset) return;
    if (db.prepare('SELECT COUNT(*) AS count FROM assets').get().count >= 1000) return res.status(400).json({ error: '자산은 최대 1,000개까지 등록할 수 있습니다.' });
    const id = randomUUID();
    putAsset(id, asset);
    res.status(201).json({ ...asset, id });
  });
  app.put('/api/assets/:id', (req, res) => {
    const asset = parse(assetSchema, req.body, res);
    if (!asset) return;
    const result = db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify(asset), req.params.id);
    if (!result.changes) return res.status(404).json({ error: '자산을 찾을 수 없습니다.' });
    res.json({ ...asset, id: req.params.id });
  });
  app.delete('/api/assets/:id', (req, res) => {
    const result = db.prepare('DELETE FROM assets WHERE id=?').run(req.params.id);
    if (!result.changes) return res.status(404).json({ error: '자산을 찾을 수 없습니다.' });
    res.status(204).end();
  });
  const duplicateCategory = (c, id) => categoryList().some(item => item.id !== id && item.type === c.type && item.name.toLowerCase() === c.name.toLowerCase());
  app.post('/api/categories', (req, res) => {
    const c = parse(categorySchema, req.body, res);
    if (!c) return;
    if (categoryList().length >= 500) return res.status(400).json({ error: '카테고리는 최대 500개까지 등록할 수 있습니다.' });
    if (duplicateCategory(c)) return res.status(409).json({ error: '같은 이름의 카테고리가 있습니다.' });
    const id = randomUUID(); putCategory(id, c);
    res.status(201).json({ id, ...c });
  });
  app.put('/api/categories/:id', (req, res) => {
    const c = parse(categorySchema, req.body, res);
    if (!c) return;
    const existing = db.prepare('SELECT * FROM categories WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: '카테고리를 찾을 수 없습니다.' });
    if (c.type !== existing.type) return res.status(400).json({ error: '카테고리의 수입·지출 구분은 변경할 수 없습니다.' });
    if (duplicateCategory(c, existing.id)) return res.status(409).json({ error: '같은 이름의 카테고리가 있습니다.' });
    db.prepare('UPDATE categories SET name=?,color=?,icon=? WHERE id=?').run(c.name, c.color, c.icon, existing.id);
    res.json({ id: existing.id, ...c });
  });
  app.delete('/api/categories/:id', (req, res) => {
    const c = db.prepare('SELECT * FROM categories WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ error: '카테고리를 찾을 수 없습니다.' });
    const fallback = fallbackCategory(c.type);
    if (c.id === fallback) return res.status(400).json({ error: '기본 기타 카테고리는 이름만 수정할 수 있습니다.' });
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE transactions SET category=? WHERE category=?').run(fallback, c.id);
      db.prepare('UPDATE fixed_expenses SET category=? WHERE category=?').run(fallback, c.id);
      db.prepare(`INSERT INTO category_budgets (month,category,amount)
        SELECT month,?,amount FROM category_budgets WHERE category=?
        ON CONFLICT(month,category) DO UPDATE SET amount=category_budgets.amount+excluded.amount`).run(fallback, c.id);
      db.prepare('DELETE FROM category_budgets WHERE category=?').run(c.id);
      db.prepare('DELETE FROM categories WHERE id=?').run(c.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.status(204).end();
  });
  const normalizeImportCategories = parsed => {
    const list = categoryList();
    for (const { transaction: t } of parsed.records) {
      if (t.type === 'transfer') continue;
      if (!list.some(c => c.id === t.category && c.type === t.type)) t.category = fallbackCategory(t.type);
    }
  };
  const previews = new Map();
  const listFiles = async () => {
    try { return (await readdir(sampleDirectory, { withFileTypes: true })).filter(f => f.isFile() && /\.xlsx$/i.test(f.name) && !f.name.startsWith('~$')).map(f => f.name).sort(); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  app.get('/api/imports/files', async (_req, res) => res.json({ files: await listFiles() }));
  app.post('/api/imports/preview', async (req, res) => {
    const input = parse(z.object({ fileName: z.string().min(1).max(255).regex(/\.xlsx$/i), content: z.string().max(14 * 1024 * 1024).optional() }), req.body, res);
    if (!input) return;
    let buffer;
    if (input.content !== undefined) {
      buffer = Buffer.from(input.content, 'base64');
      if (buffer.toString('base64') !== input.content) return res.status(400).json({ error: '파일 전송 형식이 올바르지 않습니다.' });
    } else {
      if (!(await listFiles()).includes(input.fileName)) return res.status(404).json({ error: 'sample 폴더에서 파일을 찾을 수 없습니다.' });
      const file = path.join(sampleDirectory, input.fileName);
      if ((await stat(file)).size > MAX_XLSX_BYTES) return res.status(400).json({ error: '10MB 이하의 파일을 선택해 주세요.' });
      buffer = await readFile(file);
    }
    let parsed;
    try { parsed = await parseXlsx(buffer, input.fileName); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    normalizeImportCategories(parsed);
    for (const [id, preview] of previews) if (preview.expires < Date.now()) previews.delete(id);
    while (previews.size >= 6) previews.delete(previews.keys().next().value);
    const previewId = randomUUID();
    previews.set(previewId, { parsed, expires: Date.now() + 30 * 60 * 1000 });
    const existing = new Set(db.prepare('SELECT importKey FROM transactions WHERE importKey IS NOT NULL').all().map(t => t.importKey));
    res.json({ previewId, ...describeImport(parsed, existing) });
  });
  app.post('/api/imports/commit', (req, res) => {
    const input = parse(z.object({ previewId: z.string().uuid(), months: z.array(monthSchema).min(1).max(2400) }), req.body, res);
    if (!input) return;
    const preview = previews.get(input.previewId);
    if (!preview || preview.expires < Date.now()) return res.status(410).json({ error: '미리보기가 만료되었습니다. 파일을 다시 읽어 주세요.' });
    if (input.months.some(m => !preview.parsed.months.includes(m))) return res.status(400).json({ error: '파일에 없는 월이 선택되었습니다.' });
    normalizeImportCategories(preview.parsed);
    const selected = new Set(input.months);
    const records = preview.parsed.records.filter(r => selected.has(r.month));
    let imported = 0, duplicates = 0, income = 0, expense = 0, transfer = 0;
    const exists = db.prepare('SELECT id FROM transactions WHERE importKey=?');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const { transaction: t } of records) {
        if (exists.get(t.importKey)) { duplicates++; continue; }
        put(randomUUID(), t);
        imported++;
        if (t.type === 'income') income++; else if (t.type === 'expense') expense++;
        if (t.importSource?.type === '이체') transfer++;
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.json({ imported, duplicates, income, expense, transfer, months: [...selected].sort(), excluded: preview.parsed.skipped.filter(r => selected.has(r.month)).length });
  });
  app.post('/api/transactions', (req, res) => {
    const parsed = parse(createTransactionSchema(categoryList()), req.body, res);
    if (!parsed) return;
    const t = normalizeTransfer(parsed);
    const id = randomUUID();
    if (!validateLink(t, id, res)) return;
    put(id, t);
    res.status(201).json({ id, ...t });
  });
  app.put('/api/transactions/:id', (req, res) => {
    const parsed = parse(createTransactionSchema(categoryList()), req.body, res);
    if (!parsed) return;
    const t = normalizeTransfer(parsed);
    if (!validateLink(t, req.params.id, res)) return;
    const result = db.prepare('UPDATE transactions SET type=?,amount=?,date=?,title=?,category=?,method=?,note=?,fixedExpenseId=?,isRefund=?,importKey=?,importSource=?,transferDirection=? WHERE id=?')
      .run(t.type, t.amount, t.date, t.title, t.category, t.method, t.note, t.fixedExpenseId, t.isRefund ? 1 : 0, t.importKey, t.importSource ? JSON.stringify(t.importSource) : null, t.transferDirection, req.params.id);
    if (!result.changes) return res.status(404).json({ error: '기록을 찾을 수 없습니다.' });
    res.json({ id: req.params.id, ...t });
  });
  app.delete('/api/transactions/:id', (req, res) => {
    const result = db.prepare('DELETE FROM transactions WHERE id=?').run(req.params.id);
    if (!result.changes) return res.status(404).json({ error: '기록을 찾을 수 없습니다.' });
    res.status(204).end();
  });
  app.post('/api/transactions/:id/move', (req, res) => {
    const move = parse(z.object({ type: z.enum(['expense', 'saving']) }), req.body, res);
    if (!move) return;
    const previousType = move.type === 'saving' ? 'expense' : 'saving';
    const existing = db.prepare('SELECT type FROM transactions WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: '기록을 찾을 수 없습니다.' });
    if (existing.type !== previousType) return res.status(409).json({ error: '지출과 저축 내역 사이에서만 이동할 수 있습니다.' });
    const result = db.prepare('UPDATE transactions SET type=?,fixedExpenseId=NULL WHERE id=? AND type=?').run(move.type, req.params.id, previousType);
    if (!result.changes) return res.status(409).json({ error: '이미 변경된 내역입니다. 목록을 새로고침해 주세요.' });
    res.json({ id: req.params.id, type: move.type });
  });
  app.post('/api/transactions/:id/fixed-expense', (req, res) => {
    const t = db.prepare('SELECT * FROM transactions WHERE id=?').get(req.params.id);
    if (!t) return res.status(404).json({ error: '기록을 찾을 수 없습니다.' });
    if (t.type !== 'expense' || t.isRefund) return res.status(400).json({ error: '일반 지출 내역만 고정지출로 등록할 수 있습니다.' });
    if (t.fixedExpenseId) return res.status(409).json({ error: '이미 고정지출로 연결된 내역입니다.' });
    const f = { month: t.date.slice(0, 7), day: Number(t.date.slice(8)), title: t.title, amount: t.amount, category: t.category, method: t.method, note: t.note };
    const id = randomUUID();
    db.exec('BEGIN IMMEDIATE');
    try {
      putFixed(id, f);
      db.prepare('UPDATE transactions SET fixedExpenseId=? WHERE id=?').run(id, t.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.status(201).json({ id, ...f });
  });
  app.put('/api/budgets/:month', (req, res) => {
    const month = parse(monthSchema, req.params.month, res);
    if (!month) return;
    const b = parse(budgetSchema, req.body, res);
    if (!b) return;
    db.prepare('INSERT INTO budgets VALUES (?,?) ON CONFLICT(month) DO UPDATE SET amount=excluded.amount').run(month, b.amount);
    res.json(b);
  });
  app.put('/api/budgets/:month/categories', (req, res) => {
    const month = parse(monthSchema, req.params.month, res);
    if (!month) return;
    const b = parse(categoryBudgetSchema, req.body, res);
    if (!b) return;
    const list = categoryList();
    if (Object.keys(b.amounts).some(id => !list.some(c => c.id === id && c.type === 'expense'))) return res.status(400).json({ error: '지출 카테고리를 선택해 주세요.' });
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM category_budgets WHERE month=?').run(month);
      for (const [id, amount] of Object.entries(b.amounts)) db.prepare('INSERT INTO category_budgets VALUES (?,?,?)').run(month, id, amount);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.json(b);
  });
  app.get('/api/backup', (_req, res) => {
    res.attachment('moa-backup.json').json({ version: 6, exportedAt: new Date().toISOString(), ...state() });
  });
  app.post('/api/fixed-expenses', (req, res) => {
    const f = parse(createFixedExpenseSchema(categoryList()), req.body, res);
    if (!f) return;
    const id = randomUUID(); putFixed(id, f);
    res.status(201).json({ id, ...f });
  });
  app.post('/api/budgets/:month/copy-fixed', (req, res) => {
    const month = parse(monthSchema, req.params.month, res);
    if (!month) return;
    if (db.prepare('SELECT id FROM fixed_expenses WHERE month=? LIMIT 1').get(month)) return res.status(409).json({ error: '이번 달에 고정지출이 이미 있습니다. 중복 복사를 막기 위해 빈 달에만 복사할 수 있습니다.' });
    const previous = db.prepare('SELECT * FROM fixed_expenses WHERE month=?').all(shiftMonth(month, -1));
    if (!previous.length) return res.status(404).json({ error: '지난달 고정지출 항목이 없습니다.' });
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const f of previous) putFixed(randomUUID(), { ...f, month });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.status(201).json({ copied: previous.length });
  });
  app.put('/api/fixed-expenses/:id', (req, res) => {
    const f = parse(createFixedExpenseSchema(categoryList()), req.body, res);
    if (!f) return;
    const existing = db.prepare('SELECT * FROM fixed_expenses WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: '고정지출 항목을 찾을 수 없습니다.' });
    if (existing.month !== f.month) return res.status(400).json({ error: '고정지출의 적용 월은 변경할 수 없습니다.' });
    db.prepare('UPDATE fixed_expenses SET title=?,amount=?,day=?,category=?,method=?,note=? WHERE id=?')
      .run(f.title, f.amount, f.day, f.category, f.method, f.note, req.params.id);
    res.json({ id: req.params.id, ...f });
  });
  app.delete('/api/fixed-expenses/:id', (req, res) => {
    if (!db.prepare('SELECT id FROM fixed_expenses WHERE id=?').get(req.params.id)) return res.status(404).json({ error: '고정지출 항목을 찾을 수 없습니다.' });
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE transactions SET fixedExpenseId=NULL WHERE fixedExpenseId=?').run(req.params.id);
      db.prepare('DELETE FROM fixed_expenses WHERE id=?').run(req.params.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.status(204).end();
  });
  app.post('/api/restore', (req, res) => {
    const backup = parse(backupSchema, req.body, res);
    if (!backup) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM transactions; DELETE FROM budgets; DELETE FROM fixed_expenses; DELETE FROM categories; DELETE FROM category_budgets; DELETE FROM assets;');
      for (const asset of backup.assets) putAsset(asset.id, assetSchema.parse(asset));
      for (const c of backup.categories) putCategory(c.id, c);
      for (const [month, amounts] of Object.entries(backup.categoryBudgets)) {
        for (const [id, amount] of Object.entries(amounts)) db.prepare('INSERT INTO category_budgets VALUES (?,?,?)').run(month, id, amount);
      }
      for (const f of backup.fixedExpenses) putFixed(f.id, f);
      for (const t of backup.transactions) put(t.id, t);
      const budgetInsert = db.prepare('INSERT INTO budgets VALUES (?, ?)');
      for (const [month, amount] of Object.entries(backup.budgets)) budgetInsert.run(month, amount);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.json({ restored: backup.transactions.length });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '요청한 API가 없습니다.' }));
  if (existsSync(path.join(root, 'dist', 'index.html'))) {
    app.use(express.static(path.join(root, 'dist')));
    app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
  }
  app.use((error, _req, res, _next) => {
    const status = error.status >= 400 && error.status < 500 ? error.status : 500;
    if (status === 500) console.error(error);
    res.status(status).json({ error: status === 413 ? '파일이 너무 큽니다. 25MB 이하 파일을 선택해 주세요.' : status === 400 ? '올바른 JSON을 입력해 주세요.' : '저장 중 오류가 발생했습니다. 다시 시도해 주세요.' });
  });
  return { app, db };
}
