import { useId, useRef, useState } from 'react';
import { createTransactionSchema, methods, transactionTypes, won } from '../shared/ledger.js';

export default function InlineTransactionRow({ transaction, categories, fixedExpenses, transactions, onSave, onClose, busy }) {
  const [draft, setDraft] = useState({ ...transaction, isRefund: !!transaction.isRefund, fixedExpenseId: transaction.fixedExpenseId || null });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const formId = useId();
  const locked = busy || saving;
  const field = { form: formId, disabled: locked };
  const set = (key, value) => { setDraft(d => ({ ...d, [key]: value })); setError(''); };
  const options = fixedExpenses.filter(f => f.month === draft.date.slice(0, 7) && !transactions.some(t => t.fixedExpenseId === f.id && t.id !== transaction.id));

  async function submit(event) {
    event.preventDefault();
    if (locked || submitting.current) return;
    const parsed = createTransactionSchema(categories).safeParse({ ...draft, amount: Number(draft.amount) });
    if (!parsed.success) { setError('날짜, 내용, 카테고리, 수단과 금액(1원 이상의 정수)을 확인해 주세요.'); return; }
    setError(''); setSaving(true); submitting.current = true;
    let saved = false;
    try {
      await onSave(parsed.data, transaction.id);
      saved = true;
    } catch (e) {
      setError(e.message || '저장하지 못했습니다. 입력 내용을 확인하고 다시 시도해 주세요.');
    } finally {
      submitting.current = false; setSaving(false);
    }
    if (saved) onClose();
  }
  function keyDown(event) {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!locked) onClose();
    }
  }

  return <>
    <tr className="inline-edit-row" onKeyDown={keyDown}>
      <td><input {...field} className="inline-date" aria-label="날짜" type="date" required min="1900-01-01" max="2100-12-31" value={draft.date} onChange={e => {
        const date = e.target.value;
        setDraft(d => ({ ...d, date, fixedExpenseId: d.date.slice(0, 7) === date.slice(0, 7) ? d.fixedExpenseId : null })); setError('');
      }} /></td>
      <td><span className={`badge ${draft.type}`}>{draft.fixedExpenseId ? '고정지출' : transactionTypes[draft.type]}</span>
        <label className="inline-refund"><input {...field} type="checkbox" checked={draft.isRefund} onChange={e => {
          const checked = e.target.checked;
          setDraft(d => ({ ...d, isRefund: checked, fixedExpenseId: checked ? null : d.fixedExpenseId })); setError('');
        }} />취소·환급</label>
      </td>
      <td><input {...field} className="inline-title" aria-label="내용" autoFocus required maxLength={100} value={draft.title} onChange={e => set('title', e.target.value)} /></td>
      <td><select {...field} className="inline-category" aria-label="카테고리" value={draft.category} onChange={e => set('category', e.target.value)}>
        {categories.filter(c => c.type === draft.type).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select></td>
      <td><input {...field} className="inline-method" aria-label={draft.type === 'income' ? '입금 수단' : '결제 수단'} required maxLength={100} list={`${formId}-methods`} value={draft.method} onChange={e => set('method', e.target.value)} />
        <datalist id={`${formId}-methods`}>{methods.map(method => <option key={method} value={method} />)}</datalist>
      </td>
      <td><input {...field} className="inline-amount" aria-label="금액 (원)" type="number" required min="1" max="999999999999" step="1" value={draft.amount} onChange={e => set('amount', e.target.value)} /></td>
      <td><form id={formId} className="inline-row-actions" aria-label={`${transactionTypes[draft.type]} 행 수정`} onSubmit={submit}>
        <button type="submit" className="table-button primary" disabled={locked}>{locked ? '저장 중…' : '저장'}</button>
        <button type="button" className="table-button" disabled={locked} onClick={onClose}>취소</button>
      </form></td>
    </tr>
    <tr className="inline-edit-details" onKeyDown={keyDown}><td colSpan={7}>
      <div className="inline-detail-content">
        {draft.type === 'expense' && !draft.isRefund && <label>고정지출 연결
          <select {...field} value={draft.fixedExpenseId || ''} onChange={e => set('fixedExpenseId', e.target.value || null)}>
            <option value="">연결하지 않음 (일반 지출)</option>
            {options.map(f => <option key={f.id} value={f.id}>{f.title} · 예정 {won(f.amount)}</option>)}
          </select>
        </label>}
        {draft.importSource && <span className="help">원본: {draft.importSource.fileName} · {draft.importSource.row}행 · {[draft.importSource.category, draft.importSource.subcategory].filter(Boolean).join(' / ')}</span>}
        <span className="help">Enter로 저장 · Esc로 취소</span>
      </div>
      {error && <p className="error-text inline-edit-error" role="alert">{error}</p>}
    </td></tr>
  </>;
}
