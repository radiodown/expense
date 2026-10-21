import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { LayoutDashboard, Wallet, ArrowDownLeft, ArrowUpRight, ArrowLeftRight, ArrowUp, ArrowDown, ArrowUpDown, PiggyBank, ChartNoAxesCombined, Settings2, Plus, Pencil, Trash2, X, ChevronLeft, ChevronRight, Download, Search, Goal, Copy, Check, LoaderCircle, Database } from 'lucide-react';
import { categories as defaultCategories, transferCategory, transactionTypes, transactionLabel, categoryType, refundLabel, methods, createTransactionSchema, createFixedExpenseSchema, today, currentMonth, categoryOf, won, cashValue, transactionValue, moveTargets, toTypeLabel } from '../shared/ledger.js';
import InlineTransactionRow from './InlineTransactionRow.jsx';
import { transactionColumns } from './transaction-sort.js';

const icons = { LayoutDashboard, Wallet, ArrowDownLeft, ArrowUpRight, ArrowLeftRight, ArrowUp, ArrowDown, ArrowUpDown, PiggyBank, ChartNoAxesCombined, Settings2, Plus, Pencil, Trash2, X, ChevronLeft, ChevronRight, Download, Search, Goal, Copy, Check, LoaderCircle, Database };
export function Icon({ name, size = 18, ...props }) {
  const Component = icons[name] || Database;
  return <Component size={size} strokeWidth={1.8} {...props} />;
}
export function Modal({ open, onClose, title, description, children, busy, className = '' }) {
  return <Dialog.Root open={open} onOpenChange={v => { if (!v && !busy) onClose(); }}><Dialog.Portal>
    <Dialog.Overlay className="modal-overlay" /><Dialog.Content className={`modal ${className}`}>
      <div className="modal-heading"><div><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description></div><Dialog.Close className="icon-button" disabled={busy} aria-label="닫기"><Icon name="X" /></Dialog.Close></div>
      {children}
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
export function Empty({ text = '등록된 내역이 없습니다.' }) { return <div className="empty">{text}</div>; }
export function Metric({ title, value, note, tone = '' }) {
  return <div className={`metric ${tone}`}><span>{title}</span><strong>{value}</strong><small>{note}</small></div>;
}
// Same palette and order as the category expense chart.
function categoryColor(id, categories) {
  const category = categoryOf(id, categories);
  const index = categories.filter(c => c.type === category.type).findIndex(c => c.id === category.id);
  return index < 0 ? 'var(--muted)' : `var(--category-${index % 10 + 1})`;
}
// Korean public holidays. Fixed solar dates apply every year; lunar, substitute and election days are listed per year.
const fixedHolidays = new Set(['01-01', '03-01', '05-05', '06-06', '08-15', '10-03', '10-09', '12-25']);
const datedHolidays = new Set([
  '2025-01-27', '2025-01-28', '2025-01-29', '2025-01-30', '2025-03-03', '2025-05-06', '2025-06-03', '2025-10-05', '2025-10-06', '2025-10-07', '2025-10-08',
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-03-02', '2026-05-24', '2026-05-25', '2026-06-03', '2026-08-17', '2026-09-24', '2026-09-25', '2026-09-26', '2026-10-05',
]);
function weekdayClass(date) {
  if (fixedHolidays.has(date.slice(5)) || datedHolidays.has(date)) return 'holiday';
  const day = new Date(`${date}T00:00:00`).getDay();
  return day === 0 ? 'holiday' : day === 6 ? 'saturday' : '';
}
function TransactionContextMenu({ transaction, onMakeFixed, onMove, disabled, children }) {
  const canMakeFixed = onMakeFixed && transaction.type === 'expense' && !transaction.fixedExpenseId && !transaction.isRefund;
  const moveTypes = onMove ? moveTargets[transaction.type] || [] : [];
  const canMove = moveTypes.length > 0;
  if (!canMakeFixed && !canMove) return children;
  // Keep the wrapper mounted while busy; unwrapping remounts every row and resets page scroll.
  return <ContextMenu.Root modal={false}>
    <ContextMenu.Trigger asChild disabled={disabled} className="transaction-context-row">{children}</ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content className="transaction-context-menu" collisionPadding={8} aria-label={`${transaction.title} 작업`}>
        {canMakeFixed && <ContextMenu.Item className="transaction-context-item" onSelect={() => onMakeFixed(transaction)}>고정지출 등록</ContextMenu.Item>}
        {moveTypes.map(type => <ContextMenu.Item key={type} className="transaction-context-item" onSelect={() => onMove(transaction, type)}>{toTypeLabel(type)} 옮기기</ContextMenu.Item>)}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>;
}
function TransactionColumnHeader({ column, sort, onSort, disabled }) {
  const active = !!onSort && sort?.key === column.key;
  return <th scope="col" className={`${column.numeric ? 'number ' : ''}${onSort ? 'sortable-header' : ''}`} aria-sort={active ? sort.direction === 'asc' ? 'ascending' : 'descending' : undefined}>
    {onSort ? <button type="button" className="column-sort-button" data-active={active || undefined} disabled={disabled} aria-label={`${column.label} 정렬`} onClick={() => onSort(column.key)}>
      <span>{column.label}</span><Icon name={active ? sort.direction === 'asc' ? 'ArrowUp' : 'ArrowDown' : 'ArrowUpDown'} size={14} aria-hidden="true" />
    </button> : column.label}
  </th>;
}
export function TransactionTable({ items, categories = defaultCategories, onEdit, onInlineSave, fixedExpenses = [], transactions = [], onDelete, onMakeFixed, onMove, busy, scrollRef, scrollLabel, footer, pageScroll = false, sort, onSort, selection }) {
  const [editingId, setEditingId] = useState(null);
  const activeEditingId = items.some(t => t.id === editingId) ? editingId : null;
  const actionsDisabled = busy || activeEditingId !== null;
  function edit(item) {
    if (onInlineSave && item.type !== 'transfer') setEditingId(item.id);
    else onEdit(item);
  }
  if (!items.length) return <Empty />;
  return <div className={`table-scroll${pageScroll ? ' page-scroll-table' : ''}`} ref={scrollRef} role={scrollLabel ? 'region' : undefined} aria-label={scrollLabel} tabIndex={scrollLabel ? 0 : undefined}><table><thead><tr>{selection && <th scope="col" className="select-cell"><SelectAllBox selection={selection} disabled={actionsDisabled} /></th>}{transactionColumns.map(column => <TransactionColumnHeader key={column.key} column={column} sort={sort} onSort={onSort} disabled={actionsDisabled} />)}<th scope="col" className="actions-cell">관리</th></tr></thead>
    <tbody>{items.map(t => activeEditingId === t.id ? <InlineTransactionRow key={t.id} selectable={!!selection} transaction={t} categories={categories} fixedExpenses={fixedExpenses} transactions={transactions} busy={busy} onSave={onInlineSave} onClose={() => setEditingId(null)} /> : <TransactionContextMenu key={t.id} transaction={t} onMakeFixed={onMakeFixed} onMove={onMove} disabled={actionsDisabled}><tr className={selection?.ids.has(t.id) ? 'selected-row' : undefined}>
      {selection && <td className="select-cell"><input type="checkbox" aria-label={`${t.title} 선택`} disabled={actionsDisabled} checked={selection.ids.has(t.id)} onChange={() => {}} onClick={e => selection.toggle(t.id, e.shiftKey)} /></td>}
      <td className={`nowrap ${weekdayClass(t.date)}`}>{t.date}{t.importSource?.time && <small className="cell-note">{t.importSource.time.slice(0, 5)}</small>}</td><td><span className={`badge ${t.fixedExpenseId ? 'fixed' : t.type}`}>{t.fixedExpenseId ? '고정지출' : transactionLabel(t)}</span>{t.isRefund && <small className="cell-note">{refundLabel(t.type, t.importSource)}</small>}</td>
      <td className="title-cell"><button className="link-button" disabled={actionsDisabled} onClick={() => edit(t)}>{t.title}</button></td><td><span className="category-label"><i aria-hidden="true" style={{ background: categoryColor(t.category, categories) }} />{categoryOf(t.category, categories).name}</span>{t.importSource && <small className="cell-note">원본: {[t.importSource.category, t.importSource.subcategory].filter(Boolean).join(' / ')}</small>}</td><td>{t.method}</td>
      <td className={`number nowrap ${t.type}`}>{cashValue(t) >= 0 ? '+' : '−'}{won(t.amount)}</td>
      <td><div className="row-actions"><button className="table-button" disabled={actionsDisabled} aria-label={`${t.title} 수정`} onClick={() => edit(t)}>수정</button><button className="table-button danger-text" disabled={actionsDisabled} aria-label={`${t.title} 삭제`} onClick={() => onDelete(t)}>삭제</button></div></td>
    </tr></TransactionContextMenu>)}</tbody>{footer}</table></div>;
}

function SelectAllBox({ selection, disabled }) {
  const ref = useRef(null);
  const { count, total } = selection;
  useEffect(() => { if (ref.current) ref.current.indeterminate = count > 0 && count < total; }, [count, total]);
  return <input ref={ref} type="checkbox" aria-label={`조회된 ${total}건 모두 선택`} disabled={disabled} checked={total > 0 && count === total} onChange={() => selection.toggleAll()} />;
}
function BulkActionBar({ items, type, categories, busy, onBulk, onClear }) {
  const [category, setCategory] = useState('');
  const ids = items.map(t => t.id);
  const run = (action, extra) => onBulk(action, ids, extra).then(onClear, () => {});
  // Like a spreadsheet status bar; refunds count negative, same as the list total.
  const sum = items.reduce((total, t) => total + transactionValue(t), 0);
  return <div className="bulk-bar" role="toolbar" aria-label="선택한 내역 일괄 작업">
    <div className="bulk-stats" role="status" aria-live="polite"><strong>{ids.length}건 선택</strong><span>합계 <b>{won(sum)}</b></span><span>평균 <b>{won(Math.round(sum / ids.length))}</b></span></div>
    <label className="bulk-category"><span className="sr-only">카테고리 일괄 변경</span><select value={category} disabled={busy || type === 'transfer'} onChange={e => setCategory(e.target.value)}><option value="">카테고리 변경…</option>{categories.filter(c => c.type === categoryType(type)).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
    <button className="button" disabled={busy || !category} onClick={() => run('category', { category }).then(() => setCategory(''))}>적용</button>
    {(moveTargets[type] || []).map(target => <button key={target} className="button" disabled={busy} onClick={() => run('move', { type: target })}>{toTypeLabel(target)} 옮기기</button>)}
    <button className="button danger" disabled={busy} onClick={() => run('delete')}>삭제</button>
    <button className="link-button" disabled={busy} onClick={onClear}>선택 해제</button>
  </div>;
}

const TRANSACTION_BATCH_SIZE = 30;
export function InfiniteTransactionList({ items, total, label, totalLabel = '조회 합계', pageScroll = false, onBulk, type, ...tableProps }) {
  const [limit, setLimit] = useState(TRANSACTION_BATCH_SIZE);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const anchorRef = useRef(null);
  // Rows deleted or moved out of this list drop out of the selection on their own.
  const selectedItems = items.filter(t => selectedIds.has(t.id));
  const ids = new Set(selectedItems.map(t => t.id));
  const clearSelection = () => { setSelectedIds(new Set()); anchorRef.current = null; };
  const selection = onBulk && {
    ids, count: ids.size, total: items.length,
    toggleAll: () => setSelectedIds(ids.size === items.length ? new Set() : new Set(items.map(t => t.id))),
    // Shift-click selects the range from the last clicked row, matching its checked state.
    toggle: (id, range) => {
      const index = items.findIndex(t => t.id === id), anchor = items.findIndex(t => t.id === anchorRef.current);
      const checked = !ids.has(id), next = new Set(ids);
      const span = range && anchor >= 0 ? items.slice(Math.min(anchor, index), Math.max(anchor, index) + 1) : [items[index]];
      for (const t of span) checked ? next.add(t.id) : next.delete(t.id);
      anchorRef.current = id;
      setSelectedIds(next);
    },
  };
  const scrollRef = useRef(null);
  const sentinelRef = useRef(null);
  const visibleCount = Math.min(limit, items.length);
  const hasMore = visibleCount < items.length;

  useEffect(() => {
    if (!hasMore || !sentinelRef.current || (!pageScroll && !scrollRef.current)) return;
    if (typeof IntersectionObserver === 'undefined') {
      setLimit(items.length);
      return;
    }
    // Page lists load near the viewport bottom; boxed lists use their scroll area.
    let active = true;
    const observer = new IntersectionObserver(entries => {
      if (!active || !entries.some(entry => entry.isIntersecting)) return;
      active = false;
      observer.disconnect();
      setLimit(value => Math.min(value + TRANSACTION_BATCH_SIZE, items.length));
    }, { root: pageScroll ? null : scrollRef.current, rootMargin: '0px 0px 200px 0px' });
    observer.observe(sentinelRef.current);
    return () => { active = false; observer.disconnect(); };
  }, [hasMore, limit, items.length, pageScroll]);

  return <>
    {selection && selectedItems.length > 0 && <BulkActionBar items={selectedItems} type={type} categories={tableProps.categories} busy={tableProps.busy} onBulk={onBulk} onClear={clearSelection} />}
    <TransactionTable {...tableProps} selection={selection} items={items.slice(0, visibleCount)} pageScroll={pageScroll} scrollRef={scrollRef} scrollLabel={pageScroll ? label : `${label} 스크롤 영역`} footer={
      <tfoot className="infinite-scroll-footer"><tr ref={sentinelRef}><td colSpan={selection ? 8 : 7}>{hasMore ? '아래로 스크롤하면 다음 내역이 이어집니다.' : '마지막 내역입니다.'}</td></tr></tfoot>
    } />
    <div className="ledger-list-summary"><span>총 {items.length}건 · {totalLabel} <strong>{won(total)}</strong></span><span role="status" aria-live="polite">{visibleCount} / {items.length}건 표시</span></div>
  </>;
}
export function TransactionForm({ entry, month, categories = defaultCategories, fixedExpenses, transactions, onSave, busy }) {
  const [form, setForm] = useState({
    amount: '', title: '', date: month === currentMonth() ? today() : `${month}-01`,
    category: entry.type === 'transfer' ? 'transfer' : categories.find(c => c.type === categoryType(entry.type))?.id, method: entry.type === 'expense' ? '신용카드' : '계좌이체',
    fixedExpenseId: null, isRefund: false, transferDirection: entry.type === 'transfer' ? 'out' : null, ...entry,
  });
  const [error, setError] = useState('');
  const set = (key, value) => setForm(f => ({ ...f, [key]: value }));
  const options = fixedExpenses.filter(f => f.month === form.date.slice(0, 7) && !transactions.some(t => t.fixedExpenseId === f.id && t.id !== entry.id));
  function submit(e) {
    e.preventDefault();
    const parsed = createTransactionSchema(categories).safeParse({ ...form, amount: Number(form.amount) });
    if (!parsed.success) { setError('내용, 날짜와 금액(1원 이상의 정수)을 확인해 주세요.'); return; }
    onSave(parsed.data, entry.id);
  }
  return <form onSubmit={submit} className="entry-form"><fieldset disabled={busy}>
    <div className="form-grid"><label>날짜<input type="date" min="1900-01-01" max="2100-12-31" required value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value, fixedExpenseId: f.date.slice(0, 7) === e.target.value.slice(0, 7) ? f.fixedExpenseId : null }))} /></label>
      <label>금액 (원)<input autoFocus type="number" required min="1" max="999999999999" step="1" value={form.amount} onChange={e => set('amount', e.target.value)} /></label></div>
    <label>{transactionTypes[form.type]} 내용<input required maxLength={100} placeholder={form.type === 'transfer' ? '계좌 이동, 카드대금 이체 등' : form.type === 'saving' ? '적금, 저축 계좌 입금 등' : form.type === 'income' ? '급여, 부수입 등' : '구매처 또는 지출 항목'} value={form.title} onChange={e => set('title', e.target.value)} /></label>
    {form.type === 'transfer' && <label>이체 방향<select value={form.transferDirection} onChange={e => set('transferDirection', e.target.value)}><option value="out">출금 (−)</option><option value="in">입금 (+)</option></select><small>해당 계좌 기준의 입출금입니다. 수입·지출 및 예산 사용액에 포함하지 않습니다.</small></label>}
    <div className="form-grid"><label>카테고리<select value={form.category} onChange={e => set('category', e.target.value)}>{(form.type === 'transfer' ? [transferCategory] : categories.filter(c => c.type === categoryType(form.type))).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>{form.type === 'transfer' || form.type === 'saving' ? '계좌·수단' : form.type === 'income' ? '입금 수단' : '결제 수단'}<input list="payment-methods" required maxLength={100} value={form.method} onChange={e => set('method', e.target.value)} /><datalist id="payment-methods">{methods.map(m => <option key={m} value={m} />)}</datalist></label></div>
    {form.type !== 'transfer' && <label className="checkbox-label"><input type="checkbox" checked={form.isRefund} onChange={e => setForm(f => ({ ...f, isRefund: e.target.checked, fixedExpenseId: e.target.checked ? null : f.fixedExpenseId }))} />{refundLabel(form.type, form.importSource)} 내역 ({transactionTypes[form.type]} 합계에서 차감)</label>}
    {form.type === 'expense' && !form.isRefund && <label>고정지출 연결<select value={form.fixedExpenseId || ''} onChange={e => set('fixedExpenseId', e.target.value || null)}><option value="">연결하지 않음 (일반 지출)</option>{options.map(f => <option key={f.id} value={f.id}>{f.title} · 예정 {won(f.amount)}</option>)}</select><small>연결하면 해당 월의 고정지출이 지급 완료로 표시됩니다.</small></label>}
    {form.importSource && <div className="import-provenance"><strong>엑셀 원본</strong><p>{form.importSource.fileName} · 두 번째 시트 · {form.importSource.row}행</p><p>{form.importSource.category} / {form.importSource.subcategory} · {form.importSource.time}</p></div>}
    {error && <p className="error-text" role="alert">{error}</p>}
    <button className="button primary full" type="submit">{busy ? '저장 중…' : entry.id ? '변경사항 저장' : `${transactionTypes[form.type]} 등록`}</button>
  </fieldset></form>;
}
export function FixedForm({ item, month, categories = defaultCategories, onSave, busy }) {
  const [form, setForm] = useState(item || { month, title: '', amount: '', day: 1, category: categories.find(c => c.id === 'home')?.id || categories.find(c => c.type === 'expense')?.id, method: '계좌이체' });
  const [error, setError] = useState('');
  const set = (key, value) => setForm(f => ({ ...f, [key]: value }));
  return <form className="entry-form" onSubmit={e => {
    e.preventDefault();
    const parsed = createFixedExpenseSchema(categories).safeParse({ ...form, amount: Number(form.amount), day: Number(form.day) });
    if (!parsed.success) { setError('항목명, 예정 금액과 지급일(1~31일)을 확인해 주세요.'); return; }
    onSave(parsed.data, item?.id);
  }}><fieldset disabled={busy}>
    <label>항목명<input autoFocus required maxLength={100} placeholder="월세, 보험료, 통신비 등" value={form.title} onChange={e => set('title', e.target.value)} /></label>
    <div className="form-grid"><label>예정 금액 (원)<input required type="number" min="1" max="999999999999" step="1" value={form.amount} onChange={e => set('amount', e.target.value)} /></label><label>지급 예정일 (일)<input required type="number" min="1" max="31" step="1" value={form.day} onChange={e => set('day', e.target.value)} /></label></div>
    <div className="form-grid"><label>카테고리<select value={form.category} onChange={e => set('category', e.target.value)}>{categories.filter(c => c.type === 'expense').map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>결제 수단<input required list="fixed-payment-methods" maxLength={100} value={form.method} onChange={e => set('method', e.target.value)} /><datalist id="fixed-payment-methods">{methods.map(m => <option key={m} value={m} />)}</datalist></label></div>
    <p className="help">선택한 달에만 적용됩니다. 해당 날짜가 없는 달에는 말일을 사용합니다. 예정 항목을 수정해도 이미 등록한 실제 지출은 바뀌지 않습니다.</p>
    {error && <p role="alert" className="error-text">{error}</p>}<button className="button primary full">{busy ? '저장 중…' : '고정지출 저장'}</button>
  </fieldset></form>;
}
export function BudgetForm({ amount, planned, onSave, busy }) {
  const [value, setValue] = useState(amount || '');
  return <form className="entry-form" onSubmit={e => { e.preventDefault(); onSave(Number(value)); }}><fieldset disabled={busy}>
    <label>월 총예산 (원)<input autoFocus required type="number" min="0" max="999999999999" step="1" value={value} onChange={e => setValue(e.target.value)} /></label>
    <p className="help">고정지출을 포함한 전체 지출 한도입니다. 0원은 예산 미설정으로 처리합니다.</p>
    <div className="calculation"><span>고정지출 예정액</span><strong>{won(planned)}</strong><span>일반 지출 배정 가능액</span><strong className={value && Number(value) < planned ? 'danger-text' : ''}>{value ? won(Number(value) - planned) : '—'}</strong></div>
    <button className="button primary full">{busy ? '저장 중…' : '예산 저장'}</button>
  </fieldset></form>;
}
