import { readSheet } from 'read-excel-file/node';
import { createHash } from 'node:crypto';
import { transactionSchema, transactionValue, transferSummary } from '../shared/ledger.js';

export const MAX_XLSX_BYTES = 10 * 1024 * 1024;
const text = v => v == null ? '' : String(v).trim();
function dateText(value) {
  if (value instanceof Date && !isNaN(value)) return value.toISOString().slice(0, 10);
  const match = text(value).match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
  return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : '';
}
function timeText(value) {
  if (value instanceof Date && !isNaN(value)) return value.toISOString().slice(11, 19);
  if (typeof value === 'number' && value >= 0 && value < 1) {
    const seconds = Math.round(value * 86400) % 86400;
    return [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60].map(v => String(v).padStart(2, '0')).join(':');
  }
  return text(value);
}
function categoryFor(type, major, minor) {
  if (type === 'transfer') return 'transfer';
  if (type === 'income') {
    if (/급여|월급|상여/.test(major)) return 'salary';
    if (/금융|이자|배당/.test(major)) return 'interest';
    if (/부수입|부업/.test(major)) return 'side';
    return 'income-other';
  }
  if (/점심|식비|외식|식사/.test(major)) return 'food';
  if (/카페|간식/.test(major)) return 'cafe';
  if (/교통|자동차/.test(major)) return 'transport';
  if (/쇼핑|의류/.test(major)) return 'shopping';
  if (/병원|의료|건강/.test(major)) return 'health';
  if (/문화|여가|여행/.test(major)) return 'culture';
  if (/주거|통신/.test(major) || (major === '고정' && /월세|관리비|가스|전기|수도|인터넷|통신/.test(minor))) return 'home';
  return 'other';
}
export function parseLedgerRows(rows, fileName) {
  if (rows.length > 100001) throw new Error('10만 행 이하의 파일을 선택해 주세요.');
  const required = ['날짜', '타입', '내용', '금액', '화폐', '결제수단'];
  const headerIndex = rows.slice(0, 20).findIndex(row => required.every(h => row.map(text).includes(h)));
  if (headerIndex < 0) throw new Error('두 번째 시트에 날짜·타입·내용·금액·화폐·결제수단 열이 필요합니다.');
  const headers = rows[headerIndex].map(text);
  if (required.some(h => headers.filter(v => v === h).length !== 1)) throw new Error('필수 열 이름이 중복되어 있습니다.');
  const records = [], skipped = [];
  const occurrence = new Map();
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.every(v => v == null || v === '')) continue;
    const get = header => cells[headers.indexOf(header)];
    const row = i + 1, date = dateText(get('날짜')), month = date.slice(0, 7);
    const sourceType = text(get('타입'));
    const skip = reason => skipped.push({ row, month: /^\d{4}-\d{2}$/.test(month) ? month : null, reason });
    if (!['수입', '지출', '이체'].includes(sourceType)) { skip('지원하지 않는 타입'); continue; }
    const rawAmount = get('금액');
    const amount = typeof rawAmount === 'number' ? rawAmount : typeof rawAmount === 'string' && /^[-+]?\d[\d,]*$/.test(rawAmount.trim()) ? Number(rawAmount.replaceAll(',', '')) : NaN;
    if (!Number.isSafeInteger(amount)) { skip('금액 오류'); continue; }
    if (amount === 0) { skip('0원'); continue; }
    if (text(get('화폐')).toUpperCase() !== 'KRW') { skip('원화가 아닌 통화'); continue; }
    const type = sourceType === '수입' ? 'income' : sourceType === '지출' ? 'expense' : 'transfer';
    const major = text(get('대분류')), minor = text(get('소분류'));
    const title = text(get('내용')), method = text(get('결제수단')) || '미지정', note = text(get('메모')), time = timeText(get('시간'));
    // File names and sheet row numbers are excluded so renamed/overlapping exports deduplicate.
    const identity = JSON.stringify([date, time, sourceType, major, minor, title, amount, 'KRW', method, note]);
    const index = (occurrence.get(identity) || 0) + 1;
    occurrence.set(identity, index); // Preserve multiple genuinely identical rows inside one export.
    const importKey = createHash('sha256').update(`${identity}\n${index}`).digest('hex');
    const candidate = {
      type, date, title, amount: Math.abs(amount), method, note, category: categoryFor(type, major, minor),
      isRefund: type === 'transfer' ? false : type === 'expense' ? amount > 0 : amount < 0, importKey,
      transferDirection: type === 'transfer' ? amount > 0 ? 'in' : 'out' : null,
      importSource: { fileName, sheet: 2, row, category: major, subcategory: minor, time, originalAmount: amount },
    };
    const parsed = transactionSchema.safeParse(candidate);
    if (!parsed.success) { skip('날짜·내용·금액 또는 텍스트 길이 오류'); continue; }
    records.push({ row, month, transaction: parsed.data });
  }
  const months = [...new Set([...records.map(r => r.month), ...skipped.map(r => r.month).filter(Boolean)])].sort().reverse();
  return { fileName, sheet: 2, records, skipped, months };
}
export async function parseXlsx(buffer, fileName) {
  if (!buffer.length || buffer.length > MAX_XLSX_BYTES) throw new Error('10MB 이하의 XLSX 파일을 선택해 주세요.');
  let rows;
  try { rows = await readSheet(buffer, 2); }
  catch (error) {
    if (error.name === 'SheetNotFoundError') throw new Error('두 번째 시트가 없는 파일입니다.');
    throw new Error('XLSX 파일을 읽을 수 없습니다. 암호 없이 저장된 XLSX 파일인지 확인해 주세요.');
  }
  return parseLedgerRows(rows, fileName);
}
export function describeImport(parsed, existingKeys) {
  const records = parsed.records.map(r => ({ ...r, duplicate: existingKeys.has(r.transaction.importKey) }));
  const months = parsed.months.map(month => {
    const rows = records.filter(r => r.month === month);
    const available = rows.filter(r => !r.duplicate);
    const transfers = transferSummary(available.map(r => r.transaction));
    return {
      month, count: rows.length, available: available.length, duplicates: rows.length - available.length,
      incomeCount: available.filter(r => r.transaction.type === 'income').length,
      expenseCount: available.filter(r => r.transaction.type === 'expense').length,
      transferCount: transfers.count, transferIn: transfers.incoming, transferOut: transfers.outgoing,
      income: available.filter(r => r.transaction.type === 'income').reduce((s, r) => s + transactionValue(r.transaction), 0),
      expense: available.filter(r => r.transaction.type === 'expense').reduce((s, r) => s + transactionValue(r.transaction), 0),
      refunds: available.filter(r => r.transaction.isRefund).length,
      skipped: parsed.skipped.filter(r => r.month === month).length,
    };
  });
  const reasons = Object.entries(parsed.skipped.reduce((s, r) => ({ ...s, [r.reason]: (s[r.reason] || 0) + 1 }), {})).map(([reason, count]) => ({ reason, count }));
  return { fileName: parsed.fileName, sheet: 2, months, records, skipped: parsed.skipped, reasons };
}
