import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { won, monthLabel } from '../shared/ledger.js';

export default function FlowChart({ data }) {
  return <div className="chart-box" role="img" aria-label="최근 6개월 수입과 지출 비교">
    <ResponsiveContainer width="100%" height="100%" minWidth={0}><BarChart data={data} margin={{ top: 12, right: 15, left: 8, bottom: 0 }}>
      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e5ea" />
      <XAxis dataKey="name" tick={{ fontSize: 13, fill: '#636366' }} tickLine={false} axisLine={false} />
      <YAxis width={65} tickFormatter={v => `${Math.round(v / 10000)}만`} tick={{ fontSize: 12, fill: '#636366' }} tickLine={false} axisLine={false} />
      <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #e5e5ea' }} formatter={(v, name) => [won(v), name]} labelFormatter={(_, p) => p?.[0] ? monthLabel(p[0].payload.key) : ''} />
      <Bar name="수입" dataKey="income" fill="#007aff" maxBarSize={30} radius={[5, 5, 0, 0]} /><Bar name="지출" dataKey="expense" fill="#df6259" maxBarSize={30} radius={[5, 5, 0, 0]} />
    </BarChart></ResponsiveContainer>
  </div>;
}
