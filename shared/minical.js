// Mini month calendar (Fantastical / Apple style) used by the date picker and schedule's sidebar.
import { ymd, todayYmd, startOfWeek, addDays, fmt, WEEKDAY_NARROW } from './dates.js';
import { icon } from './icons.js';

/**
 * @param {{month:Date, selected?:string|null, weekStart?:number, rangeFrom?:string, rangeTo?:string, marks?:Set<string>, compact?:boolean}} o
 * Buttons carry data-date="YYYY-MM-DD"; nav buttons carry data-mc="prev|next|today".
 */
export function miniCalendar(o) {
  const month = new Date(o.month.getFullYear(), o.month.getMonth(), 1);
  const weekStart = o.weekStart ?? 0;
  const today = todayYmd();
  const start = startOfWeek(month, weekStart);
  const label = fmt(month, { month: 'long', year: 'numeric' });
  let cells = '';
  for (let w = 0; w < 6; w++) {
    const rowStart = addDays(start, w * 7);
    if (w > 3 && rowStart.getMonth() !== month.getMonth()) break;
    let row = '';
    for (let i = 0; i < 7; i++) {
      const d = addDays(rowStart, i);
      const s = ymd(d);
      const cls = [
        'mc-day',
        d.getMonth() !== month.getMonth() && 'out',
        s === today && 'today',
        s === o.selected && 'sel',
        o.rangeFrom && s >= o.rangeFrom && s <= o.rangeTo && 'in-range',
        o.rangeFrom && s === o.rangeFrom && 'range-start',
        o.rangeTo && s === o.rangeTo && 'range-end',
        o.marks?.has(s) && 'mark',
      ]
        .filter(Boolean)
        .join(' ');
      row += `<button type="button" class="${cls}" data-date="${s}" aria-label="${fmt(d, { weekday: 'long', month: 'long', day: 'numeric' })}"><span>${d.getDate()}</span></button>`;
    }
    cells += `<div class="mc-row">${row}</div>`;
  }
  const heads = Array.from({ length: 7 }, (_, i) => `<span>${WEEKDAY_NARROW[(weekStart + i) % 7]}</span>`).join('');
  return `<div class="minical${o.compact ? ' compact' : ''}">
    <div class="mc-head">
      <strong>${label}</strong>
      <div class="mc-nav">
        <button type="button" class="icon-btn sm" data-mc="prev" aria-label="Previous month">${icon('chevron-left', { size: 16 })}</button>
        <button type="button" class="icon-btn sm" data-mc="today" aria-label="This month">${icon('circle', { size: 10, stroke: 3 })}</button>
        <button type="button" class="icon-btn sm" data-mc="next" aria-label="Next month">${icon('chevron-right', { size: 16 })}</button>
      </div>
    </div>
    <div class="mc-week">${heads}</div>
    ${cells}
  </div>`;
}
