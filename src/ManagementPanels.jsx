import { useState } from 'react';
import { categorySchema, categoryBudgetSchema, fallbackCategory, transactionValue, won } from '../shared/ledger.js';

function CategoryRow({ category, count, onSave, onDelete, busy }) {
  const [name, setName] = useState(category.name);
  const reserved = category.id === fallbackCategory(category.type);
  return <form className="category-row" onSubmit={async e => { e.preventDefault(); try { await onSave({ ...category, name: name.trim() }, category.id); } catch { /* Mutation displays the server error. */ } }}>
    <label><span className="sr-only">{category.name} 이름</span><input required maxLength={40} value={name} disabled={busy} onChange={e => setName(e.target.value)} /></label>
    <span className="help category-count">{count}건{reserved && ' · 기본'}</span>
    <button className="table-button" disabled={busy || !name.trim() || name.trim() === category.name}>저장</button>
    <button type="button" className="table-button danger-text" disabled={busy || reserved} title={reserved ? '기본 카테고리는 이름만 수정할 수 있습니다.' : `${category.name} 삭제`} onClick={() => onDelete(category)}>삭제</button>
  </form>;
}

export function CategoryManager({ categories, transactions, onSave, onDelete, busy }) {
  const [type, setType] = useState('expense');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  return <section className="panel">
    <div className="panel-heading"><div><h2>카테고리 관리</h2><p>이름 변경은 모든 월에 반영됩니다. 삭제한 카테고리의 내역과 예산은 같은 구분의 기본 카테고리로 이동합니다.</p></div></div>
    <div className="panel-body">
      <form className="category-add" onSubmit={async e => {
        e.preventDefault(); setError('');
        const parsed = categorySchema.safeParse({ name, type });
        if (!parsed.success) { setError('카테고리 이름을 1~40자로 입력하세요.'); return; }
        try { await onSave(parsed.data); setName(''); } catch { /* Mutation displays the server error. */ }
      }}>
        <label>구분<select disabled={busy} value={type} onChange={e => setType(e.target.value)}><option value="expense">지출</option><option value="income">수입</option></select></label>
        <label>새 카테고리<input required maxLength={40} placeholder="예: 보험료, 구독료" disabled={busy} value={name} onChange={e => setName(e.target.value)} /></label>
        <button className="button" disabled={busy}>카테고리 추가</button>
      </form>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="category-groups">{['expense', 'income'].map(group => <div key={group}>
        <h3>{group === 'expense' ? '지출' : '수입'} 카테고리</h3>
        {categories.filter(c => c.type === group).map(c => <CategoryRow key={`${c.id}:${c.name}`} category={c} count={transactions.filter(t => t.category === c.id).length} onSave={onSave} onDelete={onDelete} busy={busy} />)}
      </div>)}</div>
    </div>
  </section>;
}

export function CategoryBudgets({ categories, amounts, items, fixed, totalBudget, onSave, busy }) {
  const [values, setValues] = useState(amounts);
  const [error, setError] = useState('');
  const expenseCategories = categories.filter(c => c.type === 'expense');
  const allocated = expenseCategories.reduce((sum, c) => sum + Number(values[c.id] || 0), 0);
  return <form className="category-budget-form" onSubmit={e => {
    e.preventDefault(); setError('');
    const amounts = Object.fromEntries(expenseCategories.filter(c => values[c.id] !== '' && values[c.id] !== undefined).map(c => [c.id, Number(values[c.id])]));
    const parsed = categoryBudgetSchema.safeParse({ amounts });
    if (!parsed.success) { setError('예산은 0원 이상의 정수로 입력하세요. 합계는 999,999,999,999원 이하로 설정하세요.'); return; }
    onSave(parsed.data);
  }}>
    <fieldset disabled={busy}>
      <div className="table-scroll"><table className="category-budget-table"><thead><tr><th>카테고리</th><th className="number">월 예산 (원)</th><th className="number">고정지출 예정</th><th className="number">실제 지출</th><th className="number">예산 잔액</th></tr></thead>
        <tbody>{expenseCategories.map(c => {
          const actual = items.filter(t => t.type === 'expense' && t.category === c.id).reduce((sum, t) => sum + transactionValue(t), 0);
          const planned = fixed.filter(f => f.category === c.id).reduce((sum, f) => sum + f.amount, 0);
          const value = values[c.id] ?? '';
          const remaining = value === '' ? null : Number(value) - actual;
          return <tr key={c.id}><td>{c.name}</td><td className="number"><input aria-label={`${c.name} 월 예산`} type="number" min="0" max="999999999999" step="1" placeholder="미설정" value={value} onChange={e => setValues(v => ({ ...v, [c.id]: e.target.value }))} /></td><td className="number nowrap">{won(planned)}</td><td className="number nowrap">{won(actual)}</td><td className={`number nowrap ${remaining !== null && remaining < 0 ? 'danger-text' : ''}`}>{remaining === null ? '—' : won(remaining)}</td></tr>;
        })}</tbody>
        <tfoot><tr><th>카테고리 예산 합계</th><td className="number nowrap">{won(allocated)}</td><td colSpan={3} className="number">{totalBudget ? `총예산 ${won(totalBudget)} · ${allocated > totalBudget ? '초과 배정' : '미배정'} ${won(Math.abs(totalBudget - allocated))}` : '월 총예산 미설정'}</td></tr></tfoot>
      </table></div>
      <div className="category-budget-footer"><p className="help">고정지출을 포함한 카테고리별 한도입니다. 빈칸은 미설정, 0원은 지출 한도 0원입니다. 월 총예산은 별도로 설정합니다.</p><button className="button primary">{busy ? '저장 중…' : '카테고리 예산 저장'}</button></div>
      {error && <p className="error-text panel-body" role="alert">{error}</p>}
      {totalBudget > 0 && allocated > totalBudget && <p className="error-text panel-body">카테고리 예산 합계가 총예산을 {won(allocated - totalBudget)} 초과합니다.</p>}
    </fieldset>
  </form>;
}
