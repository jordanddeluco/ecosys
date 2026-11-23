// notes editor: floating UI — the selection toolbar, the Aa format panel, the phone keyboard accessory
// bar, the link card / link field and the chip hover card. Buttons cancel pointerdown so the editor keeps
// its selection, focus and (on phones) the keyboard. Tooltips use data-tip + data-keys (shell.js).

import { openMenu, isMac } from '../../shared/shell.js';
import { el, svgIcon, taskCircle } from './icons.js';
import { HL_COLORS, TYPE_NAMES, hrefHost, hrefFromInput } from './model.js';

const k = (mac, win) => (isMac ? mac : win);

export const SHORTCUTS = {
  bold: 'mod B',
  italic: 'mod I',
  underline: 'mod U',
  strike: k('shift mod X', 'mod shift X'),
  code: 'mod E',
  highlight: k('shift mod H', 'mod shift H'),
  link: 'mod K',
  title: k('alt mod 1', 'mod alt 1'),
  heading: k('alt mod 2', 'mod alt 2'),
  subheading: k('alt mod 3', 'mod alt 3'),
  body: k('alt mod 0', 'mod alt 0'),
  checklist: k('alt mod 4', 'mod alt 4'),
  bullet: k('alt mod 5', 'mod alt 5'),
  number: k('alt mod 6', 'mod alt 6'),
  dash: k('alt mod 7', 'mod alt 7'),
  mono: k('alt mod 8', 'mod alt 8'),
  quote: k('alt mod 9', 'mod alt 9'),
  indent: 'tab',
  outdent: 'shift tab',
  undo: 'mod Z',
  redo: k('shift mod Z', 'mod Y'),
  'toggle-check': 'mod enter',
};

export const HL_NAMES = { purple: 'Purple', pink: 'Pink', orange: 'Orange', mint: 'Mint', blue: 'Blue' };

const MARK_BTNS = [
  { cmd: 'bold', icon: 'bold', label: 'Bold', mark: 'b' },
  { cmd: 'italic', icon: 'italic', label: 'Italic', mark: 'i' },
  { cmd: 'underline', icon: 'underline', label: 'Underline', mark: 'u' },
  { cmd: 'strike', icon: 'strikethrough', label: 'Strikethrough', mark: 's' },
  { cmd: 'code', icon: 'code', label: 'Inline code', mark: 'c' },
];

// Labels come from the one name table (model.js TYPE_NAMES), as in the slash menu.
export const TYPE_ITEMS = [
  { cmd: 'title', t: 'h1', label: TYPE_NAMES.h1 },
  { cmd: 'heading', t: 'h2', label: TYPE_NAMES.h2 },
  { cmd: 'subheading', t: 'h3', label: TYPE_NAMES.h3 },
  { cmd: 'body', t: 'p', label: TYPE_NAMES.p },
  { cmd: 'mono', t: 'code', label: TYPE_NAMES.code },
  { sep: true },
  { cmd: 'bullet', t: 'bullet', label: TYPE_NAMES.bullet },
  { cmd: 'dash', t: 'dash', label: TYPE_NAMES.dash },
  { cmd: 'number', t: 'num', label: TYPE_NAMES.num },
  { cmd: 'checklist', t: 'check', label: TYPE_NAMES.check },
  { cmd: 'quote', t: 'quote', label: TYPE_NAMES.quote },
];
const TYPE_LABEL = Object.fromEntries(TYPE_ITEMS.filter((x) => x.t).map((x) => [x.t, x.label]));

function button({ icon, label, keys: ks, cls = '', text, cmd, pressed }) {
  const b = el('button', {
    type: 'button',
    class: `ne-tb-btn${cls ? ` ${cls}` : ''}`,
    'aria-label': label,
    'data-tip': label,
    'data-keys': ks || null,
    'data-cmd': cmd || null,
    'aria-pressed': pressed === undefined ? null : String(!!pressed),
  });
  if (icon) b.append(svgIcon(icon, { size: 18 }));
  if (text) b.append(el('span', { class: 'ne-tb-txt', text }));
  return b;
}

const keepFocus = (n) => {
  n.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('input')) e.preventDefault();
  });
  n.addEventListener('mousedown', (e) => {
    if (!e.target.closest('input')) e.preventDefault();
  });
};

// ------------------------------------------------------------------ keyboard helpers

const usable = (b) => !b.disabled && b.getClientRects().length > 0;

/**
 * Arrow keys, Home and End move focus along a row of buttons (Left / Up back, Right / Down on, wrapping).
 * Returns the button that took focus, or null when the key was not a move.
 */
function moveFocus(e, items) {
  if (e.altKey || e.ctrlKey || e.metaKey) return null;
  const list = items.filter(usable);
  if (!list.length) return null;
  const i = list.indexOf(document.activeElement);
  let j;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % list.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length;
  else if (e.key === 'Home') j = 0;
  else if (e.key === 'End') j = list.length - 1;
  else return null;
  e.preventDefault();
  list[j].focus();
  return list[j];
}

/** One tab stop for a row (roving tabindex): `current` (or the first usable button) is it. */
function rove(items, current) {
  const cur = current && items.includes(current) ? current : items.find(usable) || items[0];
  for (const b of items) b.tabIndex = b === cur ? 0 : -1;
  return cur;
}

/** On a row too narrow for its buttons (it scrolls), fade the edge that has more beyond it (data-fade). */
function fadeEdges(s) {
  if (!s || !s.isConnected) return;
  const over = s.scrollWidth > s.clientWidth + 1;
  const atStart = s.scrollLeft <= 1;
  const atEnd = s.scrollLeft + s.clientWidth >= s.scrollWidth - 1;
  const fade = !over ? '' : atStart ? 'end' : atEnd ? 'start' : 'both';
  if (fade) {
    if (s.dataset.fade !== fade) s.dataset.fade = fade;
  } else if (s.dataset.fade !== undefined) delete s.dataset.fade;
}

/**
 * Keyboard for a card shown at the caret (link card, chip card, the editor's [[wiki]] card): arrows and Tab
 * move between its buttons (it sits at the end of the page, so Tab would otherwise leave the page), Esc goes
 * back to the editor at the same caret (`back`), and focus leaving it for anything else closes it.
 */
export function cardKeys(n, { back, hide }) {
  n.addEventListener('keydown', (e) => {
    const btns = [...n.querySelectorAll('button')];
    if (moveFocus(e, btns)) return;
    if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const list = btns.filter(usable);
      const i = list.indexOf(document.activeElement);
      if (list.length) {
        e.preventDefault();
        list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length].focus();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      back();
    }
  });
  n.addEventListener('focusout', (e) => {
    const to = e.relatedTarget;
    if (to && !n.contains(to)) hide();
  });
}

function placeNear(node, rect, { side = 'top', gap = 8 } = {}) {
  const vv = window.visualViewport;
  const vw = vv ? vv.width : innerWidth;
  const vh = vv ? vv.height : innerHeight;
  const ox = vv ? vv.offsetLeft : 0;
  const oy = vv ? vv.offsetTop : 0;
  node.style.left = '0px';
  node.style.top = '0px';
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  let x = rect.left + (rect.width || 0) / 2 - w / 2;
  let y = side === 'top' ? rect.top - h - gap : rect.bottom + gap;
  if (side === 'top' && y < oy + 8) y = rect.bottom + gap;
  if (side === 'bottom' && y + h > oy + vh - 8) y = rect.top - h - gap;
  x = Math.min(Math.max(ox + 8, x), ox + vw - w - 8);
  y = Math.min(Math.max(oy + 8, y), oy + vh - h - 8);
  node.style.left = `${Math.round(x)}px`;
  node.style.top = `${Math.round(y)}px`;
}

// ------------------------------------------------------------------ highlight swatches

/** A row of the five highlight swatches plus "No highlight". */
function swatchRow(current, onPick, { compact = false } = {}) {
  const row = el('div', { class: `ne-swatches${compact ? ' compact' : ''}`, role: 'group', 'aria-label': 'Highlight colour' });
  for (const c of HL_COLORS) {
    const b = el('button', { type: 'button', class: 'ne-sw', 'data-hl': c, 'aria-label': `${HL_NAMES[c]} highlight`, 'data-tip': HL_NAMES[c], 'aria-pressed': String(current === c) });
    b.append(el('span', { class: 'ne-sw-dot' }, el('span', { class: 'ne-sw-a', text: 'A' })));
    b.addEventListener('click', () => onPick(c));
    row.append(b);
  }
  const none = el('button', { type: 'button', class: 'ne-sw ne-sw-none', 'aria-label': 'No highlight', 'data-tip': 'No highlight', 'aria-pressed': String(!current) });
  none.append(el('span', { class: 'ne-sw-dot' }));
  none.addEventListener('click', () => onPick(null));
  row.append(none);
  return row;
}

/**
 * Small dropdown with the swatches, anchored to a button. Opened from the keyboard (the button has focus),
 * focus moves to the current colour; arrows move along the row, Esc or Tab closes it back to the button.
 * Returns {close, node}.
 */
function openSwatches(anchor, current, onPick, { onClose } = {}) {
  const pop = el('div', { class: 'menu ne-swpop', role: 'dialog', 'aria-label': 'Highlight' });
  keepFocus(pop);
  let closed = false;
  const close = (refocus = false) => {
    if (closed) return;
    closed = true;
    const had = pop.contains(document.activeElement);
    pop.remove();
    document.removeEventListener('pointerdown', outside, true);
    anchor.setAttribute('aria-expanded', 'false');
    onClose?.();
    if ((refocus || had) && anchor.isConnected) anchor.focus();
  };
  const outside = (e) => {
    if (!pop.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const row = swatchRow(current, (c) => {
    close();
    onPick(c);
  });
  pop.append(row);
  const sws = [...row.querySelectorAll('.ne-sw')];
  const cur = rove(sws, sws.find((b) => b.getAttribute('aria-pressed') === 'true'));
  pop.addEventListener('keydown', (e) => {
    const b = moveFocus(e, sws);
    if (b) return void rove(sws, b);
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  });
  const fromKeys = document.activeElement === anchor;
  document.body.append(pop);
  anchor.setAttribute('aria-expanded', 'true');
  placeNear(pop, anchor.getBoundingClientRect(), { side: 'bottom', gap: 6 });
  setTimeout(() => !closed && document.addEventListener('pointerdown', outside, true));
  if (fromKeys) cur?.focus();
  return { close, node: pop };
}

// ------------------------------------------------------------------ selection toolbar

export class SelectionToolbar {
  constructor(api) {
    this.api = api;
    this.node = null;
    this.child = null; // open dropdown / menu
  }

  build() {
    const n = el('div', { class: 'ne-seltb', role: 'toolbar', 'aria-label': 'Text formatting', 'aria-orientation': 'horizontal' });
    keepFocus(n);
    for (const b of MARK_BTNS) n.append(button({ icon: b.icon, label: b.label, keys: SHORTCUTS[b.cmd], cmd: b.cmd, pressed: false }));
    n.append(el('span', { class: 'ne-tb-sep', 'aria-hidden': 'true' }));
    const hl = button({ icon: 'highlighter', label: 'Highlight', keys: SHORTCUTS.highlight, cmd: 'hl-menu', cls: 'ne-tb-hl' });
    hl.setAttribute('aria-haspopup', 'dialog');
    hl.setAttribute('aria-expanded', 'false');
    hl.append(el('span', { class: 'ne-hlbar', 'aria-hidden': 'true' }), svgIcon('chevron', { size: 12, cls: 'ne-tb-chev' }));
    n.append(hl);
    n.append(button({ icon: 'link', label: 'Link', keys: SHORTCUTS.link, cmd: 'link-ui' }));
    n.append(el('span', { class: 'ne-tb-sep', 'aria-hidden': 'true' }));
    const ty = button({ label: 'Turn into', cmd: 'type-menu', cls: 'ne-tb-type', text: 'Body' });
    ty.setAttribute('aria-haspopup', 'menu');
    ty.setAttribute('aria-expanded', 'false');
    ty.append(svgIcon('chevron', { size: 12, cls: 'ne-tb-chev' }));
    n.append(ty);
    n.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cmd]');
      if (!b) return;
      const cmd = b.dataset.cmd;
      if (cmd === 'hl-menu') return this.openHl(b);
      if (cmd === 'type-menu') return this.openTypes(b);
      if (cmd === 'link-ui') return this.api.linkUI();
      this.api.exec(cmd);
    });
    // One tab stop (roving tabindex): arrows, Home and End move along the toolbar.
    n.addEventListener('keydown', (e) => {
      const btns = [...n.querySelectorAll('button')];
      const b = moveFocus(e, btns);
      if (b) return void rove(btns, b);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // A highlight dropdown closes first; then Esc leaves the toolbar for the text, selection kept.
        if (this.child) return this.closeChild();
        this.api.focus();
        this.hide();
      } else if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
        // One tab stop: Tab goes back to the text (the toolbar sits at the end of the page).
        e.preventDefault();
        this.closeChild();
        this.api.focus();
      }
    });
    n.addEventListener('focusin', (e) => {
      if (e.target.matches?.('button')) rove([...n.querySelectorAll('button')], e.target);
    });
    this.node = n;
    rove([...n.querySelectorAll('button')]);
  }

  /** Alt+F10: focus the toolbar's current button. */
  focusFirst() {
    if (!this.node) return;
    const btns = [...this.node.querySelectorAll('button')];
    const cur = btns.find((b) => b.tabIndex === 0 && usable(b)) || btns.find(usable);
    rove(btns, cur)?.focus();
  }

  openHl(btn) {
    if (this.child) return this.closeChild();
    const st = this.api.state();
    const child = openSwatches(
      btn,
      st.hl,
      (c) => {
        this.child = null;
        this.api.exec('highlight', c);
      },
      // However it closes (Esc, Tab, a pick, a click outside), the toolbar forgets it: the next press opens it.
      { onClose: () => this.child === child && (this.child = null) },
    );
    this.child = child;
  }

  openTypes(btn) {
    const st = this.api.state();
    btn.setAttribute('aria-expanded', 'true');
    this.menuOpen = true;
    openMenu(
      btn,
      TYPE_ITEMS.map((it) => (it.sep ? { sep: true } : { label: it.label, keys: SHORTCUTS[it.cmd], checked: st.blockType === it.t, onSelect: () => this.api.exec(it.cmd) })),
      {
        label: 'Turn into',
        onClose: () => {
          btn.setAttribute('aria-expanded', 'false');
          this.menuOpen = false;
          setTimeout(() => {
            if (!this.api.hasFocus()) this.api.focus();
          });
        },
      },
    );
  }

  closeChild() {
    this.child?.close(this.child.node?.contains(document.activeElement));
    this.child = null;
  }

  get visible() {
    return !!this.node?.isConnected;
  }

  contains(n) {
    return !!(n && ((this.node && this.node.contains(n)) || (this.child?.node && this.child.node.contains(n))));
  }

  show(rect) {
    if (!this.node) this.build();
    if (!this.node.isConnected) document.body.append(this.node);
    this.refresh();
    placeNear(this.node, rect, { side: 'top', gap: 10 });
    this.node.classList.add('on');
  }

  hide() {
    this.closeChild();
    this.node?.classList.remove('on');
    this.node?.remove();
  }

  refresh() {
    if (!this.node) return;
    const st = this.api.state();
    for (const b of MARK_BTNS) {
      const btn = this.node.querySelector(`[data-cmd="${b.cmd}"]`);
      btn?.setAttribute('aria-pressed', String(st.marks.includes(b.mark)));
      btn?.toggleAttribute('disabled', st.inCode);
    }
    const bar = this.node.querySelector('.ne-hlbar');
    if (bar) bar.dataset.hl = st.hl || this.api.lastHl();
    const ty = this.node.querySelector('.ne-tb-type .ne-tb-txt');
    if (ty) ty.textContent = st.multiType ? 'Mixed' : TYPE_LABEL[st.blockType] || 'Body';
    this.node.querySelector('[data-cmd="link-ui"]')?.setAttribute('aria-pressed', String(!!st.href));
  }
}

// ------------------------------------------------------------------ Aa format panel

export class FormatPanel {
  constructor(api) {
    this.api = api;
    this.node = null;
  }

  get isOpen() {
    return !!this.node;
  }

  contains(n) {
    return !!(n && this.node && this.node.contains(n));
  }

  /**
   * Open at `anchor` (an Aa button, or a rect). Opened from a button that has focus (the keyboard: mouse and
   * touch leave focus in the note), focus moves into the panel, to the current paragraph style; Esc (or Close)
   * brings it back to that button. The button's aria-expanded follows the panel.
   */
  open(anchor) {
    if (this.node) return this.close({ refocus: this.node.contains(document.activeElement) });
    const st = this.api.state();
    const btn = anchor instanceof Element ? anchor : null;
    this.trigger = btn && (document.activeElement === btn || btn.contains(document.activeElement)) ? btn : null;
    const n = el('div', { class: 'menu ne-aa', role: 'dialog', 'aria-label': 'Format' });
    keepFocus(n);
    const head = el('div', { class: 'ne-aa-head' }, el('span', { class: 'ne-aa-title', text: 'Format' }));
    const x = el('button', { type: 'button', class: 'ne-tb-btn ne-aa-x', 'aria-label': 'Close', 'data-tip': 'Close', 'data-keys': 'esc' }, svgIcon('x', { size: 16 }));
    x.addEventListener('click', () => this.close({ refocus: n.contains(document.activeElement) }));
    head.append(x);
    n.append(head);
    // Style row (a radio group: one tab stop, arrows move and choose, like any radio group)
    const styles = el('div', { class: 'ne-aa-styles', role: 'radiogroup', 'aria-label': 'Paragraph style' });
    for (const it of TYPE_ITEMS.slice(0, 5)) {
      const b = el('button', { type: 'button', class: `ne-aa-style ne-aa-${it.t}`, role: 'radio', 'aria-checked': String(st.blockType === it.t), 'data-cmd': it.cmd, 'data-t': it.t, 'data-tip': it.label, 'data-keys': SHORTCUTS[it.cmd] });
      b.append(el('span', { text: it.label }));
      styles.append(b);
    }
    styles.addEventListener('scroll', () => fadeEdges(styles), { passive: true });
    // A style that takes focus (on open, arrows, Tab) scrolls into view whole, clear of the edge fade (the row's
    // scroll-padding): focus() alone leaves a half-shown one where it is, its ring cut off.
    styles.addEventListener('focusin', (e) => e.target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }));
    n.append(styles);
    // Marks + lists rows
    const marks = el('div', { class: 'ne-aa-row ne-aa-seg', role: 'group', 'aria-label': 'Text style' });
    for (const b of MARK_BTNS.slice(0, 4)) marks.append(button({ icon: b.icon, label: b.label, keys: SHORTCUTS[b.cmd], cmd: b.cmd, pressed: st.marks.includes(b.mark) }));
    const lists = el('div', { class: 'ne-aa-row ne-aa-seg', role: 'group', 'aria-label': 'Lists' });
    for (const [cmd, icon, t] of [
      ['bullet', 'bullets', 'bullet'],
      ['dash', 'dashes', 'dash'],
      ['number', 'numbers', 'num'],
      ['quote', 'quote', 'quote'],
    ]) lists.append(button({ icon, label: TYPE_NAMES[t], keys: SHORTCUTS[cmd], cmd, pressed: st.blockType === t }));
    const ind = el('div', { class: 'ne-aa-row ne-aa-seg ne-aa-ind', role: 'group', 'aria-label': 'Indent' });
    ind.append(button({ icon: 'outdent', label: 'Outdent', keys: SHORTCUTS.outdent, cmd: 'outdent' }), button({ icon: 'indent', label: 'Indent', keys: SHORTCUTS.indent, cmd: 'indent' }));
    n.append(el('div', { class: 'ne-aa-line' }, marks, ind));
    n.append(el('div', { class: 'ne-aa-line' }, lists));
    n.append(swatchRow(st.hl, (c) => this.api.exec('highlight', c), { compact: true }));
    n.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cmd]');
      if (!b) return;
      this.api.exec(b.dataset.cmd);
    });
    n.addEventListener('keydown', (e) => this.onKey(e));
    // Tabbing out of the panel closes it (a click elsewhere does too, below).
    n.addEventListener('focusout', (e) => {
      const to = e.relatedTarget;
      if (to && !n.contains(to) && to !== this.trigger) this.close();
    });
    document.body.append(n);
    this.node = n;
    this.place(anchor);
    this.outside = (e) => {
      if (!n.contains(e.target) && !(anchor instanceof Element && anchor.contains(e.target))) this.close();
    };
    setTimeout(() => this.node && document.addEventListener('pointerdown', this.outside, true));
    this.anchor = anchor;
    if (btn) btn.setAttribute('aria-expanded', 'true');
    this.refresh();
    fadeEdges(styles);
    if (this.trigger) {
      const radios = [...styles.querySelectorAll('.ne-aa-style')];
      (radios.find((b) => b.getAttribute('aria-checked') === 'true') || radios[0])?.focus();
    }
  }

  onKey(e) {
    const n = this.node;
    if (!n) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close({ refocus: true });
      return;
    }
    if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      // Past its last control (or before its first) Tab leaves the panel: it closes, back to its button.
      const stops = [...n.querySelectorAll('button')].filter((b) => usable(b) && b.tabIndex >= 0);
      const i = stops.indexOf(document.activeElement);
      if ((e.shiftKey && i === 0) || (!e.shiftKey && i === stops.length - 1)) {
        e.preventDefault();
        this.close({ refocus: true });
      }
      return;
    }
    const radio = e.target.closest?.('.ne-aa-style');
    if (radio) {
      const radios = [...n.querySelectorAll('.ne-aa-style')];
      const b = moveFocus(e, radios);
      if (b) {
        rove(radios, b);
        this.api.exec(b.dataset.cmd); // selection follows focus, as in any radio group
      }
      return;
    }
    const row = e.target.closest?.('.ne-swatches, .ne-aa-seg');
    if (row) {
      const btns = [...row.querySelectorAll('button')];
      const b = moveFocus(e, btns);
      if (b && row.classList.contains('ne-swatches')) rove(btns, b);
    }
  }

  place(anchor = this.anchor) {
    if (!this.node) return;
    const acc = document.querySelector('.ne-acc.on');
    if (acc) {
      // Docked on the keyboard bar, flush (no gap for the note to show through).
      this.node.classList.add('docked');
      const r = acc.getBoundingClientRect();
      this.node.style.left = `${Math.max(0, (innerWidth - this.node.offsetWidth) / 2)}px`;
      this.node.style.top = `${Math.max(8, r.top - this.node.offsetHeight)}px`;
      fadeEdges(this.node.querySelector('.ne-aa-styles'));
      return;
    }
    const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor || this.api.selRect();
    placeNear(this.node, rect, { side: 'bottom', gap: 8 });
  }

  refresh() {
    const n = this.node;
    if (!n) return;
    const st = this.api.state();
    const radios = [...n.querySelectorAll('.ne-aa-style')];
    for (const b of radios) b.setAttribute('aria-checked', String(st.blockType === b.dataset.t));
    if (!radios.includes(document.activeElement)) rove(radios, radios.find((b) => b.getAttribute('aria-checked') === 'true'));
    for (const b of MARK_BTNS.slice(0, 4)) n.querySelector(`[data-cmd="${b.cmd}"]`)?.setAttribute('aria-pressed', String(st.marks.includes(b.mark)));
    for (const [cmd, t] of [['bullet', 'bullet'], ['dash', 'dash'], ['number', 'num'], ['quote', 'quote']]) n.querySelector(`[data-cmd="${cmd}"]`)?.setAttribute('aria-pressed', String(st.blockType === t));
    const sws = [...n.querySelectorAll('.ne-sw')];
    for (const b of sws) b.setAttribute('aria-pressed', String((b.dataset.hl || null) === (st.hl || null)));
    if (!sws.includes(document.activeElement)) rove(sws, sws.find((b) => b.getAttribute('aria-pressed') === 'true'));
    n.querySelector('[data-cmd="indent"]')?.toggleAttribute('disabled', !st.inList);
    n.querySelector('[data-cmd="outdent"]')?.toggleAttribute('disabled', !st.inList || !st.indent);
  }

  /** refocus: put focus back where the panel was opened from (its button, else the note at the same caret). */
  close({ refocus = false } = {}) {
    if (!this.node) return;
    document.removeEventListener('pointerdown', this.outside, true);
    this.node.remove();
    this.node = null;
    const trigger = this.trigger;
    this.trigger = null;
    if (this.anchor instanceof Element) this.anchor.setAttribute('aria-expanded', 'false');
    if (refocus) {
      if (trigger?.isConnected) trigger.focus();
      else this.api.focus();
    }
    this.api.onPanelClose?.();
  }
}

// ------------------------------------------------------------------ phone keyboard accessory bar

export class AccessoryBar {
  constructor(api) {
    this.api = api;
    this.node = null;
    this.onVV = () => this.position();
  }

  build() {
    const n = el('div', { class: 'ne-acc', role: 'toolbar', 'aria-label': 'Editing tools' });
    keepFocus(n);
    const strip = el('div', { class: 'ne-acc-strip' });
    strip.addEventListener('scroll', () => this.updateFade(), { passive: true });
    this.strip = strip;
    // A drawn Aa (not the string in the UI font), named like the note's own Aa buttons.
    const aa = button({ icon: 'text-style', label: 'Text styles', cmd: 'aa', cls: 'ne-acc-aa' });
    aa.setAttribute('aria-haspopup', 'dialog');
    aa.setAttribute('aria-expanded', 'false');
    strip.append(
      aa,
      button({ icon: 'checklist', label: 'Checklist', cmd: 'checklist', pressed: false }),
      button({ icon: 'plus', label: 'Insert', cmd: 'insert' }),
      button({ icon: 'indent', label: 'Indent', cmd: 'indent' }),
      button({ icon: 'outdent', label: 'Outdent', cmd: 'outdent' }),
      button({ icon: 'link', label: 'Link', cmd: 'link-ui' }),
      button({ icon: 'undo', label: 'Undo', cmd: 'undo' }),
      button({ icon: 'redo', label: 'Redo', cmd: 'redo' }),
    );
    n.append(strip, button({ icon: 'keyboard-hide', label: 'Hide keyboard', cmd: 'hide-keyboard', cls: 'ne-acc-hide' }));
    n.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cmd]');
      if (!b || b.disabled) return;
      const cmd = b.dataset.cmd;
      if (cmd === 'aa') return this.api.exec('aa', b);
      if (cmd === 'insert') return this.api.exec('insert', b);
      if (cmd === 'link-ui') return this.api.linkUI();
      this.api.exec(cmd);
    });
    this.node = n;
  }

  get visible() {
    return !!this.node?.classList.contains('on');
  }

  show() {
    if (!this.node) this.build();
    if (!this.node.isConnected) document.body.append(this.node);
    this.node.classList.add('on');
    this.refresh();
    this.position();
    const vv = window.visualViewport;
    vv?.addEventListener('resize', this.onVV);
    vv?.addEventListener('scroll', this.onVV);
    window.addEventListener('scroll', this.onVV, { passive: true });
  }

  hide() {
    if (!this.node) return;
    this.node.classList.remove('on');
    this.node.remove();
    const vv = window.visualViewport;
    vv?.removeEventListener('resize', this.onVV);
    vv?.removeEventListener('scroll', this.onVV);
    window.removeEventListener('scroll', this.onVV);
  }

  /** Sit on top of the on-screen keyboard (visualViewport; iOS has no interactive-widget). */
  position() {
    if (!this.node) return;
    const vv = window.visualViewport;
    const inset = vv ? Math.max(0, innerHeight - (vv.offsetTop + vv.height)) : 0;
    this.node.style.transform = inset ? `translateY(${-Math.round(inset)}px)` : '';
    this.updateFade();
    this.api.onAccessoryMove?.();
  }

  /** On screens too narrow for every tool the strip scrolls: fade the edge that has more beyond it. */
  updateFade() {
    fadeEdges(this.strip);
  }

  refresh() {
    if (!this.node) return;
    const st = this.api.state();
    this.node.querySelector('[data-cmd="undo"]')?.toggleAttribute('disabled', !st.canUndo);
    this.node.querySelector('[data-cmd="redo"]')?.toggleAttribute('disabled', !st.canRedo);
    this.node.querySelector('[data-cmd="checklist"]')?.setAttribute('aria-pressed', String(st.blockType === 'check'));
    this.node.querySelector('[data-cmd="indent"]')?.toggleAttribute('disabled', !st.inList);
    this.node.querySelector('[data-cmd="outdent"]')?.toggleAttribute('disabled', !st.inList || !st.indent);
    this.node.querySelector('[data-cmd="link-ui"]')?.setAttribute('aria-pressed', String(!!st.href));
  }
}

// ------------------------------------------------------------------ link card (caret inside a URL link)

export class LinkCard {
  constructor(api) {
    this.api = api;
    this.node = null;
    this.href = null;
  }

  get visible() {
    return !!this.node;
  }

  contains(n) {
    return !!(n && this.node && this.node.contains(n));
  }

  show(rect, href) {
    if (this.node && this.href === href) {
      placeNear(this.node, rect, { side: 'bottom', gap: 6 });
      return;
    }
    this.hide();
    this.href = href;
    const host = hrefHost(href) || href;
    const n = el('div', { class: 'menu ne-linkcard', role: 'dialog', 'aria-label': `Link to ${host}` });
    keepFocus(n);
    const open = el('button', { type: 'button', class: 'ne-lc-open', 'aria-label': `Open ${host}`, 'data-tip': 'Open link' });
    open.append(svgIcon('external', { size: 16 }), el('span', { class: 'ne-lc-text' }, el('span', { class: 'ne-lc-host truncate', text: host }), el('span', { class: 'ne-lc-url truncate', text: href })));
    open.addEventListener('click', () => this.api.openHref(href));
    const edit = el('button', { type: 'button', class: 'ne-tb-btn', 'aria-label': 'Edit link', 'data-tip': 'Edit link', 'data-keys': 'mod K' }, svgIcon('edit', { size: 16 }));
    edit.addEventListener('click', () => this.api.linkUI());
    const rm = el('button', { type: 'button', class: 'ne-tb-btn', 'aria-label': 'Remove link', 'data-tip': 'Remove link' }, svgIcon('unlink', { size: 16 }));
    rm.addEventListener('click', () => this.api.exec('link', null));
    n.append(open, el('span', { class: 'ne-tb-sep', 'aria-hidden': 'true' }), edit, rm);
    cardKeys(n, {
      back: () => {
        this.api.focus();
        this.hide();
      },
      hide: () => this.hide(),
    });
    document.body.append(n);
    this.node = n;
    placeNear(n, rect, { side: 'bottom', gap: 6 });
  }

  /** Alt+F10: focus the card's first button (Open). */
  focusFirst() {
    this.node?.querySelector('button')?.focus();
  }

  hide() {
    this.node?.remove();
    this.node = null;
    this.href = null;
  }
}

/**
 * The link field (Mod+K): a URL input plus "Link to note…" (and "Remove link" when editing).
 * Esc or a click outside cancels. onApply(href|null) · onNote() · onClose(applied).
 */
export function openLinkField(rect, { href = '', canNote = true, onApply, onNote, onClose } = {}) {
  let applied = false;
  let closed = false;
  const pop = el('div', { class: 'menu ne-lf-pop', role: 'dialog', 'aria-label': href ? 'Edit link' : 'Add link' });
  const form = el('form', { class: 'ne-lf', novalidate: true });
  const input = el('input', { class: 'input ne-lf-input', type: 'text', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Link address', placeholder: 'Paste or type a link' });
  input.value = href || '';
  const go = el('button', { type: 'submit', class: 'btn btn-primary btn-sm ne-lf-go', text: href ? 'Save' : 'Link' });
  const err = el('p', { class: 'ne-lf-err', role: 'alert', text: 'Enter a web address, email or phone number.' });
  err.hidden = true;
  form.append(el('div', { class: 'ne-lf-row' }, input, go), err);
  pop.append(form);
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', outside, true);
    pop.remove();
    onClose?.(applied);
  };
  const outside = (e) => {
    if (!pop.contains(e.target)) close();
  };
  const finish = (fn) => {
    applied = true;
    close();
    fn();
  };
  if (canNote && onNote) {
    const b = el('button', { type: 'button', class: 'menu-item ne-lf-note' }, svgIcon('note', { size: 18 }), el('span', { class: 'grow', text: 'Link to note, task or event…' }), el('span', { class: 'ne-opt-hint', text: '[[' }));
    b.addEventListener('click', () => finish(() => onNote()));
    pop.append(b);
  }
  if (href) {
    const rm = el('button', { type: 'button', class: 'menu-item danger ne-lf-rm' }, svgIcon('unlink', { size: 18 }), el('span', { class: 'grow', text: 'Remove link' }));
    rm.addEventListener('click', () => finish(() => onApply?.(null)));
    pop.append(rm);
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return finish(() => onApply?.(null));
    const h = hrefFromInput(v);
    if (!h) {
      err.hidden = false;
      input.select();
      return;
    }
    finish(() => onApply?.(h));
  });
  input.addEventListener('input', () => (err.hidden = true));
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  document.body.append(pop);
  placeNear(pop, rect, { side: 'bottom', gap: 8 });
  setTimeout(() => !closed && document.addEventListener('pointerdown', outside, true));
  input.focus({ preventScroll: true });
  input.select();
  return { close, node: pop };
}

// ------------------------------------------------------------------ chip hover card

export class ChipCard {
  constructor(api) {
    this.api = api;
    this.node = null;
    this.chip = null;
    this.timer = 0;
  }

  get visible() {
    return !!this.node;
  }

  contains(n) {
    return !!(n && this.node && this.node.contains(n));
  }

  /** info: {kind, ref, title, sub, done, missing, trashed} */
  show(chip, info) {
    this.hide();
    this.chip = chip;
    const n = el('div', { class: 'menu ne-chipcard', role: 'dialog', 'aria-label': info.title || 'Link' });
    keepFocus(n);
    const head = el('div', { class: 'ne-cc-head' });
    // From the keyboard (focus in the card), a button that closes the card hands focus back to the note.
    const backAfter = (fn) => (e) => {
      const kb = n.contains(document.activeElement);
      this.hide();
      if (kb) this.api.focus();
      fn(e);
    };
    if (info.kind === 'task' && !info.missing && !info.readOnly) {
      const t = el('button', { type: 'button', class: `ne-cc-task${info.done ? ' done' : ''}`, 'aria-label': info.done ? 'Mark task not done' : 'Complete task', 'data-tip': info.done ? 'Mark not done' : 'Complete' });
      t.append(taskCircle(info.done));
      t.addEventListener('click', backAfter(() => this.api.toggleTask(info.ref)));
      head.append(t);
    } else if (info.kind === 'task') head.append(el('span', { class: 'ne-cc-task', 'aria-hidden': 'true' }, taskCircle(!!info.done)));
    else head.append(svgIcon(info.kind === 'event' || info.kind === 'day' ? 'calendar' : 'note', { size: 18, cls: 'ne-cc-ic' }));
    head.append(el('span', { class: 'ne-cc-text' }, el('span', { class: 'ne-cc-title truncate', text: info.title || 'Untitled' }), info.sub ? el('span', { class: 'ne-cc-sub truncate', text: info.sub }) : null));
    n.append(head);
    if (info.preview) n.append(el('p', { class: 'ne-cc-preview', text: String(info.preview).slice(0, 400) }));
    if (info.missing || info.trashed) n.append(el('p', { class: 'ne-cc-missing', text: info.trashed ? 'In Recently Deleted' : 'This item was deleted' }));
    const actions = el('div', { class: 'ne-cc-actions' });
    if (!info.missing || info.trashed) {
      const open = el('button', { type: 'button', class: 'btn btn-tint btn-sm', text: info.trashed ? 'Recover' : 'Open' });
      open.addEventListener('click', backAfter((e) => this.api.activate(info.ref, e, info.trashed ? 'recover' : 'open')));
      actions.append(open);
    }
    if (actions.childNodes.length) n.append(actions);
    n.addEventListener('pointerleave', () => this.scheduleHide());
    n.addEventListener('pointerenter', () => clearTimeout(this.timer));
    cardKeys(n, {
      back: () => {
        this.api.focus();
        this.hide();
      },
      hide: () => this.hide(),
    });
    document.body.append(n);
    this.node = n;
    placeNear(n, chip.getBoundingClientRect(), { side: 'bottom', gap: 6 });
  }

  /** Alt+F10: focus the card's first button (Complete for a task, else Open). */
  focusFirst() {
    this.node?.querySelector('button')?.focus();
  }

  scheduleHide(ms = 250) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.node?.contains(document.activeElement)) this.hide(); // never under the keyboard's feet
    }, ms);
  }

  hide() {
    clearTimeout(this.timer);
    this.node?.remove();
    this.node = null;
    this.chip = null;
  }
}
