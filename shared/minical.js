// Mini month calendar (Fantastical / Apple style) used by the date picker and schedule's sidebar.
import { ymd, todayYmd, startOfWeek, addDays, fmt, WEEKDAY_NARROW } from './dates.js';
import { icon } from './icons.js';

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const escAttr = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The heading of the month shown ('December 2026'): what to announce when a calendar moves to it. */
export const monthTitle = (month) => fmt(new Date(month.getFullYear(), month.getMonth(), 1), { month: 'long', year: 'numeric' });

/**
 * @param {{month:Date, selected?:string|null, weekStart?:number, rangeFrom?:string, rangeTo?:string,
 *          marks?:Set<string>, markLabel?:string, compact?:boolean, focusDate?:string|null, showToday?:boolean}} o
 * Buttons carry data-date="YYYY-MM-DD"; nav buttons carry data-mc="prev|next|today".
 * `marks` days get a dot. `markLabel` says what it means (e.g. 'has events', 'has a note') and ends those days'
 * labels; without one the dot isn't spoken, as only the caller knows what it stands for.
 * `focusDate` turns on a roving tabindex: only that day is in the tab order (arrow keys are handled by the caller).
 * The month name is not a live region: callers replace this markup on every month change, and a region
 * that is replaced is not read. They announce the new month themselves (shell.js announce(), or a live
 * region of their own that stays in place), with monthTitle(month).
 */
export function miniCalendar(o) {
  const month = new Date(o.month.getFullYear(), o.month.getMonth(), 1);
  const weekStart = Number.isInteger(o.weekStart) ? o.weekStart : 0;
  const today = todayYmd();
  const thisYear = new Date().getFullYear();
  const start = startOfWeek(month, weekStart);
  const label = monthTitle(month);
  const selected = YMD.test(o.selected || '') ? o.selected : null;
  const roving = YMD.test(o.focusDate || '') ? o.focusDate : null;
  const markLabel = typeof o.markLabel === 'string' ? o.markLabel.trim() : '';
  let cells = '';
  for (let w = 0; w < 6; w++) {
    const rowStart = addDays(start, w * 7);
    if (w > 3 && rowStart.getMonth() !== month.getMonth()) break;
    let row = '';
    for (let i = 0; i < 7; i++) {
      const d = addDays(rowStart, i);
      const s = ymd(d);
      const marked = !!o.marks?.has(s);
      const cls = [
        'mc-day',
        d.getMonth() !== month.getMonth() && 'out',
        s === today && 'today',
        s === selected && 'sel',
        o.rangeFrom && s >= o.rangeFrom && s <= o.rangeTo && 'in-range',
        o.rangeFrom && s === o.rangeFrom && 'range-start',
        o.rangeTo && s === o.rangeTo && 'range-end',
        marked && 'mark',
      ]
        .filter(Boolean)
        .join(' ');
      const attrs = [
        s === today ? 'aria-current="date"' : '',
        s === selected ? 'aria-pressed="true"' : '',
        roving ? `tabindex="${s === roving ? 0 : -1}"` : '',
      ].join(' ');
      // The dot is drawn by CSS, so the label carries its meaning (markLabel). Days in another year say so.
      const name = `${fmt(d, { weekday: 'long', month: 'long', day: 'numeric', ...(d.getFullYear() === thisYear ? {} : { year: 'numeric' }) })}${marked && markLabel ? `, ${markLabel}` : ''}`;
      row += `<button type="button" class="${cls}" data-date="${s}" ${attrs} aria-label="${escAttr(name)}"><span>${d.getDate()}</span></button>`;
    }
    cells += `<div class="mc-row">${row}</div>`;
  }
  const heads = Array.from({ length: 7 }, (_, i) => `<span>${WEEKDAY_NARROW[(weekStart + i) % 7]}</span>`).join('');
  // "Today" in words where there is room for it beside the month (the date picker, Notes' day picker); a compact
  // calendar (a narrow sidebar) keeps a dot there, so a long month ("September 2026") stays on one line.
  const todayButton =
    o.showToday === false
      ? ''
      : o.compact
        ? `<button type="button" class="icon-btn sm mc-today" data-mc="today" aria-label="Go to today" data-tip="Today">${icon('dot', { size: 16 })}</button>`
        : // Named for what it does: the date picker's quick dates have a "Today" too, which picks today and closes.
          '<button type="button" class="btn btn-ghost btn-sm mc-today" data-mc="today" aria-label="Go to today">Today</button>';
  return `<div class="minical${o.compact ? ' compact' : ''}">
    <div class="mc-head">
      <strong>${label}</strong>
      <div class="mc-nav">
        <button type="button" class="icon-btn sm" data-mc="prev" aria-label="Previous month" data-tip="Previous month">${icon('chevron-left', { size: 16 })}</button>
        ${todayButton}
        <button type="button" class="icon-btn sm" data-mc="next" aria-label="Next month" data-tip="Next month">${icon('chevron-right', { size: 16 })}</button>
      </div>
    </div>
    <div class="mc-week" aria-hidden="true">${heads}</div>
    ${cells}
  </div>`;
}
