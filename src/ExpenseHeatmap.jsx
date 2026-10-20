import { useMemo, useRef, useState } from 'react';
import { won } from '../shared/ledger.js';
import { expenseCalendar, expenseLevels } from './dashboard-data.js';

const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
function describe(day) {
  return `${day.date} · ${day.count ? `지출 ${won(day.amount)} · ${day.count}건` : '지출 내역 없음'}`;
}

export default function ExpenseHeatmap({ transactions, month }) {
  const calendar = useMemo(() => expenseCalendar(transactions, month), [transactions, month]);
  const [selected, setSelected] = useState(null);
  const [hovered, setHovered] = useState(null);
  const cells = useRef([]);
  const current = hovered ?? selected;
  const focusedIndex = selected ?? calendar.days.findIndex(day => day.date.startsWith(month));
  const detail = current === null ? null : calendar.days[current];

  function move(event, index) {
    const offset = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[event.key];
    let next;
    if (offset !== undefined) next = Math.max(0, Math.min(calendar.days.length - 1, index + offset));
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = calendar.days.length - 1;
    else return;
    event.preventDefault();
    setHovered(null);
    setSelected(next);
    cells.current[next]?.focus();
  }

  return <div className="expense-calendar">
    <div className="heatmap-scroll" role="group" aria-label="최근 12개월 날짜별 지출 잔디. 방향키로 날짜를 이동할 수 있습니다.">
      <div className="heatmap-layout" style={{ '--heatmap-weeks': calendar.weeks }}>
        <div className="heatmap-months" aria-hidden="true">{calendar.months.map(item => <span key={item.key} style={{ gridColumn: `${item.column + 1} / span 3` }}>{item.label}</span>)}</div>
        <div className="heatmap-weekdays" aria-hidden="true">{weekdays.map(day => <span key={day}>{['월', '수', '금'].includes(day) ? day : ''}</span>)}</div>
        <div className="heatmap-days" onMouseLeave={() => setHovered(null)}>
          {calendar.days.map((day, index) => <button
            key={day.date} ref={element => { cells.current[index] = element; }} type="button"
            className="heatmap-cell" data-level={day.level} data-selected={selected === index || undefined}
            style={{ gridColumn: day.column + 1, gridRow: day.row + 1 }}
            tabIndex={index === focusedIndex ? 0 : -1} aria-label={describe(day)} aria-pressed={selected === index}
            title={describe(day)} onMouseEnter={() => setHovered(index)} onFocus={() => setSelected(index)}
            onClick={() => { setSelected(index); setHovered(null); }} onKeyDown={event => move(event, index)}
          />)}
        </div>
      </div>
    </div>
    <div className="heatmap-footer">
      <span className="heatmap-detail" aria-live="polite">{detail ? describe(detail) : <>기간 지출 <strong>{won(calendar.amount)}</strong> · {calendar.count}건</>}</span>
      <div className="heatmap-legend" aria-label="색상별 지출 금액">
        <span>적음</span>{expenseLevels.map(item => <span key={item.level} className="heatmap-swatch" data-level={item.level} title={item.label} aria-label={item.label} />)}<span>많음</span>
      </div>
    </div>
    <p className="heatmap-help">진할수록 지출 금액이 큽니다. 날짜를 가리키거나 선택하면 금액과 건수를 표시합니다. 취소·환급, 이체 입금, 수입·저축은 집계에서 제외합니다.</p>
  </div>;
}
