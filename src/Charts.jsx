import { useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { won, monthLabel } from '../shared/ledger.js';
import { categoryExpenseTrends } from './dashboard-data.js';
import { Empty } from './components.jsx';

export default function FlowChart({ data }) {
  return <div className="chart-box" role="img" aria-label="최근 6개월 수입·지출·저축 비교">
    <ResponsiveContainer width="100%" height="100%" minWidth={0}><BarChart data={data} margin={{ top: 12, right: 15, left: 8, bottom: 0 }}>
      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
      <XAxis dataKey="name" tick={{ fontSize: 13, fill: 'var(--muted)' }} tickLine={false} axisLine={false} />
      <YAxis width={65} tickFormatter={v => `${Math.round(v / 10000)}만`} tick={{ fontSize: 12, fill: 'var(--muted)' }} tickLine={false} axisLine={false} />
      <Tooltip cursor={{ fill: 'var(--chart-cursor)' }} contentStyle={{ borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} labelStyle={{ color: 'var(--text)' }} itemStyle={{ color: 'var(--text)' }} formatter={(v, name) => [won(v), name]} labelFormatter={(_, p) => p?.[0] ? monthLabel(p[0].payload.key) : ''} />
      <Bar name="수입" dataKey="income" fill="var(--chart-income)" maxBarSize={30} radius={[5, 5, 0, 0]} /><Bar name="지출" dataKey="expense" fill="var(--chart-expense)" maxBarSize={30} radius={[5, 5, 0, 0]} />
      <Bar name="저축" dataKey="saving" fill="var(--chart-saving)" maxBarSize={30} radius={[5, 5, 0, 0]} />
    </BarChart></ResponsiveContainer>
  </div>;
}

function CategoryTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const items = payload.filter(item => payload.length === 1 || item.value !== 0);
  const total = payload.reduce((sum, item) => sum + Number(item.value || 0), 0);
  return <div className="category-tooltip">
    <strong>{monthLabel(payload[0].payload.key)}</strong>
    {items.map(item => <div key={item.dataKey}><span><i style={{ background: item.color }} />{item.name}</span><span>{won(item.value)}</span></div>)}
    <div className="category-tooltip-total"><span>합계</span><strong>{won(total)}</strong></div>
  </div>;
}

export function CategoryExpenseChart({ transactions, month, categories }) {
  const { months, series } = useMemo(() => categoryExpenseTrends(transactions, month, categories), [transactions, month, categories]);
  const [active, setActive] = useState(null);
  const selected = series.find(category => category.id === active);
  const visible = selected ? [selected] : series;
  if (!series.length) return <Empty text="최근 6개월에 등록된 지출이 없습니다." />;
  return <div className="category-expense-chart">
    <div className="chart-box" role="group" aria-label={`최근 6개월 ${selected ? selected.name : '카테고리별'} 지출 비교`}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}><BarChart data={months} stackOffset="sign" margin={{ top: 12, right: 15, left: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
        <XAxis dataKey="name" tick={{ fontSize: 13, fill: 'var(--muted)' }} tickLine={false} axisLine={false} />
        <YAxis width={65} tickFormatter={value => `${Number((value / 10000).toFixed(1))}만`} tick={{ fontSize: 12, fill: 'var(--muted)' }} tickLine={false} axisLine={false} />
        <Tooltip cursor={{ fill: 'var(--chart-cursor)' }} content={<CategoryTooltip />} />
        <ReferenceLine y={0} stroke="var(--border)" />
        {visible.map(category => <Bar key={category.id} dataKey={category.dataKey} name={category.name} stackId="expense" fill={`var(--category-${category.colorIndex})`} maxBarSize={48} />)}
      </BarChart></ResponsiveContainer>
    </div>
    <div className="category-chart-legend" role="group" aria-label="비교할 지출 카테고리 선택">
      <button type="button" aria-pressed={!selected} onClick={() => setActive(null)}>전체</button>
      {series.map(category => <button key={category.id} type="button" aria-pressed={selected?.id === category.id} onClick={() => setActive(active === category.id ? null : category.id)}><i style={{ background: `var(--category-${category.colorIndex})` }} />{category.name}</button>)}
    </div>
    <p className="category-chart-help">범례를 선택하면 해당 카테고리만 비교합니다. 환급·이체 입금은 차감하며 음수는 0선 아래에 표시합니다.</p>
  </div>;
}
