// notes editor: the inline suggestion popup (slash menu, [[ link picker, #tag and @date suggestions).
// Focus never leaves the editor: the editor forwards arrow keys / Enter / Tab / Esc, names the highlighted
// row with aria-activedescendant, and rows ignore pointerdown so the caret and keyboard stay put.

import { el, svgIcon } from './icons.js';

let seq = 0;

export class ListPopup {
  constructor({ className = '', label = 'Suggestions', onPick, onHighlight } = {}) {
    this.id = `ne-pop-${++seq}`;
    this.label = label;
    this.className = className;
    this.onPick = onPick;
    this.onHighlight = onHighlight;
    this.items = [];
    this.hl = -1;
    this.node = null;
    this.list = null;
    this.anchor = null;
    this.mode = 'float';
  }

  get isOpen() {
    return !!this.node;
  }

  /**
   * Open (or refresh) at a caret rect. items: [{id, label, sub?, hint?, icon?, iconEl?, section?, data}]
   * autoHl: highlight the first row when none is (false: start with nothing highlighted). kind: what the list
   * offers ('slash', 'date', 'link', 'tag'…), for styling (data-kind).
   */
  show(rect, items, { mode = 'float', empty = '', autoHl = true, kind = '' } = {}) {
    this.mode = mode;
    this.anchor = rect;
    this.items = items;
    this.empty = empty;
    if (!this.node) {
      this.node = el('div', { class: `menu ne-pop ${this.className}`.trim(), role: 'listbox', id: this.id, 'aria-label': this.label });
      this.node.addEventListener('pointerdown', (e) => e.preventDefault());
      this.node.addEventListener('mousedown', (e) => e.preventDefault());
      this.node.addEventListener('click', (e) => {
        const row = e.target.closest('[data-i]');
        if (row) this.pick(+row.dataset.i);
      });
      this.node.addEventListener('pointermove', (e) => {
        const row = e.target.closest('[data-i]');
        if (row && +row.dataset.i !== this.hl) this.setHl(+row.dataset.i, false);
      });
      document.body.append(this.node);
    }
    this.node.classList.toggle('ne-pop-sheet', mode === 'sheet');
    if (kind) this.node.dataset.kind = kind;
    else delete this.node.dataset.kind;
    this.render();
    this.place();
    const keep = this.hl >= 0 && this.hl < items.length ? this.hl : autoHl ? items.findIndex((it) => !it.disabled) : -1;
    this.setHl(keep, true);
  }

  render() {
    const n = this.node;
    n.replaceChildren();
    let section = null;
    this.items.forEach((it, i) => {
      if (it.section && it.section !== section) {
        section = it.section;
        n.append(el('div', { class: 'menu-label', role: 'presentation', text: it.section }));
      }
      const lead = it.iconEl || (it.icon ? svgIcon(it.icon, { size: 18 }) : null);
      const row = el(
        'div',
        { class: `menu-item ne-opt${it.className ? ` ${it.className}` : ''}`, role: 'option', id: `${this.id}-${i}`, 'data-i': i, 'aria-selected': 'false', 'aria-disabled': it.disabled ? 'true' : null },
        lead ? el('span', { class: 'ne-opt-ic', 'aria-hidden': 'true' }, lead) : null,
        el('span', { class: 'grow ne-opt-main' }, el('span', { class: 'truncate ne-opt-label', text: it.label }), it.sub ? el('span', { class: 'truncate ne-opt-sub', text: it.sub }) : null),
        it.hint ? el('span', { class: 'ne-opt-hint', text: it.hint }) : null,
      );
      n.append(row);
    });
    if (!this.items.length && this.empty) n.append(el('div', { class: 'ne-pop-empty', text: this.empty }));
  }

  place() {
    const n = this.node;
    if (!n) return;
    const r = this.anchor;
    const vv = window.visualViewport;
    const vw = vv ? vv.width : innerWidth;
    const vh = vv ? vv.height : innerHeight;
    const top0 = vv ? vv.offsetTop : 0;
    const left0 = vv ? vv.offsetLeft : 0;
    n.style.left = '0px';
    n.style.top = '0px';
    const w = n.offsetWidth;
    const h = n.offsetHeight;
    if (this.mode === 'sheet') {
      // Docked on the phone's keyboard bar, flush: no gap for the note to show through.
      const acc = document.querySelector('.ne-acc.on');
      const bottom = acc ? acc.getBoundingClientRect().top : top0 + vh;
      n.style.left = `${Math.max(0, left0 + (vw - w) / 2)}px`;
      n.style.top = `${Math.max(top0 + 8, bottom - h)}px`;
      return;
    }
    let x = r ? r.left - 12 : 16;
    let y = r ? r.bottom + 6 : 16;
    if (r && y + h > top0 + vh - 8) y = Math.max(top0 + 8, r.top - h - 6);
    x = Math.min(Math.max(left0 + 8, x), left0 + vw - w - 8);
    n.style.left = `${Math.round(x)}px`;
    n.style.top = `${Math.round(y)}px`;
  }

  setHl(i, scroll = true) {
    this.hl = i;
    if (!this.node) return;
    for (const row of this.node.querySelectorAll('[data-i]')) {
      const on = +row.dataset.i === i;
      row.classList.toggle('hl', on);
      row.setAttribute('aria-selected', String(on));
      if (on && scroll) row.scrollIntoView({ block: 'nearest' });
    }
    this.onHighlight?.(i >= 0 ? this.items[i] : null, i >= 0 ? `${this.id}-${i}` : null);
  }

  move(d) {
    const n = this.items.length;
    if (!n) return;
    let i = this.hl < 0 ? (d > 0 ? -1 : n) : this.hl; // from nothing: Down → first row, Up → last row
    for (let k = 0; k < n; k++) {
      i = (i + d + n) % n;
      if (!this.items[i].disabled) break;
    }
    this.setHl(i);
  }

  current() {
    return this.hl >= 0 ? this.items[this.hl] : null;
  }

  pick(i = this.hl) {
    const it = this.items[i];
    if (!it || it.disabled) return false;
    this.onPick?.(it);
    return true;
  }

  close() {
    this.node?.remove();
    this.node = null;
    this.items = [];
    this.hl = -1;
    this.onHighlight?.(null, null);
  }
}

/** In-order fuzzy match: every query character appears in order. Returns a score (higher is better) or -1. */
export function fuzzy(text, q) {
  const t = text.toLowerCase();
  const s = q.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s) return 0;
  if (t.startsWith(s)) return 100 - t.length;
  const w = t.indexOf(` ${s}`);
  if (w >= 0) return 80 - w;
  if (t.includes(s)) return 60 - t.indexOf(s);
  let j = 0;
  let gaps = 0;
  for (let k = 0; k < t.length && j < s.length; k++) {
    if (t[k] === s[j]) j++;
    else if (j > 0) gaps++;
  }
  return j === s.length ? Math.max(1, 40 - gaps) : -1;
}
