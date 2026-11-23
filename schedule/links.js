// schedule — links in what people type (an event's description and place, a task's notes): web addresses,
// e-mail addresses and links to the ecosys apps become links, as in Google and Apple Calendar (a Zoom link in
// a description, Notes' "Copy link" in a task). Pure (no DOM), so it is unit-tested in Node:
// tests/qa-schedule-links.test.js. Every href passes the notes' link allowlist (shared/sanitize.js cleanHref).
import { cleanHref, escapeHtml } from '../shared/sanitize.js';

// Where a link starts inside a word ("Join:https://…"); "www." is read as https.
const LINK_START = /(?:https?:\/\/|mailto:|www\.)/i;
const EMAIL = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/;
// A path to one of the apps, as Notes and Tasks write them ("/notes/#/n/…", "../tasks/#/task/…").
const APP_PATH = /^(?:\.\.)?\/(notes|tasks|schedule)\/(#\/[^\s<>"'`]*)$/;
const OPENERS = /^[(\[<"'“‘]+/;
const CLOSERS = /[.,;:!?"'”’…>\]]/;
const MAX = 2048; // cleanHref's limit: anything longer stays text

/** One word: its link (with the brackets and punctuation around it outside), or the word as text. */
function linkWord(word, base, origin) {
  let lead = '';
  let core = word;
  const at = core.search(LINK_START);
  if (at > 0 && !/[\w.-]/.test(core[at - 1])) {
    lead = core.slice(0, at);
    core = core.slice(at);
  }
  const open = OPENERS.exec(core)?.[0] || '';
  lead += open;
  core = core.slice(open.length);
  if (!core || core.length > MAX) return escapeHtml(word);
  // Trailing punctuation is the sentence's, not the link's ("see https://x.com/a."); a closing bracket is the
  // link's only when it closes one of its own ("…/Ecosys_(app)").
  let opens = 0;
  let closes = 0;
  for (const c of core) {
    if (c === '(') opens++;
    else if (c === ')') closes++;
  }
  let trail = '';
  while (core) {
    const c = core[core.length - 1];
    if (CLOSERS.test(c) || (c === ')' && closes > opens)) {
      if (c === ')') closes--;
      trail = c + trail;
      core = core.slice(0, -1);
    } else break;
  }
  if (!core) return escapeHtml(word);
  let href = null;
  let app = false;
  if (/^(?:https?:\/\/|mailto:)/i.test(core)) href = cleanHref(core);
  else if (/^www\.[^.]+\.\S/i.test(core)) href = cleanHref(`https://${core}`);
  else if (EMAIL.test(core)) href = cleanHref(`mailto:${core}`);
  else {
    const m = APP_PATH.exec(core);
    if (m) {
      href = `${base}${m[1]}/${m[2]}`;
      app = true;
    }
  }
  if (!href) return escapeHtml(word);
  // Another site opens in a new tab; this one (another ecosys app) opens in place, as the apps' own links do.
  let away = false;
  if (!app && /^https?:/i.test(href)) {
    try {
      away = new URL(href).origin !== origin;
    } catch {
      return escapeHtml(word);
    }
  }
  return `${escapeHtml(lead)}<a href="${escapeHtml(href)}"${away ? ' target="_blank" rel="noopener noreferrer"' : ''}>${escapeHtml(core)}</a>${escapeHtml(trail)}`;
}

/**
 * `text` as HTML: escaped, with its links as <a> elements. Read as links: http(s) and mailto: addresses,
 * "www." addresses (as https), e-mail addresses (as mailto:) and paths to the ecosys apps ("/notes/#/n/…").
 * Links to other sites open in a new tab (rel="noopener noreferrer"); links to `origin` open in place.
 * `base` is the apps' root path ('/', or '/ecosys/' on GitHub Pages) that app paths are resolved against.
 * Linear in the length of the text (it goes word by word), whatever is pasted.
 */
export function linkify(text, { base = '/', origin = '' } = {}) {
  let out = '';
  for (const part of String(text ?? '').split(/(\s+)/)) {
    if (!part) continue;
    out += /^\s/.test(part) ? escapeHtml(part) : linkWord(part, base, origin);
  }
  return out;
}
