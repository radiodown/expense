import { useMemo, useState } from 'react';
import { assetKinds, accountTypes, taxModes, assetSchema, assetSummary, maturityEstimate, isTermAsset, isDeferredAccount, MAX_ASSET_AMOUNT } from '../shared/assets.js';
import { today, won } from '../shared/ledger.js';
import { Empty, Metric } from './components.jsx';

const options = labels => Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>);
const taxRateLabel = policy => policy.taxMode === 'custom' ? `세율 ${policy.taxRate}%` : taxModes[policy.taxMode];

function PolicyDetails({ asset }) {
  const policy = asset.policy;
  const hasDetails = policy.name || policy.conditions || policy.sourceUrl || policy.checkedOn || policy.taxFreeAllowance || policy.grant;
  if (!hasDetails) return <span className="help">{taxRateLabel(policy)}</span>;
  return <details className="asset-policy"><summary>{policy.name || taxRateLabel(policy)}</summary><div>
    <p>{taxRateLabel(policy)}</p>
    {policy.taxFreeAllowance > 0 && <p>비과세 이자 한도 {won(policy.taxFreeAllowance)}</p>}
    {policy.grant > 0 && <p>만기 지원금 (세후) {won(policy.grant)}</p>}
    {policy.conditions && <p className="asset-policy-conditions">{policy.conditions}</p>}
    {policy.sourceUrl && <a href={policy.sourceUrl} target="_blank" rel="noreferrer">상품·정책 원문 ↗</a>}
    {policy.checkedOn && <p>확인일 {policy.checkedOn}</p>}
  </div></details>;
}

export default function AssetsPanel({ assets, busy, onEdit, onDelete }) {
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('all');
  const [accountType, setAccountType] = useState('all');
  const totals = assetSummary(assets);
  const filtered = assets.filter(asset => (kind === 'all' || asset.kind === kind) && (accountType === 'all' || asset.accountType === accountType) &&
    `${asset.name} ${asset.institution} ${asset.accountName}`.toLocaleLowerCase('ko').includes(search.toLocaleLowerCase('ko')))
    .sort((a, b) => Number(a.kind === 'loan') - Number(b.kind === 'loan') || b.balance - a.balance || a.name.localeCompare(b.name, 'ko'));
  const visibleTotals = assetSummary(filtered);
  const composition = Object.entries(assetKinds).filter(([key]) => key !== 'loan').map(([key, label], index) => ({ key, label, color: `var(--category-${index + 1})`, amount: assets.filter(asset => asset.kind === key).reduce((sum, asset) => sum + asset.balance, 0) })).filter(item => item.amount > 0).sort((a, b) => b.amount - a.amount);
  const grouped = Object.entries(accountTypes).map(([key, label]) => ({ key, label, ...assetSummary(assets.filter(asset => asset.accountType === key)), count: assets.filter(asset => asset.accountType === key).length })).filter(item => item.count > 0);
  return <>
    <div className="metrics">
      <Metric title="총자산" value={won(totals.total)} note="대출을 제외한 현재 잔고 합계" />
      <Metric title="대출 잔액" value={won(totals.debt)} note={`${assets.filter(asset => asset.kind === 'loan').length}개 대출 · 남은 원금`} />
      <Metric title="순자산" value={won(totals.net)} note="총자산 − 대출 잔액" tone={totals.net < 0 ? 'negative' : 'emphasis'} />
      <Metric title="예·적금 잔고" value={won(totals.deposits)} note="현재 납입액 · 만기 예상액 제외" />
    </div>
    <section className="panel"><div className="panel-heading"><div><h2>자산·대출 목록</h2><p>현재 잔고 기준으로 집계합니다. 주식·비트코인은 원화 평가잔고를 입력하세요.</p></div><span className="badge">{assets.length}개</span></div>
      <div className="filters">
        <label className="search-field">검색<input value={search} placeholder="상품, 금융기관 또는 계좌명" onChange={event => setSearch(event.target.value)} /></label>
        <label>자산 종류<select value={kind} onChange={event => setKind(event.target.value)}><option value="all">전체 자산·대출</option>{options(assetKinds)}</select></label>
        <label>계좌 구분<select value={accountType} onChange={event => setAccountType(event.target.value)}><option value="all">전체 계좌</option>{options(accountTypes)}</select></label>
        <button className="button" onClick={() => { setSearch(''); setKind('all'); setAccountType('all'); }}>필터 초기화</button>
      </div>
      {filtered.length ? <div className="table-scroll page-scroll-table"><table className="asset-table"><thead><tr><th>자산·상품 / 금융기관</th><th>종류</th><th>계좌 구분</th><th className="number">현재 잔고</th><th>잔고 기준일</th><th className="number">세후 만기 예상액</th><th>과세·상품 정책</th><th>관리</th></tr></thead><tbody>
        {filtered.map(asset => {
          const estimate = maturityEstimate(asset);
          return <tr key={asset.id}>
            <td className="title-cell"><strong>{asset.name}</strong><small className="cell-note">{[asset.institution, asset.accountName].filter(Boolean).join(' · ') || '—'}</small></td>
            <td className="nowrap"><span className={`badge ${asset.kind === 'loan' ? 'expense' : ''}`}>{assetKinds[asset.kind]}</span></td>
            <td className="nowrap">{accountTypes[asset.accountType]}</td><td className={`number nowrap ${asset.kind === 'loan' ? 'expense' : ''}`}>{won(asset.balance)}</td><td className="nowrap">{asset.asOf}</td>
            <td className="number nowrap">{estimate ? <><strong>{estimate.net === null ? asset.policy.taxMode === 'deferred' ? '계좌 정산 후 입력' : '과세 조건 미설정' : won(estimate.net)}</strong><small className="cell-note">{estimate.dueDate} 만기{estimate.mode === 'manual' ? ' · 직접 입력' : ''}</small></> : '—'}</td>
            <td><PolicyDetails asset={asset} /></td><td><div className="row-actions"><button className="table-button" disabled={busy} aria-label={`${asset.name} 수정`} onClick={() => onEdit(asset)}>수정</button><button className="table-button danger-text" disabled={busy} aria-label={`${asset.name} 삭제`} onClick={() => onDelete(asset)}>삭제</button></div></td>
          </tr>;
        })}
      </tbody></table></div> : <Empty text={assets.length ? '조건에 맞는 자산이 없습니다.' : '등록된 자산이 없습니다. 자산·대출 등록으로 현재 잔고를 입력하세요.'} />}
      <div className="ledger-list-summary"><span>조회 {filtered.length}개 · 자산 {won(visibleTotals.total)} · 대출 {won(visibleTotals.debt)}</span><strong>조회 순자산 {won(visibleTotals.net)}</strong></div>
      <div className="panel-note">잔고는 가계부 내역과 별도로 직접 갱신합니다. 계좌 안의 상품별 잔고를 등록했다면 같은 계좌의 전체 잔고를 중복 등록하지 마세요. 만기 예상액·지원금은 현재 자산 합계에 포함되지 않습니다.</div>
    </section>
    <div className="overview-grid">
      <section className="panel"><div className="panel-heading"><div><h2>자산 구성</h2><p>대출 제외 · 현재 잔고 기준</p></div></div>
        {composition.length ? <div className="asset-composition">{composition.map(item => <div key={item.key}><div><span>{item.label}</span><strong>{won(item.amount)} <small>{totals.total ? (item.amount / totals.total * 100).toFixed(1) : 0}%</small></strong></div><div className="asset-composition-track"><span style={{ width: `${item.amount / totals.total * 100}%`, background: item.color }} /></div></div>)}</div> : <Empty text="등록된 자산 잔고가 없습니다." />}
      </section>
      <section className="panel"><div className="panel-heading"><div><h2>계좌 구분별 잔고</h2><p>ISA·IRP 등 계좌 유형별 현재 규모</p></div></div>
        {grouped.length ? <div className="table-scroll page-scroll-table"><table><thead><tr><th>계좌 구분</th><th className="number">자산</th><th className="number">대출</th><th className="number">순자산</th></tr></thead><tbody>{grouped.map(group => <tr key={group.key}><td className="nowrap">{group.label}<small className="cell-note">{group.count}개 항목</small></td><td className="number nowrap">{won(group.total)}</td><td className="number nowrap">{won(group.debt)}</td><td className="number nowrap">{won(group.net)}</td></tr>)}</tbody></table></div> : <Empty />}
      </section>
    </div>
  </>;
}

function MaturityPreview({ asset }) {
  const result = maturityEstimate(asset);
  if (!result) return null;
  return <div className="asset-maturity-preview">
    <div><span>세후 만기 예상액</span><strong>{result.net === null ? '계좌 정산·과세 조건 확인 필요' : won(result.net)}</strong></div>
    <p>{result.dueDate} 만기 · 현재 자산 합계에 미포함</p>
    {result.mode === 'calculated' && <dl><div><dt>만기 납입 원금</dt><dd>{won(result.principal)}</dd></div><div><dt>세전 이자</dt><dd>{won(result.interest)}</dd></div><div><dt>예상 세금</dt><dd>{result.tax === null ? '정산 후 확정' : won(result.tax)}</dd></div><div><dt>세후 지원금</dt><dd>{won(result.grant)}</dd></div></dl>}
    {result.mode === 'manual' && <p>직접 입력한 금액에는 원금·세후 이자·지원금을 모두 포함하세요.</p>}
  </div>;
}

export function AssetForm({ entry, busy, onSave, onCancel }) {
  const [draft, setDraft] = useState(() => ({
    name: '', institution: '', accountName: '', kind: 'deposit', accountType: 'general', balance: '', asOf: today(), ...entry,
    policy: { taxMode: 'standard', taxRate: 15.4, taxFreeAllowance: 0, grant: 0, name: '', conditions: '', sourceUrl: '', checkedOn: '', ...entry?.policy, checkedOn: entry?.policy?.checkedOn || '' },
    maturity: { mode: 'calculated', startDate: today(), months: 12, annualRate: '', interestMethod: 'simple', principal: '', monthlyPayment: '', manualAmount: '', ...entry?.maturity, manualAmount: entry?.maturity?.manualAmount ?? '' },
  }));
  const [error, setError] = useState('');
  const term = isTermAsset(draft.kind);
  const update = (field, value) => setDraft(current => ({ ...current, [field]: value }));
  const updatePolicy = (field, value) => setDraft(current => ({ ...current, policy: { ...current.policy, [field]: value } }));
  const updateTerm = (field, value) => setDraft(current => ({ ...current, maturity: { ...current.maturity, [field]: value } }));
  function changeKind(value) {
    setDraft(current => ({ ...current, kind: value, policy: { ...current.policy, taxMode: isTermAsset(value) ? current.policy.taxMode === 'unspecified' ? 'standard' : current.policy.taxMode : current.policy.taxMode === 'standard' ? 'unspecified' : current.policy.taxMode } }));
  }
  function changeAccount(value) {
    setDraft(current => ({ ...current, accountType: value, policy: { ...current.policy, taxMode: isDeferredAccount(value) ? 'deferred' : current.policy.taxMode === 'deferred' ? isTermAsset(current.kind) ? 'standard' : 'unspecified' : current.policy.taxMode } }));
  }
  const parsed = useMemo(() => assetSchema.safeParse({
    ...draft, balance: Number(draft.balance),
    policy: { ...draft.policy, taxRate: Number(draft.policy.taxRate), taxFreeAllowance: Number(draft.policy.taxFreeAllowance), grant: Number(draft.policy.grant), sourceUrl: draft.policy.sourceUrl.trim(), checkedOn: draft.policy.checkedOn || null },
    maturity: term ? { ...draft.maturity, months: Number(draft.maturity.months), annualRate: Number(draft.maturity.annualRate), principal: Number(draft.maturity.principal === '' ? draft.balance : draft.maturity.principal), monthlyPayment: Number(draft.maturity.monthlyPayment), manualAmount: draft.maturity.manualAmount === '' ? null : Number(draft.maturity.manualAmount) } : null,
  }), [draft, term]);
  return <form className="entry-form asset-form" onSubmit={async event => {
    event.preventDefault(); setError('');
    if (!parsed.success) { const issue = parsed.error.issues[0]; setError(issue?.code === 'custom' ? issue.message : '상품명, 금액, 날짜와 필수 입력값을 확인해 주세요.'); return; }
    try { await onSave(parsed.data, entry?.id); } catch { setError('저장하지 못했습니다. 입력 내용을 확인하고 다시 시도해 주세요.'); }
  }}><fieldset disabled={busy}>
    <div className="form-grid"><label>자산 종류<select value={draft.kind} onChange={event => changeKind(event.target.value)}>{options(assetKinds)}</select></label><label>계좌 구분<select value={draft.accountType} onChange={event => changeAccount(event.target.value)}>{options(accountTypes)}</select></label></div>
    <label>자산·상품명<input required maxLength={100} placeholder="예: 정기예금, 국내 ETF, 비트코인, 신용대출" value={draft.name} onChange={event => update('name', event.target.value)} /></label>
    <div className="form-grid"><label>금융기관·거래소<input maxLength={100} value={draft.institution} onChange={event => update('institution', event.target.value)} /></label><label>계좌명<input maxLength={100} placeholder="계좌번호 대신 구분할 이름" value={draft.accountName} onChange={event => update('accountName', event.target.value)} /></label></div>
    <div className="form-grid"><label>{draft.kind === 'loan' ? '남은 대출 원금 (원)' : '현재 잔고 (원)'}<input required type="number" min="0" max={MAX_ASSET_AMOUNT} step="1" value={draft.balance} onChange={event => update('balance', event.target.value)} /></label><label>잔고 기준일<input required type="date" min="1900-01-01" max="2100-12-31" value={draft.asOf} onChange={event => update('asOf', event.target.value)} /></label></div>
    {['stock', 'bitcoin', 'fund'].includes(draft.kind) && <p className="help">현재 원화 평가잔고를 입력하세요. 투자 수익률과 시세는 계산하거나 자동 반영하지 않습니다.</p>}
    {term && <div className="asset-form-section"><h3>만기 예상액</h3>
      <div className="form-grid"><label>금액 산정<select value={draft.maturity.mode} onChange={event => updateTerm('mode', event.target.value)}><option value="calculated">원금·금리로 자동 계산</option><option value="manual">세후 만기액 직접 입력</option></select></label><label>가입일<input required type="date" min="1900-01-01" max="2100-12-31" value={draft.maturity.startDate} onChange={event => updateTerm('startDate', event.target.value)} /></label></div>
      <div className="form-grid"><label>가입 기간 (개월)<input required type="number" min="1" max="600" step="1" value={draft.maturity.months} onChange={event => updateTerm('months', event.target.value)} /></label>{draft.maturity.mode === 'manual' ? <label>세후 만기 금액 (원)<input required type="number" min="0" max={MAX_ASSET_AMOUNT} step="1" value={draft.maturity.manualAmount} onChange={event => updateTerm('manualAmount', event.target.value)} /></label> : <label>연 금리 (우대 포함, %)<input required type="number" min="0" max="100" step="0.0001" value={draft.maturity.annualRate} onChange={event => updateTerm('annualRate', event.target.value)} /></label>}</div>
      {draft.maturity.mode === 'calculated' && <><div className="form-grid">
        {draft.kind === 'deposit' ? <label>예치 원금 (원)<input type="number" min="1" max={MAX_ASSET_AMOUNT} step="1" placeholder="비우면 현재 잔고 사용" value={draft.maturity.principal} onChange={event => updateTerm('principal', event.target.value)} /></label> : <label>매월 납입액 (원)<input required type="number" min="1" max={MAX_ASSET_AMOUNT} step="1" value={draft.maturity.monthlyPayment} onChange={event => updateTerm('monthlyPayment', event.target.value)} /></label>}
        <label>이자 계산<select value={draft.maturity.interestMethod} onChange={event => updateTerm('interestMethod', event.target.value)}><option value="simple">단리</option><option value="monthlyCompound">월복리</option></select></label>
      </div><p className="help">월 단위로 계산하며, 적금은 가입일부터 매월 같은 금액을 납입한다고 가정합니다. 실제 납입일·세금 절사에 따른 차이는 세후 만기액 직접 입력으로 반영하세요.</p></>}
    </div>}
    <div className="asset-form-section"><h3>과세·상품 정책</h3>
      <div className="form-grid"><label>과세 구분<select value={draft.policy.taxMode} onChange={event => updatePolicy('taxMode', event.target.value)}>{options(taxModes)}</select></label>{draft.policy.taxMode === 'custom' && <label>적용 세율 (지방세 포함, %)<input required type="number" min="0" max="100" step="0.0001" value={draft.policy.taxRate} onChange={event => updatePolicy('taxRate', event.target.value)} /></label>}</div>
      {isDeferredAccount(draft.accountType) && <p className="help">ISA·IRP·연금저축은 계좌 정산·인출 조건에 따라 과세하므로 상품마다 비과세 한도를 자동 적용하지 않습니다. 적용 가능한 세율·이자 한도를 직접 설정하거나 확정 세후 만기액을 입력하세요.</p>}
      {term && <div className="form-grid">{['standard', 'custom'].includes(draft.policy.taxMode) && <label>이 상품에 적용할 비과세 이자 한도 (원)<input type="number" min="0" max={MAX_ASSET_AMOUNT} step="1" value={draft.policy.taxFreeAllowance} onChange={event => updatePolicy('taxFreeAllowance', event.target.value)} /><small>원금 한도가 아닌 이자 면제 금액입니다. 계좌 공통 한도를 상품마다 중복 입력하지 마세요.</small></label>}<label>만기 지원금 (세후·원)<input type="number" min="0" max={MAX_ASSET_AMOUNT} step="1" value={draft.policy.grant} onChange={event => updatePolicy('grant', event.target.value)} /><small>조건을 충족해 받을 예정인 지원금 총액</small></label></div>}
      <label>정책·상품 혜택명<input maxLength={100} placeholder="예: 비과세종합저축, 우대금리·정부지원금" value={draft.policy.name} onChange={event => updatePolicy('name', event.target.value)} /></label>
      <label>적용 조건<textarea maxLength={1500} rows={3} placeholder="가입 자격, 유지 기간, 납입 한도, 우대금리 충족 조건 등" value={draft.policy.conditions} onChange={event => updatePolicy('conditions', event.target.value)} /></label>
      <div className="form-grid"><label>상품·정책 원문 URL<input type="url" maxLength={1000} placeholder="https://" value={draft.policy.sourceUrl} onChange={event => updatePolicy('sourceUrl', event.target.value)} /></label><label>정책 확인일<input type="date" min="1900-01-01" max="2100-12-31" value={draft.policy.checkedOn} onChange={event => updatePolicy('checkedOn', event.target.value)} /></label></div>
      <p className="help">상품별 적용 조건과 정책 변경은 직접 확인해 입력합니다. 일반 이자 과세 기준은 <a href="https://obank.kbstar.com/quics?QSL=F&amp;page=C016528" target="_blank" rel="noreferrer">KB국민은행 안내 ↗</a>를 참고했습니다.</p>
    </div>
    {parsed.success && term && <MaturityPreview asset={parsed.data} />}
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="button" onClick={onCancel}>취소</button><button className="button primary" type="submit">{busy ? '저장 중…' : '저장'}</button></div>
  </fieldset></form>;
}
