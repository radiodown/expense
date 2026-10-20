import { useState, useRef, lazy, Suspense } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Icon, Modal, Empty, Metric, TransactionTable, InfiniteTransactionList, TransactionForm, FixedForm, BudgetForm } from './components.jsx';
import { sortTransactions } from './transaction-sort.js';
import { categories as defaultCategories, transactionTypes, categoryType, transferSummary, fallbackCategory, today, currentMonth, monthLabel, shiftMonth, won, summary, trends, categoryTotals, categoryOf, makeDemo, backupSchema, budgetSummary, fixedDate, transactionValue } from '../shared/ledger.js';

const FlowChart = lazy(() => import('./Charts.jsx'));
const ImportPanel = lazy(() => import('./ImportPanel.jsx'));
const CategoryManager = lazy(() => import('./ManagementPanels.jsx').then(m => ({ default: m.CategoryManager })));
const CategoryBudgets = lazy(() => import('./ManagementPanels.jsx').then(m => ({ default: m.CategoryBudgets })));
const nav = [
  ['overview', '대시보드', 'LayoutDashboard'], ['income', '수입 내역', 'ArrowDownLeft'],
  ['expense', '지출 내역', 'ArrowUpRight'], ['saving', '저축 내역', 'PiggyBank'], ['transfer', '이체 내역', 'ArrowLeftRight'], ['budget', '예산 · 고정지출', 'Goal'],
  ['analytics', '월별 분석', 'ChartNoAxesCombined'], ['settings', '데이터 관리', 'Settings2'],
];
const shortLabels = { overview: '요약', income: '수입', expense: '지출', saving: '저축', transfer: '이체', budget: '예산', analytics: '분석', settings: '설정' };
const descriptions = {
  overview: '월별 수입·지출과 예산 집행 현황을 확인합니다.',
  income: '수입 내역을 등록하고 입금 항목별로 조회합니다.',
  expense: '실제 지출 내역을 등록하고 일반 지출과 고정지출을 구분합니다.',
  saving: '저축 내역을 따로 관리합니다. 저축은 지출 합계와 예산 사용액에서 제외됩니다.',
  transfer: '계좌별 이체 입출금을 확인합니다. 수입·지출 및 예산 사용액에는 포함하지 않습니다.',
  budget: '총예산과 카테고리별 한도, 고정지출 지급 현황을 관리합니다.',
  analytics: '최근 6개월 수입·지출·저축과 카테고리별 지출을 비교합니다.',
  settings: '카테고리 편집, 엑셀 가져오기 및 전체 데이터 백업을 관리합니다.',
};
async function api(path, method = 'GET', body) {
  const response = await fetch(`/api${path}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '요청에 실패했습니다.');
  return data;
}
function download(content, name, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Panel({ title, note, action, children }) {
  return <section className="panel"><div className="panel-heading"><div><h2>{title}</h2>{note && <p>{note}</p>}</div>{action}</div>{children}</section>;
}
function Chart({ data }) { return <Suspense fallback={<div className="chart-box loading">차트 불러오는 중…</div>}><FlowChart data={data} /></Suspense>; }
function FlowLegend() { return <div className="chart-legend"><span className="income">■ 수입</span><span className="expense">■ 지출</span><span className="saving">■ 저축</span></div>; }

export default function App() {
  const [view, setView] = useState('overview');
  const [month, setMonth] = useState(currentMonth);
  const [demo, setDemo] = useState(null);
  const [entry, setEntry] = useState(null);
  const [fixedEntry, setFixedEntry] = useState(null);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [restore, setRestore] = useState(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [kind, setKind] = useState('all');
  const [sort, setSort] = useState({ key: 'date', direction: 'desc' });
  const fileInput = useRef();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['ledger'], queryFn: () => api('/state') });
  const data = demo || query.data || { transactions: [], budgets: {}, fixedExpenses: [] };
  const categories = data.categories || defaultCategories;
  const fixedExpenses = data.fixedExpenses || [];
  const s = summary(data.transactions, month);
  const b = budgetSummary(data, month);
  const flow = trends(data.transactions, month);
  const cats = categoryTotals(s.items, categories);
  const previousSummary = summary(data.transactions, shiftMonth(month, -1));
  const comparisonType = view === 'saving' ? 'saving' : 'income';
  const previousAmount = previousSummary[comparisonType];
  const amountChange = s[comparisonType] - previousAmount;
  const hasPreviousAmount = previousSummary.items.some(t => t.type === comparisonType);
  const categoryShare = value => s.expense > 0 && value >= 0 ? `${(value / s.expense * 100).toFixed(1)}%` : '—';
  const sorted = [...s.items].sort((a, c) => c.date.localeCompare(a.date));
  const isLedger = ['income', 'expense', 'saving', 'transfer'].includes(view);
  const ledgerItems = sorted.filter(t => t.type === view);
  const filtered = sortTransactions(ledgerItems.filter(t =>
    (category === 'all' || t.category === category) &&
    (view !== 'expense' || kind === 'all' || (kind === 'fixed' ? !!t.fixedExpenseId : !t.fixedExpenseId)) &&
    (view !== 'transfer' || kind === 'all' || t.transferDirection === kind) &&
    `${t.title} ${categoryOf(t.category, categories).name} ${t.importSource?.category || ''} ${t.importSource?.subcategory || ''}`.toLowerCase().includes(search.toLowerCase())), sort, categories);
  const filteredTotal = filtered.reduce((sum, t) => sum + transactionValue(t), 0);
  const transferTotals = transferSummary(ledgerItems);
  const fixed = [...b.fixed].sort((a, c) => a.day - c.day || a.title.localeCompare(c.title));
  const pendingFixed = fixed.filter(f => !b.links.has(f.id));
  const budgetRatio = b.budget ? s.expense / b.budget * 100 : 0;

  function navigate(next) { setView(next); setSearch(''); setCategory('all'); setKind('all'); setSort({ key: 'date', direction: 'desc' }); }
  function sortColumn(key) {
    setSort(current => ({ key, direction: current.key === key ? current.direction === 'asc' ? 'desc' : 'asc' : key === 'date' || key === 'amount' ? 'desc' : 'asc' }));
  }
  function changeMonth(value) {
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(value) && value >= '1900-01' && value <= '2100-12') setMonth(value);
  }
  function toggleDemo() { setDemo(d => d ? null : makeDemo(month)); setSearch(''); setCategory('all'); setKind('all'); }
  const mutation = useMutation({
    mutationFn: async ({ action, payload, id, targetMonth }) => {
      if (demo) {
        if (action === 'save' && payload.fixedExpenseId && demo.transactions.some(t => t.fixedExpenseId === payload.fixedExpenseId && t.id !== id)) throw new Error('이미 지출로 반영된 항목입니다.');
        const generatedId = crypto.randomUUID();
        const copied = action === 'copyFixed' ? demo.fixedExpenses.filter(f => f.month === shiftMonth(targetMonth, -1)).map(f => ({ ...f, id: crypto.randomUUID(), month: targetMonth })) : [];
        if (action === 'copyFixed' && (!copied.length || demo.fixedExpenses.some(f => f.month === targetMonth))) throw new Error('지난달 항목이 있고 이번 달 항목이 비어 있을 때 복사할 수 있습니다.');
        if (action === 'saveCategory' && categories.some(c => c.id !== id && c.type === payload.type && c.name.toLowerCase() === payload.name.toLowerCase())) throw new Error('같은 이름의 카테고리가 있습니다.');
        const original = action === 'makeFixed' || action === 'move' ? demo.transactions.find(t => t.id === id) : null;
        if (action === 'makeFixed' && (!original || original.type !== 'expense' || original.isRefund || original.fixedExpenseId)) throw new Error('이미 연결되었거나 고정지출로 등록할 수 없는 내역입니다.');
        if (action === 'move' && (!original || !['expense', 'saving'].includes(payload.type) || original.type !== (payload.type === 'saving' ? 'expense' : 'saving'))) throw new Error('지출과 저축 내역 사이에서만 이동할 수 있습니다.');
        setDemo(d => {
          if (action === 'save') return { ...d, transactions: id ? d.transactions.map(t => t.id === id ? { ...payload, id } : t) : [{ ...payload, id: generatedId }, ...d.transactions] };
          if (action === 'delete') return { ...d, transactions: d.transactions.filter(t => t.id !== id) };
          if (action === 'move') return { ...d, transactions: d.transactions.map(t => t.id === id ? { ...t, type: payload.type, fixedExpenseId: null } : t) };
          if (action === 'budget') return { ...d, budgets: { ...d.budgets, [targetMonth]: payload.amount } };
          if (action === 'categoryBudgets') return { ...d, categoryBudgets: { ...d.categoryBudgets, [targetMonth]: payload.amounts } };
          if (action === 'saveCategory') return { ...d, categories: id ? d.categories.map(c => c.id === id ? { ...payload, id } : c) : [...d.categories, { ...payload, id: generatedId }] };
          if (action === 'deleteCategory') {
            const c = d.categories.find(c => c.id === id), fallback = fallbackCategory(c.type);
            if (id === fallback) return d;
            const categoryBudgets = Object.fromEntries(Object.entries(d.categoryBudgets).map(([m, amounts]) => {
              const merged = { ...amounts };
              if (merged[id] !== undefined) { merged[fallback] = (merged[fallback] || 0) + merged[id]; delete merged[id]; }
              return [m, merged];
            }));
            return { ...d, categoryBudgets, categories: d.categories.filter(c => c.id !== id), transactions: d.transactions.map(t => t.category === id ? { ...t, category: fallback } : t), fixedExpenses: d.fixedExpenses.map(f => f.category === id ? { ...f, category: fallback } : f) };
          }
          if (action === 'makeFixed') {
            const { title, amount, category, method, note, date } = original;
            return { ...d, fixedExpenses: [...d.fixedExpenses, { id: generatedId, title, amount, category, method, note, month: date.slice(0, 7), day: Number(date.slice(8)) }], transactions: d.transactions.map(t => t.id === id ? { ...t, fixedExpenseId: generatedId } : t) };
          }
          if (action === 'saveFixed') return { ...d, fixedExpenses: id ? d.fixedExpenses.map(f => f.id === id ? { ...payload, id } : f) : [...d.fixedExpenses, { ...payload, id: generatedId }] };
          if (action === 'deleteFixed') return { ...d, fixedExpenses: d.fixedExpenses.filter(f => f.id !== id), transactions: d.transactions.map(t => t.fixedExpenseId === id ? { ...t, fixedExpenseId: null } : t) };
          if (action === 'copyFixed') return { ...d, fixedExpenses: [...d.fixedExpenses, ...copied] };
          return d;
        });
        return;
      }
      if (action === 'save') return api(`/transactions${id ? `/${id}` : ''}`, id ? 'PUT' : 'POST', payload);
      if (action === 'delete') return api(`/transactions/${id}`, 'DELETE');
      if (action === 'move') return api(`/transactions/${id}/move`, 'POST', payload);
      if (action === 'budget') return api(`/budgets/${targetMonth}`, 'PUT', payload);
      if (action === 'categoryBudgets') return api(`/budgets/${targetMonth}/categories`, 'PUT', payload);
      if (action === 'saveCategory') return api(`/categories${id ? `/${id}` : ''}`, id ? 'PUT' : 'POST', payload);
      if (action === 'deleteCategory') return api(`/categories/${id}`, 'DELETE');
      if (action === 'makeFixed') return api(`/transactions/${id}/fixed-expense`, 'POST', {});
      if (action === 'saveFixed') return api(`/fixed-expenses${id ? `/${id}` : ''}`, id ? 'PUT' : 'POST', payload);
      if (action === 'deleteFixed') return api(`/fixed-expenses/${id}`, 'DELETE');
      if (action === 'copyFixed') return api(`/budgets/${targetMonth}/copy-fixed`, 'POST', {});
      if (action === 'restore') return api('/restore', 'POST', payload);
    },
    onSuccess: async (_result, { action, payload }) => {
      await client.invalidateQueries({ queryKey: ['ledger'] });
      setEntry(null); setFixedEntry(null); setBudgetOpen(false); setRestore(null);
      if (action === 'deleteCategory') setCategory('all');
      toast.success(demo ? '데모 데이터에 반영했습니다.' : action === 'move' ? payload.type === 'saving' ? '저축으로 이동했습니다.' : '지출로 되돌렸습니다.' : action === 'makeFixed' ? '고정지출로 등록하고 기존 지출을 지급 완료로 연결했습니다.' : action.startsWith('delete') ? '삭제했습니다.' : '변경사항을 저장했습니다.');
    },
    onError: error => toast.error(error.message),
  });
  const busy = mutation.isPending;
  const save = (action, payload, id) => mutation.mutate({ action, payload, id, targetMonth: month });
  function recordFixed(f) {
    const { id, title, amount, category: categoryId, method, note } = f;
    setEntry({ type: 'expense', title, amount, category: categoryId, method, note, date: fixedDate(f), fixedExpenseId: id });
  }
  async function exportBackup() {
    try { download(JSON.stringify(await api('/backup'), null, 2), `모아-백업-${today()}.json`, 'application/json'); }
    catch (error) { toast.error(error.message); }
  }
  async function chooseBackup(e) {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { toast.error('25MB 이하 파일을 선택해 주세요.'); return; }
    try { const parsed = backupSchema.safeParse(JSON.parse(await file.text())); if (!parsed.success) throw new Error(); setRestore(parsed.data); }
    catch { toast.error('올바른 모아 백업 파일이 아닙니다.'); }
  }
  const budgetAction = <button className="button" onClick={() => setBudgetOpen(true)}>{b.budget ? '총예산 수정' : '총예산 설정'}</button>;

  return <div className="app-shell">
    <aside className="sidebar"><div className="sidebar-title">가계부</div>
      <nav aria-label="주 메뉴">{nav.map(([id, label, icon]) => <button key={id} aria-label={label} aria-current={view === id ? 'page' : undefined} className={`nav-item ${view === id ? 'selected' : ''}`} onClick={() => navigate(id)}><Icon name={icon} size={20} /><span className="nav-label">{label}</span><span className="nav-label-short" aria-hidden="true">{shortLabels[id]}</span></button>)}</nav>
      <div className="sidebar-status">이 기기에 저장됨</div>
    </aside>
    <main><header className="page-heading"><div><h1>{nav.find(n => n[0] === view)?.[1]}</h1><p>{descriptions[view]}</p></div><div className="toolbar">
      {view === 'transfer' && <button className="button" onClick={() => navigate('settings')}>엑셀 가져오기</button>}
      {view === 'income' && <button className="button primary" onClick={() => setEntry({ type: 'income' })}><Icon name="Plus" />수입 등록</button>}
      {view === 'expense' && <button className="button primary" onClick={() => setEntry({ type: 'expense' })}><Icon name="Plus" />지출 등록</button>}
      {view === 'saving' && <button className="button primary" onClick={() => setEntry({ type: 'saving' })}><Icon name="Plus" />저축 등록</button>}
      {view === 'transfer' && <button className="button primary" onClick={() => setEntry({ type: 'transfer' })}><Icon name="Plus" />이체 등록</button>}
      {view === 'budget' && <button className="button primary" onClick={() => setFixedEntry({})}><Icon name="Plus" />고정지출 추가</button>}
    </div></header>
    {demo && <div className="notice"><span><strong>데모 모드</strong> · 예시 데이터입니다. 변경사항은 실제 가계부에 저장되지 않습니다.</span><button className="link-button" onClick={toggleDemo}>데모 종료</button></div>}
    {!demo && query.isPending ? <div className="loading" role="status">데이터를 불러오는 중…</div> : !demo && query.isError ? <div className="error-panel" role="alert"><h2>서버에 연결할 수 없습니다.</h2><p>백엔드 서버 실행 상태를 확인하세요.</p><button className="button" onClick={() => query.refetch()}>다시 시도</button></div> : <>
      {view !== 'settings' && <div className="period-row"><div className="month-control"><span>조회 월</span><button className="icon-button" aria-label="이전 달" disabled={month === '1900-01'} onClick={() => changeMonth(shiftMonth(month, -1))}><Icon name="ChevronLeft" /></button><input aria-label="조회 월" type="month" min="1900-01" max="2100-12" value={month} onChange={e => changeMonth(e.target.value)} /><button className="icon-button" aria-label="다음 달" disabled={month === '2100-12'} onClick={() => changeMonth(shiftMonth(month, 1))}><Icon name="ChevronRight" /></button><button className="button subtle" onClick={() => changeMonth(currentMonth())}>이번 달</button></div>
        {view === 'budget' && budgetAction}</div>}

      {view === 'overview' && <>
        <div className="metrics five"><Metric title="수입 합계" value={won(s.income)} note={`${s.items.filter(t => t.type === 'income').length}건`} tone="positive" /><Metric title="지출 합계" value={won(s.expense)} note={`${s.items.filter(t => t.type === 'expense').length}건`} /><Metric title="저축 합계" value={won(s.saving)} note={`${s.items.filter(t => t.type === 'saving').length}건 · 지출 제외`} tone="saving" /><Metric title="월 수지" value={won(s.balance)} note="해당 월 수입 − 지출 − 저축" tone={s.balance < 0 ? 'negative' : ''} /><Metric title="예산 잔액" value={b.budget ? won(b.remaining) : '미설정'} note={b.budget ? `실제 지출 기준 · 사용률 ${budgetRatio.toFixed(1)}%` : '예산 메뉴에서 총예산을 설정하세요.'} tone={b.budget && b.remaining < 0 ? 'negative' : 'emphasis'} /></div>
        <div className="overview-grid"><Panel title="예산 집행 현황" action={<button className="link-button" onClick={() => navigate('budget')}>예산 관리 →</button>}>
          <div className="panel-body"><div className="progress-label"><span>실제 지출 / 총예산</span><strong>{b.budget ? `${won(s.expense)} / ${won(b.budget)}` : '예산 미설정'}</strong></div><div className="progress-track"><span className={budgetRatio > 100 ? 'over' : ''} style={{ width: `${Math.max(0, Math.min(budgetRatio, 100))}%` }} /></div>
            <dl className="summary-list"><div><dt>고정지출 예정 합계</dt><dd>{won(b.planned)}</dd></div><div><dt>미지급 고정지출</dt><dd>{pendingFixed.length}건 / {won(b.pending)}</dd></div><div><dt>추가 사용 가능액</dt><dd className={b.budget && b.available < 0 ? 'danger-text' : ''}>{b.budget ? won(b.available) : '—'}</dd></div></dl>
            <p className="help">추가 사용 가능액 = 총예산 − 실제 지출 − 미지급 고정지출 예정액</p></div>
        </Panel><Panel title="미지급 고정지출" note="아직 실제 지출과 연결되지 않은 예정 항목" action={<span className="badge">{pendingFixed.length}건</span>}>
          {pendingFixed.length ? <div className="table-scroll"><table><thead><tr><th>예정일</th><th>항목</th><th className="number">예정 금액</th><th>처리</th></tr></thead><tbody>{pendingFixed.slice(0, 5).map(f => <tr key={f.id}><td className={fixedDate(f) < today() ? 'danger-text nowrap' : 'nowrap'}>{fixedDate(f)}</td><td>{f.title}</td><td className="number nowrap">{won(f.amount)}</td><td><button className="table-button" onClick={() => recordFixed(f)}>지출 등록</button></td></tr>)}</tbody></table></div> : <Empty text="미지급 고정지출이 없습니다." />}
          {pendingFixed.length > 5 && <button className="panel-footer-button" onClick={() => navigate('budget')}>미지급 {pendingFixed.length}건 전체 보기</button>}
        </Panel></div>
        <Panel title="최근 거래" note="선택한 달의 최근 8건" action={<div className="toolbar"><button className="link-button" onClick={() => navigate('income')}>수입 내역 →</button><button className="link-button" onClick={() => navigate('expense')}>지출 내역 →</button><button className="link-button" onClick={() => navigate('saving')}>저축 내역 →</button></div>}><TransactionTable items={sorted.slice(0, 8)} categories={categories} busy={busy} onEdit={setEntry} onDelete={item => save('delete', undefined, item.id)} onMakeFixed={item => save('makeFixed', undefined, item.id)} onMove={(item, type) => save('move', { type }, item.id)} /></Panel>
        <div className="overview-grid"><Panel title="월별 수입·지출·저축 추이" action={<FlowLegend />}><Chart data={flow} /></Panel><Panel title="카테고리별 지출" note="실제 지출 기준">{cats.length ? <div className="table-scroll"><table><thead><tr><th>카테고리</th><th className="number">지출</th><th className="number">비중</th></tr></thead><tbody>{cats.map(c => <tr key={c.id}><td>{c.name}</td><td className="number">{won(c.value)}</td><td className="number">{categoryShare(c.value)}</td></tr>)}</tbody></table></div> : <Empty />}</Panel></div>
      </>}

      {isLedger && <>
        {view === 'transfer' ? <div className="metrics three"><Metric title="월 이체 입금" value={won(transferTotals.incoming)} note="원본 계좌에 들어온 금액 · 필터 적용 전" /><Metric title="월 이체 출금" value={won(transferTotals.outgoing)} note="원본 계좌에서 나간 금액 · 필터 적용 전" /><Metric title="조회 이체 입출금 차액" value={won(filteredTotal)} note={`${filtered.length}건 · 입금 − 출금 · 수입·지출 합계 제외`} tone="emphasis" /></div> :
          <div className="metrics three"><Metric title={`월 ${transactionTypes[view]} 합계`} value={won(s[view])} note={`${ledgerItems.length}건 · 필터 적용 전`} tone={view === 'saving' ? 'saving' : ''} /><Metric title="조회 결과 합계" value={won(filteredTotal)} note={`${filtered.length}건 · 검색 및 필터 적용`} tone="emphasis" /><Metric title={view === 'expense' ? '고정지출 실지급액' : `전월 대비 ${transactionTypes[view]} 증감`} value={view === 'expense' ? won(b.paid) : hasPreviousAmount ? `${amountChange > 0 ? '+' : ''}${won(amountChange)}` : '비교 내역 없음'} note={view === 'expense' ? `일반 지출 ${won(b.variable)}` : hasPreviousAmount ? `전월 ${transactionTypes[view]} ${won(previousAmount)} · 월 전체 기준` : `전월 ${transactionTypes[view]} 내역을 등록하면 비교됩니다.`} /></div>}
        <Panel title={`${transactionTypes[view]} 목록`} action={<span className="badge">{filtered.length}건</span>}>
          <div className="filters"><label className="search-field"><span>검색</span><input placeholder="내용 또는 카테고리" value={search} onChange={e => setSearch(e.target.value)} /></label>{view !== 'transfer' && <label>카테고리<select value={category} onChange={e => setCategory(e.target.value)}><option value="all">전체 카테고리</option>{categories.filter(c => c.type === categoryType(view)).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
            {view === 'expense' && <label>지출 구분<select value={kind} onChange={e => setKind(e.target.value)}><option value="all">전체 지출</option><option value="fixed">고정지출</option><option value="variable">일반 지출</option></select></label>}
            {view === 'transfer' && <label>이체 방향<select value={kind} onChange={e => setKind(e.target.value)}><option value="all">입출금 전체</option><option value="in">입금</option><option value="out">출금</option></select></label>}
            {view === 'transfer' && <label>정렬<select value={sort.key} onChange={e => setSort({ key: e.target.value, direction: 'desc' })}><option value="date">최신순</option><option value="amount">금액 높은순</option></select></label>}<button className="button" onClick={() => { setSearch(''); setCategory('all'); setKind('all'); setSort({ key: 'date', direction: 'desc' }); }}>필터 초기화</button></div>
          <InfiniteTransactionList key={JSON.stringify([view, month, search, category, kind, sort, !!demo])} items={filtered} total={filteredTotal} totalLabel={view === 'transfer' ? '이체 입출금 차액' : '조회 합계'} label={`${transactionTypes[view]} 목록`} pageScroll={view !== 'transfer'} sort={sort} onSort={view === 'transfer' ? undefined : sortColumn} categories={categories} busy={busy} onEdit={setEntry} fixedExpenses={fixedExpenses} transactions={data.transactions} onInlineSave={view === 'transfer' ? undefined : (payload, id) => mutation.mutateAsync({ action: 'save', payload, id })} onDelete={item => save('delete', undefined, item.id)} onMakeFixed={item => save('makeFixed', undefined, item.id)} onMove={(item, type) => save('move', { type }, item.id)} />
        </Panel>
      </>}

      {view === 'budget' && <>
        <div className="metrics"><Metric title="월 총예산" value={b.budget ? won(b.budget) : '미설정'} note="고정지출 포함 전체 지출 한도" /><Metric title="고정지출 예정액" value={won(b.planned)} note={`${fixed.length}개 항목 · 미지급 ${pendingFixed.length}건`} /><Metric title="실제 지출" value={won(s.expense)} note={`고정 ${won(b.paid)} / 일반 ${won(b.variable)}`} /><Metric title="추가 사용 가능액" value={b.budget ? won(b.available) : '—'} note="총예산 − 실제 지출 − 미지급 예정액" tone={b.budget && b.available < 0 ? 'negative' : 'emphasis'} /></div>
        {b.budget > 0 && b.available < 0 && <div className="notice warning" role="status">예산 부족: 실제 지출과 미지급 고정지출을 합하면 총예산보다 <strong>{won(-b.available)}</strong> 많습니다.</div>}
        <Panel title="카테고리별 예산" note="조회 월의 카테고리별 예산을 직접 수정할 수 있습니다." action={<button className="link-button" onClick={() => navigate('settings')}>카테고리 편집 →</button>}>
          <Suspense fallback={<div className="loading">예산 불러오는 중…</div>}><CategoryBudgets key={`${month}:${JSON.stringify(data.categoryBudgets?.[month] || {})}:${categories.map(c => c.id).join(',')}`} categories={categories} amounts={data.categoryBudgets?.[month] || {}} items={s.items} fixed={fixed} totalBudget={b.budget} busy={busy} onSave={payload => save('categoryBudgets', payload)} /></Suspense>
        </Panel>
        <Panel title="고정지출 계획 및 지급 현황" note="월별로 관리합니다. 지난달 항목을 복사해 시작하거나 새 항목을 추가하세요." action={<button className="button" disabled={busy || fixed.length > 0 || !fixedExpenses.some(f => f.month === shiftMonth(month, -1))} title={fixed.length ? '중복 방지를 위해 고정지출이 없는 달에만 복사할 수 있습니다.' : '지난달 예정 항목을 이번 달에 복사합니다.'} onClick={() => save('copyFixed')}><Icon name="Copy" />지난달 항목 복사</button>}>
          <div className="table-scroll"><table><thead><tr><th>지급 예정일</th><th>항목</th><th>카테고리 / 수단</th><th className="number">예정 금액</th><th className="number">실제 지급액</th><th>상태</th><th>관리</th></tr></thead><tbody>{fixed.map(f => {
            const paid = b.links.get(f.id);
            return <tr key={f.id}><td className="nowrap">{fixedDate(f)}</td><td className="title-cell"><strong>{f.title}</strong></td><td className="nowrap">{categoryOf(f.category, categories).name}<small className="cell-note">{f.method}</small></td><td className="number nowrap">{won(f.amount)}</td><td className="number nowrap">{paid ? won(paid.amount) : '—'}</td><td><span className={`badge ${paid ? 'success' : fixedDate(f) < today() ? 'warning' : ''}`}>{paid ? '지급 완료' : fixedDate(f) < today() ? '예정일 경과' : '미지급'}</span>{paid && <small className="cell-note">{paid.date}</small>}</td><td><div className="row-actions"><button className="table-button" disabled={busy} onClick={() => paid ? setEntry(paid) : recordFixed(f)}>{paid ? '지출 보기' : '지출 등록'}</button><button className="table-button" disabled={busy} aria-label={`${f.title} 예정 항목 수정`} onClick={() => setFixedEntry(f)}>수정</button><button className="table-button danger-text" disabled={busy} aria-label={`${f.title} 예정 항목 삭제`} onClick={() => save('deleteFixed', undefined, f.id)}>삭제</button></div></td></tr>;
          })}</tbody>{fixed.length > 0 && <tfoot><tr><th colSpan={3}>합계 · {fixed.length}개 항목</th><td className="number">{won(b.planned)}</td><td className="number">{won(b.paid)}</td><td colSpan={2}>미지급 예정액 {won(b.pending)}</td></tr></tfoot>}</table></div>
          {!fixed.length && <Empty text="고정지출 항목이 없습니다. 월세, 보험료, 통신비 등을 추가하세요." />}
          <div className="panel-note">예정 금액은 실제 지출에 자동으로 합산되지 않습니다. 지급 후 ‘지출 등록’으로 연결하거나, 기존 지출을 수정해 고정지출 항목에 연결하세요. 이미 지급한 항목은 중복 연결할 수 없습니다.</div>
        </Panel>
        <Panel title="예산 구성" note="계획과 실제 지출을 분리하여 표시합니다." action={budgetAction}><div className="budget-breakdown">
          <div><span>총예산</span><strong>{b.budget ? won(b.budget) : '미설정'}</strong></div><div><span>고정지출 배정액</span><strong>{won(b.planned)}</strong></div><div><span>일반 지출 배정 가능액</span><strong className={b.budget && b.variableBudget < 0 ? 'danger-text' : ''}>{b.budget ? won(b.variableBudget) : '—'}</strong></div><div><span>실제 지출 후 예산 잔액</span><strong className={b.budget && b.remaining < 0 ? 'danger-text' : ''}>{b.budget ? won(b.remaining) : '—'}</strong></div>
        </div></Panel>
      </>}

      {view === 'analytics' && <>
        <Panel title="최근 6개월 실적" note={`${monthLabel(flow[0].key)} ~ ${monthLabel(month)}`} action={<FlowLegend />}><Chart data={flow} /><div className="table-scroll"><table><thead><tr><th>월</th><th className="number">수입</th><th className="number">지출</th><th className="number">저축</th><th className="number">월 수지</th><th className="number">예산</th><th className="number">예산 잔액</th></tr></thead><tbody>{flow.map(f => <tr key={f.key}><td>{monthLabel(f.key)}</td><td className="number income">{won(f.income)}</td><td className="number">{won(f.expense)}</td><td className="number saving">{won(f.saving)}</td><td className={`number ${f.balance < 0 ? 'danger-text' : ''}`}>{won(f.balance)}</td><td className="number">{data.budgets[f.key] ? won(data.budgets[f.key]) : '—'}</td><td className="number">{data.budgets[f.key] ? won(data.budgets[f.key] - f.expense) : '—'}</td></tr>)}</tbody></table></div></Panel>
        <Panel title="카테고리별 지출 상세" note="선택한 달의 실제 지출 기준">{cats.length ? <div className="table-scroll"><table><thead><tr><th>카테고리</th><th className="number">건수</th><th className="number">지출 금액</th><th className="number">비중</th></tr></thead><tbody>{cats.map(c => <tr key={c.id}><td>{c.name}</td><td className="number">{s.items.filter(t => t.type === 'expense' && t.category === c.id).length}</td><td className="number">{won(c.value)}</td><td className="number">{categoryShare(c.value)}</td></tr>)}</tbody></table></div> : <Empty />}</Panel>
      </>}

      {view === 'settings' && <>
        <Suspense fallback={<div className="loading">카테고리 불러오는 중…</div>}><CategoryManager categories={categories} transactions={data.transactions} busy={busy} onSave={(payload, id) => mutation.mutateAsync({ action: 'saveCategory', payload, id })} onDelete={item => save('deleteCategory', undefined, item.id)} /></Suspense>
        <Suspense fallback={<div className="loading">엑셀 가져오기 준비 중…</div>}><ImportPanel request={api} categories={categories} demo={!!demo} onImported={() => client.invalidateQueries({ queryKey: ['ledger'] })} /></Suspense>
        <Panel title="데이터 저장 및 백업"><div className="panel-body"><p>기록은 이 컴퓨터의 <code>data/ledger.sqlite</code>에 저장됩니다. Windows와 Mac 간 이동 시 JSON 백업을 이용하세요.</p><div className="storage-stats"><span>거래 <strong>{query.data?.transactions.length || 0}건</strong></span><span>고정지출 예정 항목 <strong>{query.data?.fixedExpenses?.length || 0}건</strong></span></div>
          <div className="setting-row"><div><h3>전체 백업</h3><p>모든 거래, 카테고리, 월별·카테고리별 예산, 고정지출 항목과 연결 정보를 포함합니다.</p></div><button className="button" disabled={!!demo} onClick={exportBackup}><Icon name="Download" />JSON 백업</button></div>
          <div className="setting-row"><div><h3>백업 복원</h3><p>현재 전체 데이터를 백업 내용으로 교체합니다. 이전 버전 백업도 지원합니다.</p></div><button className="button" disabled={!!demo} onClick={() => fileInput.current.click()}>백업 파일 선택</button><input hidden ref={fileInput} type="file" accept=".json,application/json" onChange={chooseBackup} /></div>{demo && <p className="help">백업과 복원은 데모 종료 후 사용할 수 있습니다.</p>}
        </div></Panel>
        <Panel title="데모 데이터"><div className="setting-row panel-body"><p>실제 데이터를 변경하지 않고 수입·지출·저축, 예산 및 고정지출 기능을 확인합니다.</p><button className="button" onClick={() => { toggleDemo(); navigate('overview'); }}>{demo ? '데모 종료' : '데모 시작'}</button></div></Panel>
      </>}
    </>}
    <footer>로컬 저장 · 수입·지출·저축 별도 집계 · 이체 제외 <span>금액 단위: 원 (KRW)</span></footer>
    </main>
    <Modal open={!!entry} onClose={() => setEntry(null)} busy={busy} title={`${transactionTypes[entry?.type] || '거래'} ${entry?.id ? '수정' : '등록'}`} description={demo ? '데모 데이터에만 반영됩니다.' : entry?.type === 'transfer' ? '계좌 기준 이체 방향과 금액을 입력하세요.' : entry?.type === 'saving' ? '저축 날짜, 금액과 계좌를 입력하세요.' : '실제 입금 또는 지출 내역을 입력하세요.'}>{entry && <TransactionForm entry={entry} month={month} categories={categories} fixedExpenses={fixedExpenses} transactions={data.transactions} busy={busy} onSave={(payload, id) => save('save', payload, id)} />}</Modal>
    <Modal open={fixedEntry !== null} onClose={() => setFixedEntry(null)} busy={busy} title={`고정지출 ${fixedEntry?.id ? '수정' : '추가'}`} description={`${monthLabel(month)} 지출 계획`}>{fixedEntry !== null && <FixedForm item={fixedEntry.id ? fixedEntry : null} month={month} categories={categories} busy={busy} onSave={(payload, id) => save('saveFixed', payload, id)} />}</Modal>
    <Modal open={budgetOpen} onClose={() => setBudgetOpen(false)} busy={busy} title="월 총예산 설정" description={monthLabel(month)}>{budgetOpen && <BudgetForm amount={b.budget} planned={b.planned} busy={busy} onSave={amount => save('budget', { amount })} />}</Modal>
    <Modal open={!!restore} onClose={() => setRestore(null)} busy={busy} title="전체 데이터를 복원할까요?" description="현재 거래, 예산 및 고정지출 항목 전체가 교체됩니다. 필요한 데이터는 먼저 백업하세요.">
      <p>거래 {restore?.transactions.length}건 · 월별 예산 {Object.keys(restore?.budgets || {}).length}개 · 고정지출 {restore?.fixedExpenses.length}개</p><div className="modal-actions"><button className="button" disabled={busy} onClick={() => setRestore(null)}>취소</button><button className="button danger" disabled={busy} onClick={() => save('restore', restore)}>교체하고 복원</button></div>
    </Modal>
  </div>;
}
