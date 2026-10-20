import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Icon, Empty } from './components.jsx';
import { won, monthLabel, transactionValue, transactionLabel, categoryOf } from '../shared/ledger.js';

function base64File(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('선택한 파일을 읽지 못했습니다.'));
    reader.readAsDataURL(file);
  });
}
export default function ImportPanel({ request, categories, demo, onImported }) {
  const filesQuery = useQuery({ queryKey: ['import-files'], queryFn: () => request('/imports/files') });
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState([]);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const input = useRef();
  const files = filesQuery.data?.files || [];
  const activeFile = fileName || files[0] || '';
  const selectedMonths = preview?.months.filter(m => selected.includes(m.month)) || [];
  const count = selectedMonths.reduce((s, m) => s + m.available, 0);
  const income = selectedMonths.reduce((s, m) => s + m.income, 0);
  const expense = selectedMonths.reduce((s, m) => s + m.expense, 0);
  const transferCount = selectedMonths.reduce((s, m) => s + m.transferCount, 0);
  const duplicates = selectedMonths.reduce((s, m) => s + m.duplicates, 0);
  const records = preview?.records.filter(r => selected.includes(r.month)) || [];
  const excluded = preview?.skipped.filter(r => !r.month || selected.includes(r.month)) || [];
  function select(month) {
    setSelected(s => s.includes(month) ? s.filter(m => m !== month) : [...s, month]); setPage(1);
  }
  async function load(payload) {
    setBusy(true); setError(''); setPreview(null); setResult(null); setSelected([]); setPage(1);
    try { setPreview(await request('/imports/preview', 'POST', payload)); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function upload(e) {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name) || file.size > 10 * 1024 * 1024) {
      setPreview(null); setSelected([]); setResult(null); setError('10MB 이하의 XLSX 파일을 선택해 주세요.'); return;
    }
    setBusy(true); setPreview(null); setSelected([]); setResult(null); setError('');
    try { await load({ fileName: file.name, content: await base64File(file) }); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function commit() {
    setBusy(true); setError('');
    try {
      const imported = await request('/imports/commit', 'POST', { previewId: preview.previewId, months: selected });
      setResult(imported);
      // A submitted preview is discarded so the displayed "new" counts cannot be reused accidentally.
      setPreview(null); setSelected([]);
      await onImported();
      toast.success(`${imported.imported}건을 가져왔습니다.`);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <section className="panel" id="xlsx-import">
    <div className="panel-heading"><div><h2>엑셀 수입·지출 가져오기</h2><p>두 번째 시트의 수입과 지출을 읽습니다. 이체 내역도 지출에 포함하며, 가져올 월을 여러 개 선택할 수 있습니다.</p></div></div>
    <div className="panel-body">
      {demo && <p className="notice">실제 데이터 가져오기는 데모를 종료한 후 사용할 수 있습니다.</p>}
      <fieldset className="import-source" disabled={busy || demo}>
        <label>sample 폴더의 XLSX<select value={activeFile} onChange={e => setFileName(e.target.value)} aria-label="가져올 엑셀 파일">{!files.length && <option value="">사용 가능한 파일 없음</option>}{files.map(f => <option key={f} value={f}>{f}</option>)}</select></label>
        <button className="button" disabled={!activeFile} onClick={() => load({ fileName: activeFile })}>파일 읽기</button>
        <button className="button subtle" onClick={() => filesQuery.refetch()}>목록 새로고침</button>
        <button className="button" onClick={() => input.current.click()}>다른 XLSX 파일 선택</button>
        <input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={upload} />
      </fieldset>
      <p className="help import-help">파일은 이 컴퓨터에서만 처리됩니다. 기존 기록에 추가하며, 이미 가져온 동일 내역은 건너뜁니다.</p>
      {filesQuery.isError && <p className="error-text" role="alert">파일 목록을 읽지 못했습니다. 목록을 새로고침하세요.</p>}
      {busy && <p className="import-status" role="status">파일을 처리하고 있습니다…</p>}
      {error && <p className="error-text import-status" role="alert">{error}</p>}
      {result && <div className="notice import-result" role="status"><div><strong>{result.imported}건 가져오기 완료</strong><p>{result.months.map(monthLabel).join(', ')}</p><p>수입 {result.income}건 · 지출 {result.expense}건 (이체 {result.transfer}건 포함) · 기존 중복 {result.duplicates}건 제외 · 기타 제외 {result.excluded}건</p></div></div>}
    </div>
    {preview && <>
      <div className="import-subheading"><div><h3>{preview.fileName}</h3><p className="help">두 번째 시트 · 수입·지출을 가져오며 이체는 지출에 포함합니다. 고정지출 예산 항목은 자동 생성하지 않습니다.</p></div></div>
      <div className="import-rules">{preview.reasons.length > 0 && <p>파일 전체 제외 내역: {preview.reasons.map(r => `${r.reason} ${r.count}건`).join(' · ')}</p>}<p>지출의 음수 금액은 지출액으로, 양수 금액은 취소·환급으로 읽습니다. 환급은 지출 합계에서 차감됩니다.</p><p>이체도 지출 목록과 합계에 포함합니다. 음수는 출금으로 지출에 더하고, 양수는 입금으로 지출에서 차감합니다.</p><p>원본 분류는 아래 미리보기와 가져온 거래에 보존됩니다. 수입·지출에서 알 수 없는 분류는 기타 수입·지출로 연결됩니다.</p></div>
      <fieldset className="import-preview" disabled={busy || demo}>
        <div className="import-subheading"><h3>가져올 월 선택</h3><div className="toolbar"><button className="link-button" onClick={() => { setSelected(preview.months.filter(m => m.available > 0).map(m => m.month)); setPage(1); }}>전체 선택</button><button className="link-button" onClick={() => { setSelected([]); setPage(1); }}>선택 해제</button></div></div>
        <div className="table-scroll"><table className="month-import-table"><thead><tr><th>선택</th><th>월</th><th className="number">새 수입</th><th className="number">수입 합계</th><th className="number">새 지출</th><th className="number">지출 합계</th><th className="number">환급 포함</th><th className="number">기존 중복</th><th className="number">제외</th></tr></thead><tbody>{preview.months.map(m => <tr key={m.month} className={selected.includes(m.month) ? 'selected-row' : ''}><td><input type="checkbox" aria-label={`${monthLabel(m.month)} 가져오기`} checked={selected.includes(m.month)} disabled={!m.available} onChange={() => select(m.month)} /></td><td className="nowrap"><label className="month-choice"><button className="link-button" disabled={!m.available} onClick={() => select(m.month)}>{monthLabel(m.month)}</button></label></td><td className="number">{m.incomeCount}건</td><td className="number income">{won(m.income)}</td><td className="number">{m.expenseCount}건{m.transferCount > 0 && <small className="cell-note">이체 {m.transferCount}건 포함</small>}</td><td className="number">{won(m.expense)}</td><td className="number">{m.refunds}건</td><td className="number">{m.duplicates}건</td><td className="number">{m.skipped}건</td></tr>)}</tbody></table></div>
        {!preview.months.length && <Empty text="가져올 수 있는 월별 내역이 없습니다. 시트 내용과 제외 사유를 확인해 주세요." />}
        <div className="import-selection"><div><strong>{selected.length}개월 · 신규 {count}건 선택</strong><p>수입 {won(income)} · 지출 {won(expense)} · 중복 제외 {duplicates}건</p><p>지출에 이체 {transferCount}건 포함</p></div><button className="button primary" disabled={!count} onClick={commit}><Icon name="Plus" />선택한 월 가져오기</button></div>
      </fieldset>
      <div className="import-subheading"><h3>선택한 월 미리보기</h3><span className="help">저장 전 원본 내역을 확인하세요.</span></div>
      {records.length ? <><div className="table-scroll"><table><thead><tr><th>엑셀 행</th><th>날짜</th><th>구분</th><th>내용</th><th>원본 분류 → 적용 분류</th><th>결제수단</th><th className="number">금액</th><th>처리</th></tr></thead><tbody>{records.slice((page - 1) * 20, page * 20).map(r => {
        const t = r.transaction;
        return <tr key={t.importKey}><td>{r.row}</td><td className="nowrap">{t.date}</td><td className="nowrap">{transactionLabel(t)}{t.isRefund && t.importSource?.type !== '이체' && ' 취소·환급'}</td><td className="title-cell">{t.title}</td><td>{[t.importSource.category, t.importSource.subcategory].filter(Boolean).join(' / ')}<small className="cell-note">→ {categoryOf(t.category, categories).name}</small></td><td>{t.method}</td><td className="number nowrap">{won(transactionValue(t))}</td><td><span className={`badge ${r.duplicate ? '' : 'income'}`}>{r.duplicate ? '중복 제외' : '추가 예정'}</span></td></tr>;
      })}</tbody></table></div><div className="pagination"><span>총 {records.length}건</span><div><button className="icon-button" aria-label="미리보기 이전 페이지" disabled={page === 1} onClick={() => setPage(p => p - 1)}><Icon name="ChevronLeft" /></button><span>{page} / {Math.ceil(records.length / 20)}</span><button className="icon-button" aria-label="미리보기 다음 페이지" disabled={page * 20 >= records.length} onClick={() => setPage(p => p + 1)}><Icon name="ChevronRight" /></button></div></div></> : <Empty text="위 목록에서 가져올 월을 선택하세요." />}
      {excluded.length > 0 && <details className="import-excluded"><summary>선택한 월 및 날짜 확인 불가 행의 제외 사유 ({excluded.length}건)</summary><div className="table-scroll"><table><thead><tr><th>엑셀 행</th><th>월</th><th>제외 사유</th></tr></thead><tbody>{excluded.map((r, i) => <tr key={`${r.row}-${i}`}><td>{r.row}</td><td>{r.month || '확인 불가'}</td><td>{r.reason}</td></tr>)}</tbody></table></div></details>}
    </>}
  </section>;
}
