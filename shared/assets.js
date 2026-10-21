import { z } from 'zod';
import { addMonths, format, isValid, parseISO } from 'date-fns';

export const assetKinds = { cash: '입출금·현금', deposit: '예금', installment: '적금', stock: '주식·ETF', bitcoin: '비트코인·가상자산', fund: '펀드·채권', other: '기타 자산', loan: '대출' };
export const accountTypes = { general: '일반 계좌', isa: 'ISA 일반형', isaLowIncome: 'ISA 서민형', isaFarmer: 'ISA 농어민형', irp: 'IRP', pension: '연금저축', cma: 'CMA', subscription: '주택청약', other: '기타 계좌' };
export const taxModes = { unspecified: '미설정', standard: '이자 일반과세 (15.4%)', exempt: '비과세', custom: '세율 직접 설정', deferred: '계좌 정산·과세 이연' };
export const MAX_ASSET_AMOUNT = 999_999_999_999;
export const isTermAsset = kind => kind === 'deposit' || kind === 'installment';
export const isDeferredAccount = type => ['isa', 'isaLowIncome', 'isaFarmer', 'irp', 'pension'].includes(type);
const money = z.number().int().min(0).max(MAX_ASSET_AMOUNT);
const percentage = z.number().min(0).max(100);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = parseISO(value);
  return isValid(parsed) && format(parsed, 'yyyy-MM-dd') === value && value >= '1900-01-01' && value <= '2100-12-31';
}, '올바른 날짜를 입력하세요.');
const policySchema = z.object({
  taxMode: z.enum(Object.keys(taxModes)).default('unspecified'),
  taxRate: percentage.default(15.4),
  taxFreeAllowance: money.default(0),
  grant: money.default(0),
  name: z.string().trim().max(100).default(''),
  conditions: z.string().trim().max(1500).default(''),
  sourceUrl: z.union([z.literal(''), z.string().trim().url().max(1000).refine(value => /^https?:\/\//i.test(value), '상품·정책 URL은 http 또는 https 주소를 입력하세요.')]).default(''),
  checkedOn: date.nullable().default(null),
});
const maturitySchema = z.object({
  mode: z.enum(['calculated', 'manual']).default('calculated'),
  startDate: date,
  months: z.number().int().min(1).max(600),
  annualRate: percentage.default(0),
  interestMethod: z.enum(['simple', 'monthlyCompound']).default('simple'),
  principal: money.default(0),
  monthlyPayment: money.default(0),
  manualAmount: money.nullable().default(null),
});
const assetFields = z.object({
  name: z.string().trim().min(1).max(100),
  institution: z.string().trim().max(100).default(''),
  accountName: z.string().trim().max(100).default(''),
  kind: z.enum(Object.keys(assetKinds)),
  accountType: z.enum(Object.keys(accountTypes)).default('general'),
  balance: money,
  asOf: date,
  policy: policySchema.default(() => policySchema.parse({})),
  maturity: maturitySchema.nullable().default(null),
});

export function maturityEstimate(asset) {
  if (!isTermAsset(asset.kind) || !asset.maturity) return null;
  const { months, annualRate, principal, monthlyPayment, interestMethod, startDate, mode, manualAmount } = asset.maturity;
  const dueDate = format(addMonths(parseISO(startDate), months), 'yyyy-MM-dd');
  if (mode === 'manual') return { dueDate, mode, net: manualAmount, principal: null, interest: null, tax: null, grant: null };
  const rate = annualRate / 1200;
  const totalPrincipal = asset.kind === 'deposit' ? principal : monthlyPayment * months;
  let interest;
  if (interestMethod === 'simple') {
    interest = asset.kind === 'deposit' ? principal * rate * months : monthlyPayment * rate * months * (months + 1) / 2;
  } else if (asset.kind === 'deposit') {
    interest = principal * ((1 + rate) ** months - 1);
  } else {
    interest = 0;
    for (let remaining = 1; remaining <= months; remaining++) interest += monthlyPayment * ((1 + rate) ** remaining - 1);
  }
  interest = Math.floor(interest + 1e-7);
  const { taxMode, taxRate, taxFreeAllowance, grant } = asset.policy;
  const ratePercent = taxMode === 'exempt' ? 0 : taxMode === 'standard' ? 15.4 : taxRate;
  const taxable = Math.max(0, interest - taxFreeAllowance);
  const tax = ['deferred', 'unspecified'].includes(taxMode) ? null : Math.floor(taxable * ratePercent / 100 + 1e-7);
  return { dueDate, mode, principal: totalPrincipal, interest, tax, grant, net: tax === null ? null : totalPrincipal + interest - tax + grant };
}

function validateAsset(asset, context) {
  const invalid = (path, message) => context.addIssue({ code: 'custom', path, message });
  if (!isTermAsset(asset.kind)) {
    if (asset.maturity !== null) invalid(['maturity'], '예금·적금에만 만기 정보를 설정할 수 있습니다.');
    return;
  }
  if (!asset.maturity) { invalid(['maturity'], '만기 정보를 입력하세요.'); return; }
  const term = asset.maturity;
  if (!isValid(parseISO(term.startDate)) || !Number.isInteger(term.months) || term.months < 1 || term.months > 600) return;
  if (term.mode === 'manual') {
    if (term.manualAmount === null) invalid(['maturity', 'manualAmount'], '세후 만기 금액을 입력하세요.');
    return;
  }
  const principalField = asset.kind === 'deposit' ? 'principal' : 'monthlyPayment';
  if (term[principalField] <= 0) invalid(['maturity', principalField], asset.kind === 'deposit' ? '예치 원금을 입력하세요.' : '월 납입액을 입력하세요.');
  const estimate = maturityEstimate(asset);
  const gross = estimate.principal + estimate.interest + estimate.grant;
  if (!Number.isSafeInteger(gross) || gross > MAX_ASSET_AMOUNT) invalid(['maturity'], '만기 예상액이 계산 가능한 범위를 초과했습니다.');
}
export const assetSchema = assetFields.superRefine(validateAsset);
export const storedAssetSchema = assetFields.extend({ id: z.string().uuid() }).superRefine(validateAsset);

export function assetSummary(assets) {
  let total = 0, debt = 0, deposits = 0;
  for (const asset of assets) {
    if (asset.kind === 'loan') debt += asset.balance;
    else total += asset.balance;
    if (isTermAsset(asset.kind)) deposits += asset.balance;
  }
  return { total, debt, net: total - debt, deposits };
}

export function makeAssetDemo(asOf = format(new Date(), 'yyyy-MM-dd')) {
  const create = fields => ({ id: crypto.randomUUID(), ...assetSchema.parse({ institution: '예시 금융기관', asOf, ...fields }) });
  return [
    create({ name: '생활비 통장', kind: 'cash', balance: 2800000 }),
    create({ name: '정기 예금', kind: 'deposit', balance: 10000000, policy: { taxMode: 'standard' }, maturity: { startDate: asOf, months: 12, principal: 10000000, annualRate: 3.2 } }),
    create({ name: '비과세 적금', kind: 'installment', balance: 1800000, policy: { taxMode: 'exempt', name: '비과세·지원금 적용 예시', grant: 120000, conditions: '가입 자격과 만기 유지 조건 충족을 가정한 예시' }, maturity: { startDate: asOf, months: 12, monthlyPayment: 300000, annualRate: 4 } }),
    create({ name: '국내 ETF', kind: 'stock', accountType: 'isa', accountName: '절세 투자 계좌', balance: 6500000, policy: { taxMode: 'deferred' } }),
    create({ name: '퇴직연금 잔고', kind: 'fund', accountType: 'irp', balance: 5200000, policy: { taxMode: 'deferred' } }),
    create({ name: '비트코인', kind: 'bitcoin', institution: '예시 거래소', balance: 2400000 }),
    create({ name: '신용대출', kind: 'loan', balance: 7000000 }),
  ];
}
