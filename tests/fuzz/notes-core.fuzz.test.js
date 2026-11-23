// Property/fuzz tests for notes/core (schema.js, markdown.js, search.js) — skipped for modules that
// are not present. Schema validation, Markdown parsing and search must never throw; validated data
// must satisfy the notes-spec section 4 invariants; Markdown must round-trip; search results and
// highlights must be consistent and safe. Two integration checks run in child processes: what a
// page that never imported notes/core/schema.js, and what the server, keep of a canonical note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { SEED, runs, forAll, fail, check, assume, shrinkString, shrinkValue, show, sameContent, firstDiff, reproduce } from './lib/harness.js';
import { genBlocks, genNote, genFolder, mdSoup, mdText, genQuery, genRef, BLOCK_TYPES } from './lib/notes-gen.js';
import { hostileHtml, canonicalHtml, hostileUrl } from './lib/html-gen.js';
import { browserScheme } from './lib/html-check.js';
import { jsonValue } from './lib/json-gen.js';
import { runScript } from './lib/child.js';
import * as S from '../../shared/sanitize.js';

async function load(rel) {
  const url = new URL(rel, import.meta.url);
  if (!existsSync(url)) return { missing: true };
  try {
    return { mod: await import(url.href) };
  } catch (err) {
    return { error: `${err?.name}: ${err?.message}` };
  }
}
const L = { schema: await load('../../notes/core/schema.js'), markdown: await load('../../notes/core/markdown.js'), search: await load('../../notes/core/search.js') };
const SC = L.schema.mod;
const MD = L.markdown.mod;
const SE = L.search.mod;
console.log(`# notes-core fuzz: seed ${SEED}; schema ${SC ? 'loaded' : L.schema.missing ? 'missing' : 'BROKEN'}, markdown ${MD ? 'loaded' : L.markdown.missing ? 'missing' : 'BROKEN'}, search ${SE ? 'loaded' : L.search.missing ? 'missing' : 'BROKEN'} (reproduce: ${reproduce()})`);

for (const [name, l] of Object.entries(L)) {
  if (l.error) test(`notes/core/${name}.js imports without errors`, () => assert.fail(l.error));
}
const needs = (...mods) => (mods.every(Boolean) ? {} : { skip: 'notes/core module not present' });

// ---------------------------------------------------------------- independent invariant checks

const ID_RE = /^[a-z0-9_-]{1,40}$/i;
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const BIDI = new RegExp(`[${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}]`);
// eslint-disable-next-line no-control-regex
const RUN_CTRL = /[\u0000-\u0008\u000B-\u001F\u007F]/; // \n allowed (\t only in code, checked below)
const LIST = new Set(['bullet', 'dash', 'num', 'check']);
const HEAD = new Set(['h1', 'h2', 'h3']);
const ATTR_ORDER = ['ref', 'href', 'hl', 'atom'];
const isTs = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 8.64e15;

function hrefProblem(h) {
  if (typeof h !== 'string' || !h || h.length > 2048) return `href ${show(h, 80)}`;
  if (!['http', 'https', 'mailto', 'tel'].includes(browserScheme(h))) return `unsafe href scheme ${show(browserScheme(h))} in ${show(h, 80)}`;
  if (SC.safeHref(h) !== h) return `href is not canonical (safeHref gives ${show(SC.safeHref(h), 80)})`;
  return null;
}

function runsProblem(c, t) {
  if (!Array.isArray(c)) return 'c is not an array';
  let total = 0;
  for (let i = 0; i < c.length; i++) {
    const r = c[i];
    if (!Array.isArray(r) || r.length < 1 || r.length > 3) return `run #${i} shape ${show(r, 80)}`;
    const [text, marks = '', attrs = null] = r;
    if (typeof text !== 'string' || !text) return `run #${i} text ${show(text, 40)}`;
    if (RUN_CTRL.test(text) || text.includes(LS) || text.includes(PS) || !text.isWellFormed()) return `run #${i} has control characters / lone surrogates: ${show(text, 60)}`;
    if (t !== 'code' && text.includes('\t')) return `run #${i} has a tab outside code`;
    total += text.length;
    if (r.length >= 2) {
      if (typeof marks !== 'string') return `run #${i} marks ${show(marks)}`;
      if (r.length === 2 && !marks) return `run #${i} has an empty marks slot`;
      if (marks !== [...'biusc'].filter((m) => marks.includes(m)).join('') || marks.length !== new Set(marks).size) return `run #${i} marks ${show(marks)} not canonical`;
    }
    if (r.length === 3) {
      if (!S.isPlainObject(attrs) || !Object.keys(attrs).length) return `run #${i} attrs ${show(attrs)}`;
      const keys = Object.keys(attrs);
      if (keys.some((k) => !ATTR_ORDER.includes(k)) || keys.join() !== ATTR_ORDER.filter((k) => k in attrs).join()) return `run #${i} attr keys ${show(keys)}`;
      if ('ref' in attrs && !SC.parseRef(attrs.ref)) return `run #${i} ref ${show(attrs.ref)}`;
      if ('href' in attrs) {
        if ('ref' in attrs) return `run #${i} has both ref and href`;
        const p = hrefProblem(attrs.href);
        if (p) return `run #${i} ${p}`;
      }
      if ('hl' in attrs && !SC.HIGHLIGHTS.includes(attrs.hl)) return `run #${i} hl ${show(attrs.hl)}`;
      if ('atom' in attrs && (attrs.atom !== 1 || !('ref' in attrs))) return `run #${i} atom without ref`;
      if (attrs.atom && (marks || text.includes('\n'))) return `run #${i} chip with marks or a line break`;
    }
    const prev = c[i - 1];
    if (prev && !prev[2]?.atom && !attrs?.atom && (prev[1] || '') === marks && JSON.stringify(prev[2] || null) === JSON.stringify(attrs || null)) return `runs #${i - 1}/#${i} are mergeable (not normalized)`;
  }
  if (t === 'code' && (c.length > 1 || (c[0] && c[0].length > 1))) return 'code block runs have marks/attrs or several runs';
  if (total > SC.NOTE_LIMITS.blockChars) return `block text ${total} > ${SC.NOTE_LIMITS.blockChars}`;
  return null;
}

function blocksProblem(blocks) {
  if (!Array.isArray(blocks)) return 'blocks is not an array';
  if (blocks.length > SC.NOTE_LIMITS.blocks) return `${blocks.length} blocks`;
  const ids = new Set();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!S.isPlainObject(b)) return `block #${i} is not an object`;
    if (!ID_RE.test(b.id) || ids.has(b.id)) return `block #${i} id ${show(b.id)} invalid or repeated`;
    ids.add(b.id);
    if (!BLOCK_TYPES.includes(b.t)) return `block #${i} type ${show(b.t)}`;
    const keys = Object.keys(b);
    if (b.t === 'hr') {
      if (keys.join() !== 'id,t') return `hr block keys ${show(keys)}`;
      continue;
    }
    const order = ['id', 't', 'in', 'ck', 'task', 'start', 'lang', 'fold', 'c'];
    if (keys.some((k) => !order.includes(k)) || keys.join() !== order.filter((k) => k in b).join()) return `block #${i} keys ${show(keys)}`;
    if (!('c' in b)) return `block #${i} has no c`;
    if ('in' in b !== LIST.has(b.t) || (LIST.has(b.t) && !(Number.isInteger(b.in) && b.in >= 0 && b.in <= 6))) return `block #${i} (${b.t}) in=${show(b.in)}`;
    if ('ck' in b !== (b.t === 'check') || ('ck' in b && typeof b.ck !== 'boolean')) return `block #${i} (${b.t}) ck=${show(b.ck)}`;
    if ('task' in b && (b.t !== 'check' || !ID_RE.test(b.task))) return `block #${i} task=${show(b.task)}`;
    if ('start' in b && (b.t !== 'num' || !Number.isInteger(b.start) || b.start < 0 || b.start === 1 || b.start > 999999999)) return `block #${i} start=${show(b.start)}`;
    if ('lang' in b && (b.t !== 'code' || !/^[\w+-]{1,20}$/.test(b.lang))) return `block #${i} lang=${show(b.lang)}`;
    if ('fold' in b && (!HEAD.has(b.t) || b.fold !== true)) return `block #${i} fold=${show(b.fold)}`;
    const p = runsProblem(b.c, b.t);
    if (p) return `block #${i} (${b.t}): ${p}`;
  }
  return null;
}

const NOTE_KEYS = ['id', 'v', 'rev', 'blocks', 'title', 'tags', 'links', 'folderId', 'pinned', 'day', 'event', 'aiHidden', 'aiPrev', 'locked', 'editedBy', 'editedAt', 'createdAt', 'updatedAt', 'trashedAt', 'trashedFrom'];
function noteProblem(n) {
  if (!S.isPlainObject(n)) return `not an object: ${show(n, 80)}`;
  if (Object.keys(n).join() !== NOTE_KEYS.join()) return `keys ${show(Object.keys(n))}`;
  if (!ID_RE.test(n.id)) return `id ${show(n.id)}`;
  if (n.v !== SC.NOTE_FORMAT) return `v ${n.v}`;
  if (!(Number.isInteger(n.rev) && n.rev >= 0 && n.rev <= 1e12)) return `rev ${show(n.rev)}`;
  const bp = blocksProblem(n.blocks);
  if (bp) return `blocks: ${bp}`;
  if (JSON.stringify(n.blocks).length > SC.NOTE_LIMITS.noteBytes) return `blocks are ${JSON.stringify(n.blocks).length} chars of JSON`;
  if (typeof n.title !== 'string' || n.title.length > SC.NOTE_LIMITS.titleChars || n.title !== n.title.trim() || /\n/.test(n.title)) return `title ${show(n.title, 80)}`;
  if (!Array.isArray(n.tags) || n.tags.length > SC.NOTE_LIMITS.tags || new Set(n.tags).size !== n.tags.length || n.tags.some((t) => SC.normalizeTag(t) !== t)) return `tags ${show(n.tags, 120)}`;
  if (!Array.isArray(n.links) || n.links.length > SC.NOTE_LIMITS.links || new Set(n.links).size !== n.links.length || n.links.some((r) => !SC.parseRef(r))) return `links ${show(n.links, 120)}`;
  if (!n.locked) {
    const d = SC.deriveFields({ blocks: n.blocks });
    if (d.title !== n.title || !sameContent(d.tags, n.tags) || !sameContent(d.links, n.links)) return `derived fields differ from deriveFields(blocks): ${firstDiff({ title: n.title, tags: n.tags, links: n.links }, d)}`;
  } else if (n.blocks.length || n.aiPrev) return 'a locked note keeps blocks or aiPrev';
  if (!(n.folderId === null || ID_RE.test(n.folderId)) || !(n.trashedFrom === null || ID_RE.test(n.trashedFrom))) return 'folderId / trashedFrom';
  if (typeof n.pinned !== 'boolean' || typeof n.aiHidden !== 'boolean') return 'pinned / aiHidden';
  if (!(n.day === null || S.isYmd(n.day))) return `day ${show(n.day)}`;
  if (!(n.event === null || (S.isPlainObject(n.event) && Object.keys(n.event).join() === 'id,date' && ID_RE.test(n.event.id) && S.isYmd(n.event.date)))) return `event ${show(n.event)}`;
  if (n.aiPrev !== null && !(S.isPlainObject(n.aiPrev) && isTs(n.aiPrev.at) && SC.EDITORS.includes(n.aiPrev.by) && Number.isInteger(n.aiPrev.rev) && !blocksProblem(n.aiPrev.blocks))) return `aiPrev ${show(n.aiPrev, 120)}`;
  if (!SC.EDITORS.includes(n.editedBy)) return `editedBy ${show(n.editedBy)}`;
  if (![n.editedAt, n.createdAt, n.updatedAt].every(isTs) || !(n.trashedAt === null || isTs(n.trashedAt))) return 'timestamps';
  const size = JSON.stringify(n).length;
  if (size > (S.ITEM_JSON_MAX ?? 512 * 1024)) return `record is ${size} chars of JSON; the server refuses records over ${S.ITEM_JSON_MAX ?? 512 * 1024}`;
  return null;
}

/** validateNote for building inputs of other properties (its own crashes are reported by the validateNote property). */
const safeNote = (raw) => {
  try {
    return SC.validateNote(raw);
  } catch {
    return null;
  }
};
const safeBlocks = (raw) => {
  try {
    return SC.validateBlocks(raw);
  } catch {
    return [];
  }
};

const blocksSafe = (blocks) => {
  const p = blocksProblem(blocks);
  if (p) fail('blocks', `${p}\n  blocks: ${show(blocks, 400)}`);
};

// ---------------------------------------------------------------- schema.js

test('schema: validateBlocks never throws; output is canonical (types, ids, marks, attrs, safe hrefs, limits) and idempotent', needs(SC), (t) => {
  const r = forAll('notes.validateBlocks', {
    runs: runs(3000),
    gen: (rng) => (rng.chance(0.9) ? genBlocks(rng) : jsonValue(rng)),
    prop: (raw) => {
      let out;
      try {
        out = SC.validateBlocks(raw);
      } catch (err) {
        fail('throws', `validateBlocks threw ${err?.name}: ${err?.message}`);
      }
      blocksSafe(out);
      const again = SC.validateBlocks(out);
      check(sameContent(again, out), 'idempotent', () => `validateBlocks is not idempotent: ${firstDiff(out, again)}`);
    },
    shrink: shrinkValue,
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

test('schema: validateNote never throws; rejects bad ids; output satisfies every note invariant (derived fields, limits, server size) and is idempotent', needs(SC), (t) => {
  const r = forAll('notes.validateNote', {
    runs: runs(2000),
    gen: (rng) => (rng.chance(0.92) ? genNote(rng) : jsonValue(rng)),
    prop: (raw) => {
      let out;
      try {
        out = SC.validateNote(raw);
      } catch (err) {
        fail('throws', `validateNote threw ${err?.name}: ${err?.message}`);
      }
      if (!S.isPlainObject(raw) || !(typeof raw.id === 'string' && ID_RE.test(raw.id))) return check(out === null, 'bad-id', () => `accepted a note with id ${show(raw?.id)}`);
      const p = noteProblem(out);
      check(!p, 'invariant', () => p);
      const again = SC.validateNote(out);
      check(sameContent(again, out), 'idempotent', () => `validateNote is not idempotent: ${firstDiff(out, again)}`);
    },
    shrink: shrinkValue,
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

test('schema: validateFolder never throws; names are clean (1-60 chars, no "/"), parent is never itself; idempotent', needs(SC), (t) => {
  const r = forAll('notes.validateFolder', {
    runs: runs(2000),
    gen: (rng) => (rng.chance(0.9) ? genFolder(rng) : jsonValue(rng)),
    prop: (raw) => {
      let f;
      try {
        f = SC.validateFolder(raw);
      } catch (err) {
        fail('throws', `validateFolder threw ${err?.message}`);
      }
      if (f === null) return check(!S.isPlainObject(raw) || !(typeof raw.id === 'string' && ID_RE.test(raw.id)), 'rejected', 'a folder with a valid id was rejected');
      check(typeof f.name === 'string' && f.name.length >= 1 && f.name.length <= SC.NOTE_LIMITS.folderName && !f.name.includes('/') && f.name === f.name.trim() && f.name.isWellFormed() && !/[\u0000-\u001F]/.test(f.name), 'name', () => `name ${show(f.name)}`);
      check(f.parentId === null || (ID_RE.test(f.parentId) && f.parentId !== f.id), 'parent', () => `parentId ${show(f.parentId)}`);
      check(S.COLORS.includes(f.color), 'color', () => `color ${show(f.color)}`);
      check(sameContent(SC.validateFolder(f), f), 'idempotent', () => firstDiff(f, SC.validateFolder(f)));
    },
    shrink: shrinkValue,
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

test('schema: htmlToBlocks turns hostile HTML into canonical blocks with safe links only', needs(SC), (t) => {
  const r = forAll('notes.htmlToBlocks', {
    runs: runs(2000),
    gen: (rng) => (rng.chance(0.6) ? hostileHtml(rng) : canonicalHtml(rng)),
    prop: (html) => {
      let out;
      try {
        out = SC.htmlToBlocks(html);
      } catch (err) {
        fail('throws', `htmlToBlocks threw ${err?.name}: ${err?.message}`);
      }
      blocksSafe(out);
    },
    shrink: shrinkString,
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

test('schema: safeHref only returns http/https/mailto/tel URLs (checked the way a browser parses them)', needs(SC), (t) => {
  const r = forAll('notes.safeHref', {
    runs: runs(5000),
    gen: (rng) => (rng.chance(0.85) ? hostileUrl(rng) : mdText(rng)),
    prop: (raw) => {
      let h;
      try {
        h = SC.safeHref(raw);
      } catch (err) {
        fail('throws', `safeHref threw ${err?.message}`);
      }
      if (h === null) return;
      const p = hrefProblem(h);
      check(!p, 'href', () => p);
      check(!BIDI.test(h), 'bidi', () => `bidi control kept in ${show(h)}`);
    },
    shrink: shrinkString,
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

test('schema: parseRef/formatRef round-trip; normalizeTag is idempotent and canonical', needs(SC), (t) => {
  const r = forAll('notes.refs-tags', {
    runs: runs(4000),
    gen: (rng) => ({ ref: genRef(rng), tag: rng.chance(0.5) ? mdText(rng, rng.int(1, 3)) : rng.pick(['Work', '#Work/Clients-', 'ünï/Ab', 'a//b', '-x', '_', '1', 'x'.repeat(70), 'İstanbul', 'ﬁle', 'é']) }),
    prop: ({ ref, tag }) => {
      const p = SC.parseRef(ref);
      if (p) check(SC.formatRef(p) === ref, 'ref', () => `formatRef(parseRef(${show(ref)})) = ${show(SC.formatRef(p))}`);
      const n = SC.normalizeTag(tag);
      if (n !== null) {
        check(SC.normalizeTag(n) === n, 'tag-idempotent', () => `normalizeTag(${show(tag)}) = ${show(n)} but normalizeTag(${show(n)}) = ${show(SC.normalizeTag(n))}`);
        check(n === n.toLowerCase() && n.length <= SC.NOTE_LIMITS.tagChars && /^[\p{L}\p{N}_][\p{L}\p{N}_\-/]*$/u.test(n) && /\p{L}/u.test(n) && !/[/-]$/.test(n), 'tag-shape', () => `normalizeTag(${show(tag)}) = ${show(n)}`);
      }
    },
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

test('schema: deriveFields / noteStats / tag rewrites never throw on validated notes and keep blocks canonical', needs(SC), (t) => {
  const r = forAll('notes.derived', {
    runs: runs(1500),
    gen: (rng) => ({ note: genNote(rng), from: rng.pick(['work', 'Work/Clients', 'home', 'a', 'tag']), to: rng.pick(['job', 'Life', 'x/y', 'tag2']) }),
    prop: ({ note, from, to }) => {
      const n = safeNote(note);
      assume(n);
      const st = SC.noteStats(n);
      const checks = n.blocks.filter((b) => b.t === 'check' && SC.blockText(b).trim()); // an item without text is no to-do
      check(Number.isInteger(st.words) && st.words >= 0 && Number.isInteger(st.chars) && st.chars >= 0, 'stats', () => show(st));
      check(st.checks.open + st.checks.done === checks.length && st.checks.done === checks.filter((b) => b.ck).length, 'stats-checks', () => `${show(st.checks)} for ${checks.length} check blocks`);
      const f = SC.normalizeTag(from);
      const tt = SC.normalizeTag(to);
      const ren = SC.renameTagInBlocks(n.blocks, from, to);
      blocksSafe(ren.blocks);
      if (f && tt && !SC.tagMatches(tt, f) && !SC.tagMatches(f, tt)) {
        const tags = SC.deriveFields({ blocks: ren.blocks }).tags;
        check(!tags.some((x) => SC.tagMatches(x, f)), 'rename', () => `after renaming #${f} to #${tt}, tags still include ${show(tags.filter((x) => SC.tagMatches(x, f)))}`);
      }
      const rem = SC.removeTagFromBlocks(n.blocks, from);
      blocksSafe(rem.blocks);
      if (f) check(!SC.deriveFields({ blocks: rem.blocks }).tags.some((x) => SC.tagMatches(x, f)), 'remove', () => `#${f} still present after removeTagFromBlocks`);
    },
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

// ---------------------------------------------------------------- markdown.js

test('markdown: markdownToBlocks never throws and returns canonical blocks with safe links (HTML other than <u> is text)', needs(SC, MD), (t) => {
  const r = forAll('notes.markdownToBlocks', {
    runs: runs(3000),
    gen: (rng) => (rng.chance(0.8) ? mdSoup(rng) : rng.chance(0.5) ? hostileHtml(rng) : mdText(rng, rng.int(1, 40))),
    prop: (md) => {
      let out;
      try {
        out = MD.markdownToBlocks(md);
      } catch (err) {
        fail('throws', `markdownToBlocks threw ${err?.name}: ${err?.message}`);
      }
      blocksSafe(out);
    },
    shrink: shrinkString,
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

test('markdown: Markdown is a fixed point after one round trip (blocksToMarkdown ∘ markdownToBlocks)', needs(SC, MD), (t) => {
  const r = forAll('notes.md-fixed-point', {
    runs: runs(3000),
    gen: (rng) => (rng.chance(0.5) ? { blocks: safeBlocks(genBlocks(rng)) } : { md: mdSoup(rng) }),
    prop: (c) => {
      let md1;
      let md2;
      try {
        md1 = c.md !== undefined ? MD.blocksToMarkdown(MD.markdownToBlocks(c.md)) : MD.blocksToMarkdown(c.blocks);
        md2 = MD.blocksToMarkdown(MD.markdownToBlocks(md1));
      } catch (err) {
        fail('throws', `threw ${err?.name}: ${err?.message}`);
      }
      check(typeof md1 === 'string' && md2 === md1, 'not-fixed', () => `Markdown changes on a second round trip:\n    once:  ${show(md1, 500)}\n    twice: ${show(md2, 500)}`);
    },
    shrink: shrinkValue,
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

test('markdown: content is a fixed point after one round trip, ignoring whitespace (no characters appear or vanish)', needs(SC, MD), (t) => {
  const squash = (s) => s.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n\n').trim();
  const r = forAll('notes.md-fixed-point-content', {
    runs: runs(3000),
    gen: (rng) => (rng.chance(0.5) ? { blocks: safeBlocks(genBlocks(rng)) } : { md: mdSoup(rng) }),
    prop: (c) => {
      let md1;
      let md2;
      try {
        md1 = c.md !== undefined ? MD.blocksToMarkdown(MD.markdownToBlocks(c.md)) : MD.blocksToMarkdown(c.blocks);
        md2 = MD.blocksToMarkdown(MD.markdownToBlocks(md1));
      } catch (err) {
        fail('throws', `threw ${err?.name}: ${err?.message}`);
      }
      assume(!WIKI_RE.test(md1)); // literal [[Title]] / [[date]] is meant to become a link when read back
      check(squash(md2) === squash(md1), 'content-changed', () => `Markdown content changes on a second round trip:\n    once:  ${show(md1, 500)}\n    twice: ${show(md2, 500)}`);
    },
    shrink: shrinkValue,
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

const WIKI_RE = /\[\[[^[\]\n|]{1,200}(?:\|[^[\]\n]{1,200})?\]\]/;
test('markdown: Body text survives a round trip exactly, whatever Markdown characters it contains', needs(SC, MD), (t) => {
  const r = forAll('notes.md-text', {
    runs: runs(4000),
    gen: (rng) => mdText(rng, rng.int(1, 14)),
    prop: (raw) => {
      const b = SC.newBlock('p', raw);
      const text = SC.blockText(b);
      // [[Title]] / [[YYYY-MM-DD]] are written unescaped on purpose (exports keep them links), so they may come back as chips
      assume(text.trim() && text === text.trim() && !text.includes('\n') && !WIKI_RE.test(text));
      const md = MD.blocksToMarkdown([b]);
      const back = MD.markdownToBlocks(md);
      const got = back.map((x) => SC.blockText(x)).join('\n');
      check(back.length === 1 && back[0].t === 'p' && got === text, 'text', () => `text ${show(text)} → Markdown ${show(md)} → ${back.length} block(s) ${show(back.map((x) => [x.t, SC.blockText(x)]))}`);
    },
    shrink: shrinkString,
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

test('markdown: block structure survives a round trip (types, list indents, check state, task links, text)', needs(SC, MD), (t) => {
  const r = forAll('notes.md-structure', {
    runs: runs(3000),
    gen: (rng) =>
      SC.validateBlocks(
        rng.repeat(rng.int(1, 10), () => {
          const tt = rng.pick(BLOCK_TYPES);
          return { t: tt, in: rng.int(0, 3), ck: rng.chance(0.5), ...(rng.chance(0.2) ? { task: `t${rng.int(1, 99)}` } : {}), c: [[rng.chance(0.85) ? rng.pick(['Milk', 'Call mom', 'a*b', '# not a heading', '1. not a list', '- dash', 'x_y', 'q > r', 'Title', 'é']) : mdText(rng, rng.int(1, 4))]] };
        }),
      ),
    prop: (raw) => {
      const blocks = safeBlocks(raw);
      const shape = (bs) =>
        bs
          .filter((b) => !(b.t === 'p' && !SC.blockText(b).trim()))
          .map((b) => [b.t, b.in ?? null, b.ck ?? null, b.task ?? null, b.t === 'hr' ? '' : SC.blockText(b).replace(/\s+/g, ' ').trim()]);
      // indents are written as 4 spaces per level and read back from the absolute indent, so they must survive exactly
      const want = shape(blocks);
      assume(want.length && want.every((w) => w[0] === 'hr' || w[4]) && !blocks.some((b) => WIKI_RE.test(SC.blockText(b))));
      const md = MD.blocksToMarkdown(blocks);
      const got = shape(MD.markdownToBlocks(md));
      check(sameContent(got, want), 'structure', () => `blocks ${show(want)}\n    → Markdown ${show(md, 400)}\n    → ${show(got)}`);
    },
    shrink: shrinkValue,
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

test('markdown: slugify makes safe, stable file names (no reserved Windows names, no path characters)', needs(MD), (t) => {
  const r = forAll('notes.slugify', {
    runs: runs(3000),
    gen: (rng) => rng.weighted([[3, () => mdText(rng, rng.int(0, 8))], [1, () => rng.pick(['con', 'CON', 'nul', 'Com1', 'lpt9', 'con.txt', 'aux.notes', 'prn ', ' .. ', '...', '', ' ', 'a/b\\c:d*e?f"g<h>i|j', 'x'.repeat(100), 'COM1.backup'])]]),
    prop: (title) => {
      const s = MD.slugify(title);
      check(typeof s === 'string' && s.length >= 1 && s.length <= 80, 'length', () => `slugify(${show(title)}) = ${show(s)}`);
      // eslint-disable-next-line no-control-regex
      check(!/[<>:"/\\|?*\u0000-\u001F]/.test(s) && s === s.trim() && !/^\.|\.$/.test(s), 'chars', () => `slugify(${show(title)}) = ${show(s)}`);
      check(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(s), 'reserved', () => `slugify(${show(title)}) = ${show(s)} is a reserved Windows device name (the part before the first dot counts)`);
      check(MD.slugify(s) === s, 'stable', () => `slugify is not stable: ${show(s)} → ${show(MD.slugify(s))}`);
    },
    shrink: shrinkString,
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

test('markdown: noteToMarkdown front matter reads back (title, tags, pinned, day) and never throws', needs(SC, MD), (t) => {
  const r = forAll('notes.front-matter', {
    runs: runs(1500),
    gen: (rng) => genNote(rng),
    prop: (raw) => {
      const n = safeNote(raw);
      assume(n);
      let md;
      try {
        md = MD.noteToMarkdown(n, { frontMatter: true, folderPath: 'Work/Clients' });
      } catch (err) {
        fail('throws', `noteToMarkdown threw ${err?.message}`);
      }
      const fm = MD.parseFrontMatter(md);
      const data = fm.data ?? fm.meta ?? fm.front ?? fm;
      check(data && (data.title === (n.title || 'New Note')), 'title', () => `front matter title ${show(data?.title)} != ${show(n.title || 'New Note')}`);
      if (n.day) check(String(data.day) === n.day, 'day', () => `day ${show(data.day)} != ${n.day}`);
      if (n.tags.length) check(sameContent((data.tags || []).map(String), n.tags), 'tags', () => `tags ${show(data.tags)} != ${show(n.tags)}`);
      check(sameContent(MD.markdownToBlocks(md, { frontMatter: true }).map(SC.blockText), MD.markdownToBlocks(MD.noteToMarkdown(n)).map(SC.blockText)), 'body', 'front matter changes how the body parses');
    },
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

// ---------------------------------------------------------------- search.js

function corpus(rng) {
  const folders = rng.repeat(rng.int(0, 6), genFolder).map((f) => SC.validateFolder(f)).filter(Boolean);
  const notes = rng
    .repeat(rng.int(0, 25), genNote)
    .map((n) => safeNote(n))
    .filter(Boolean)
    .map((n) => ({ ...n, folderId: folders.length && rng.chance(0.5) ? rng.pick(folders).id : n.folderId, trashedAt: rng.chance(0.15) ? 1763800000000 : null }));
  return { folders, notes };
}

test('search: parseQuery never throws on random input', needs(SE), (t) => {
  const r = forAll('notes.parseQuery', {
    runs: runs(4000),
    gen: (rng) => (rng.chance(0.7) ? genQuery(rng) : mdText(rng, rng.int(0, 20))),
    prop: (q) => {
      let p;
      try {
        p = SE.parseQuery(q);
      } catch (err) {
        fail('throws', `parseQuery threw ${err?.message}`);
      }
      check(p && Array.isArray(p.terms) && Array.isArray(p.phrases) && Array.isArray(p.tags) && p.not && typeof p.empty === 'boolean', 'shape', () => show(p, 200));
      check(p.terms.every((x) => typeof x === 'string' && x && !/\s/.test(x)), 'terms', () => show(p.terms));
    },
    shrink: shrinkString,
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

test('search: searchNotes never throws; results are matching, unique, untrashed, ranked, limited, with valid highlight ranges', needs(SC, SE), (t) => {
  const r = forAll('notes.searchNotes', {
    runs: runs(1500),
    gen: (rng) => ({ ...corpus(rng), q: genQuery(rng), limit: rng.pick([undefined, 1, 3, 50]), sort: rng.pick([undefined, 'relevance', 'date']) }),
    prop: ({ folders, notes, q, limit, sort }) => {
      let res;
      try {
        res = SE.searchNotes(notes, q, { folders, limit, sort, now: 1763800000000 });
      } catch (err) {
        fail('throws', `searchNotes threw ${err?.name}: ${err?.message}`);
      }
      check(Array.isArray(res), 'shape', 'not an array');
      check(res.length <= (limit || 50), 'limit', () => `${res.length} results for limit ${limit}`);
      check(new Set(res.map((x) => x.note)).size === res.length && res.every((x) => notes.includes(x.note)), 'identity', 'results are not distinct input notes');
      const pq = SE.parseQuery(q);
      for (const x of res) {
        check(Number.isFinite(x.score), 'score', () => `score ${x.score}`);
        check(!x.note.trashedAt, 'trashed', 'a trashed note was returned');
        for (const tag of pq.tags) check(x.note.tags.some((y) => SC.tagMatches(y, tag)), 'tag-filter', () => `#${tag} result has tags ${show(x.note.tags)}`);
        for (const tag of pq.not.tags) check(!x.note.tags.some((y) => SC.tagMatches(y, tag)), 'not-tag', () => `-#${tag} result has tags ${show(x.note.tags)}`);
        if (pq.is.pinned) check(x.note.pinned, 'pinned', 'is:pinned returned an unpinned note');
        if (pq.not.is.pinned) check(!x.note.pinned, 'pinned', '-is:pinned returned a pinned note');
        const hay = SE.normalize([x.note.title, ...x.note.blocks.map(SC.blockText), ...x.note.tags, SC.folderPath(x.note.folderId, folders)].join('\n'));
        for (const term of pq.terms) check(hay.includes(term), 'term', () => `result does not contain term ${show(term)}`);
        for (const term of pq.not.terms) check(!SE.normalize([x.note.title, ...x.note.blocks.map(SC.blockText)].join('\n')).includes(term), 'not-term', () => `result contains excluded ${show(term)}`);
        const okRanges = (ranges, len) => Array.isArray(ranges) && ranges.every(([s, e], i) => Number.isInteger(s) && Number.isInteger(e) && s >= 0 && s < e && e <= len && (!i || s >= ranges[i - 1][1]));
        check(okRanges(x.titleRanges ?? [], (x.note.title || '').length), 'title-ranges', () => `titleRanges ${show(x.titleRanges)} for ${show(x.note.title)}`);
        for (const sn of x.snippets ?? []) check(typeof sn.text === 'string' && okRanges(sn.ranges, sn.text.length), 'snippet-ranges', () => `snippet ${show(sn)}`);
      }
      const relevance = pq.terms.length || pq.phrases.length;
      for (let i = 1; i < res.length; i++) {
        if (sort === 'date' || !relevance) check((res[i - 1].note.editedAt || 0) >= (res[i].note.editedAt || 0), 'order', 'not sorted by edit date');
        else check(res[i - 1].score >= res[i].score, 'order', () => `scores not descending: ${res[i - 1].score}, ${res[i].score}`);
      }
    },
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

test('search: highlight() output is escaped HTML with only <mark> tags and reads back as the input text', needs(SE), (t) => {
  const r = forAll('notes.highlight', {
    runs: runs(4000),
    gen: (rng) => {
      const text = rng.chance(0.7) ? mdText(rng, rng.int(0, 12)) : hostileHtml(rng).slice(0, 200);
      const ranges = rng.repeat(rng.small(6), () => rng.weighted([[5, () => [rng.int(-3, text.length + 3), rng.int(-3, text.length + 3)]], [1, () => [NaN, 2]], [1, () => [1.5, 'x']], [1, () => 'junk'], [1, () => [0]]]));
      return { text, ranges };
    },
    prop: ({ text, ranges }) => {
      let h;
      try {
        h = SE.highlight(text, ranges);
      } catch (err) {
        fail('throws', `highlight threw ${err?.message}`);
      }
      const stripped = h.replace(/<\/?mark>/g, '');
      check(!/[<>"']/.test(stripped), 'unescaped', () => `markup character outside <mark>: ${show(h, 300)}`);
      check(!/&(?!(?:amp|lt|gt|quot|#39);)/.test(stripped), 'amp', () => `bare & in ${show(h, 300)}`);
      check((h.match(/<mark>/g) || []).length === (h.match(/<\/mark>/g) || []).length && !/<mark>[^<]*<mark>/.test(h), 'balanced', () => `unbalanced marks: ${show(h, 300)}`);
      const back = stripped.replace(/&(amp|lt|gt|quot|#39);/g, (m, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[n]);
      check(back === text, 'roundtrip', () => `highlight text reads back as ${show(back, 200)} instead of ${show(text, 200)}`);
    },
    shrink: shrinkValue,
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

test('search: 2,000 notes are searched in well under a second per query', needs(SC, SE), () => {
  const notes = [];
  for (let i = 0; i < 2000; i++) {
    const words = Array.from({ length: 60 }, (_, k) => ['alpha', 'beta', 'gamma', 'delta', 'note', 'meeting', 'todo', 'é', 'shop', `w${(i * 7 + k) % 500}`][(i + k * 3) % 10]);
    notes.push(SC.validateNote({ id: `n${i}`, blocks: [{ t: 'h1', c: [[`Note ${i}`]] }, { t: 'p', c: [[words.join(' ')]] }, { t: 'check', c: [[`#tag${i % 20} item`]], ck: i % 2 === 0 }], pinned: i % 50 === 0, editedAt: 1763800000000 - i * 1000 }));
  }
  const slow = [];
  SE.searchNotes(notes, 'warm up');
  for (const q of ['alpha', 'note 1', '"beta gamma"', '#tag3', 'is:pinned', 'has:todo w12', '-delta shop', 'é', 'zzz', 'meeting todo alpha beta']) {
    const t0 = performance.now();
    SE.searchNotes(notes, q, { now: 1763800000000 });
    const ms = performance.now() - t0;
    if (ms > 750) slow.push(`${show(q)}: ${ms.toFixed(0)} ms`);
  }
  assert.deepEqual(slow, [], `slow queries over 2,000 notes:\n  ${slow.join('\n  ')}`);
});

// ---------------------------------------------------------------- integration: what other processes keep of a note

function sampleNotes() {
  const notes = [
    SC.validateNote({ id: 'n1', blocks: [{ id: 'b1', t: 'h1', c: [['Groceries']] }, { id: 'b2', t: 'check', ck: true, c: [['oat '], ['barista', 'b']] }, { id: 'b3', t: 'p', c: [['see '], ['Plan', '', { ref: 'note:n2', atom: 1 }], [' #home']] }], day: '2026-11-22', editedBy: 'mcp:claude', rev: 7 }),
    SC.validateNote({ id: 'n2', blocks: [{ id: 'c1', t: 'code', lang: 'js', c: [['let x = 1;\n']] }, { id: 'c2', t: 'num', start: 3, in: 0, c: [['third']] }], folderId: 'f1', pinned: true, event: { id: 'e1', date: '2026-11-24' } }),
  ];
  return notes.filter(Boolean);
}

async function keptFields(mode) {
  const notes = sampleNotes();
  const out = await runScript(new URL('./lib/notes-store-child.mjs', import.meta.url), [mode], { input: JSON.stringify(notes) });
  assert.ok(out.ok, `${mode} child failed: ${out.error}`);
  const lost = [];
  notes.forEach((n, i) => {
    const got = out.results[i];
    if (!got) return lost.push(`note ${n.id} was rejected`);
    for (const k of ['blocks', 'v', 'rev', 'day', 'event', 'editedBy', 'links']) if (!sameContent(got[k], n[k])) lost.push(`note ${n.id}: ${k} ${show(n[k], 60)} became ${show(got[k], 60)}`);
  });
  return { lost, fields: out.fields };
}

test('integration: a page that never imported notes/core/schema.js (e.g. the Tasks app, Home before its lazy import) keeps a canonical note intact', needs(SC), async () => {
  // The page imports shared/store.js only; the notes arrive by sync and are saved to localStorage.
  const { lost, fields } = await keptFields('page');
  assert.deepEqual(lost, [], `a page's store (shared/store.js, no notes app) strips canonical notes (its notes fields: ${fields.join(', ')}):\n  ${lost.join('\n  ')}`);
});

test('integration: the server (createCore on a temporary data dir) keeps a canonical note intact', needs(SC), async () => {
  const { lost } = await keptFields('server');
  assert.deepEqual(lost, [], `server validators strip canonical notes:\n  ${lost.join('\n  ')}`);
});
