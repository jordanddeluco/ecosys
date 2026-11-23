// notes export & import — nothing is locked in.
//
//   downloadNote(note, folders)        one note as a .md file
//   copyMarkdown(note)                 → Promise<boolean>   the note as Markdown on the clipboard
//   exportAll(notes, folders)          every note as a .zip of Markdown files with front matter
//   zipStore(files)                    → Blob   tiny stored (uncompressed) ZIP writer with CRC32, no deps
//   readZip(file)                      → Promise<[{name, path, size, text()}]>   the files in a .zip (stored or deflated)
//   readMarkdownFiles(files)           → Promise<[{name, title, blocks, pinned, createdAt, editedAt, folder, day, event, tooLong, truncated}]>
//                                        .md / .txt files, and the Markdown inside a .zip (Export all's own)
//   parseFrontMatter(text)             → {meta, body}
//   folderPath(folderId, folders)      → 'Work/Clients'
//
// File names are the note titles (not slugs) so the `[[Title]]` links in exported notes resolve in
// Obsidian and other Markdown apps; daily notes are named YYYY-MM-DD.md, matching `[[YYYY-MM-DD]]`.
// Meeting notes keep their event in the front matter (`event: <id>@<date>`), so a round trip relinks them.
import { noteToMarkdown, markdownToBlocks, parseFrontMatter as coreFrontMatter, avoidDeviceName } from './core/markdown.js';
import { newBlock, newBlockId, validateBlocks, noteOverLimit, cut, folderChain } from './core/schema.js';
import { isYmd } from '../shared/sanitize.js';
import { parseYmd, fmt } from '../shared/dates.js';

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_FILES = 500;
const MAX_ZIP_BYTES = 200 * 1024 * 1024; // a .zip is read whole: Export all of a very large library stays well under this
const isId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(s);

// ---------------------------------------------------------------- names & paths

/** A file or folder name that is safe on Windows, macOS and Linux. */
export function safeName(s, fallback = 'Untitled') {
  let out = String(s ?? '')
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (out.length > 80) out = cut(out, 80).replace(/[.\s]+$/, ''); // never half an emoji, nor a trailing dot
  if (!out) out = fallback;
  // Windows reserves device names with an extension or spaces before the dot too ('con.txt',
  // 'nul .txt', 'LPT¹', 'CONIN$'): the same rule as slugify in core/markdown.js.
  return avoidDeviceName(out);
}

/**
 * 'Work/Clients' for a nested folder ('' for the default Notes folder), as the folder tree shows it:
 * folderChain cuts a parent cycle where the tree does, and stops at 16 levels.
 */
export function folderPath(folderId, folders) {
  return folderChain(folderId, Array.isArray(folders) ? folders : []).map((f) => safeName(f.name, 'Folder')).join('/');
}

function baseName(note) {
  if (note?.day && /^\d{4}-\d{2}-\d{2}$/.test(note.day)) return note.day;
  return safeName(note?.title, 'New Note');
}

function toMarkdown(note, folders, frontMatter, noteTitle) {
  try {
    const md = noteToMarkdown(note, { frontMatter, folderPath: folderPath(note.folderId, folders) || undefined, noteTitle });
    return frontMatter ? withEvent(md, note) : md;
  } catch (err) {
    console.error('ecosys notes: could not convert a note to Markdown', err);
    return '';
  }
}

/** A meeting note's event goes into its front matter (`event: <id>@<date>`), before the closing '---'. */
function withEvent(md, note) {
  const ev = note?.event;
  if (!ev || !isId(ev.id) || !isYmd(ev.date) || !md.startsWith('---\n')) return md;
  const end = md.indexOf('\n---', 4);
  if (end < 0) return md;
  return `${md.slice(0, end)}\nevent: ${ev.id}@${ev.date}${md.slice(end)}`;
}
/** `event: <id>@<date>` from the front matter → {id, date} (or null). */
function eventMeta(v) {
  const m = typeof v === 'string' ? /^\s*([A-Za-z0-9_-]{1,40})@(\d{4}-\d{2}-\d{2})\s*$/.exec(v) : null;
  return m && isYmd(m[2]) ? { id: m[1], date: m[2] } : null;
}

// ---------------------------------------------------------------- downloads & clipboard

export function downloadBlob(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.rel = 'noopener';
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Download one note as `<Title>.md`. */
export function downloadNote(note, folders = [], { noteTitle } = {}) {
  const md = toMarkdown(note, folders, false, noteTitle);
  downloadBlob(`${baseName(note)}.md`, new Blob([md], { type: 'text/markdown;charset=utf-8' }));
}

/** Put the note on the clipboard as Markdown. Resolves false when the browser refuses. */
export async function copyMarkdown(note, folders = [], { noteTitle } = {}) {
  const md = toMarkdown(note, folders, false, noteTitle);
  return copyText(md);
}

export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- ZIP (stored, CRC32)

let CRC_TABLE = null;
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosStamp(d) {
  const date = d instanceof Date && !Number.isNaN(d.getTime()) ? d : new Date();
  const y = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** files: [{name:'Folder/Note.md', data:string|Uint8Array, date?:Date}] → a ZIP Blob (no compression). */
export function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const { time, date } = dosStamp(f.date);
    const local = new Uint8Array(30 + name.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 0x0800, true); // UTF-8 names
    v.setUint16(8, 0, true); // stored
    v.setUint16(10, time, true);
    v.setUint16(12, date, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, data.length, true);
    v.setUint32(22, data.length, true);
    v.setUint16(26, name.length, true);
    v.setUint16(28, 0, true);
    local.set(name, 30);
    parts.push(local, data);

    const cen = new Uint8Array(46 + name.length);
    const c = new DataView(cen.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint16(30, 0, true);
    c.setUint16(32, 0, true);
    c.setUint16(34, 0, true);
    c.setUint16(36, 0, true);
    c.setUint32(38, 0, true);
    c.setUint32(42, offset, true);
    cen.set(name, 46);
    central.push(cen);
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((n, x) => n + x.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true);
  e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

/** The files Export all puts in its zip: [{name: 'Work/Kickoff.md', data, date}], one per note not in Recently Deleted. */
export function exportFiles(notes, folders = [], { noteTitle } = {}) {
  const live = (Array.isArray(notes) ? notes : []).filter((n) => n && !n.trashedAt);
  const used = new Set();
  const files = [];
  for (const n of live) {
    const dir = n.day ? 'Daily Notes' : folderPath(n.folderId, folders);
    const base = baseName(n);
    let name = `${dir ? `${dir}/` : ''}${base}.md`;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${dir ? `${dir}/` : ''}${base} ${i}.md`;
    used.add(name.toLowerCase());
    files.push({ name, data: toMarkdown(n, folders, true, noteTitle), date: new Date(n.editedAt || n.updatedAt || Date.now()) });
  }
  return files;
}

/** Every note (not the ones in Recently Deleted) as `ecosys-notes-YYYY-MM-DD.zip`. Returns the count. */
export function exportAll(notes, folders = [], opts = {}) {
  const files = exportFiles(notes, folders, opts);
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  downloadBlob(`ecosys-notes-${stamp}.zip`, zipStore(files));
  return files.length;
}

// ---------------------------------------------------------------- import

/**
 * The files in a .zip: Export all's own (stored entries) and one zipped again elsewhere (deflated, read
 * with the browser's DecompressionStream). Folders, hidden files and macOS's __MACOSX copies are
 * skipped; at most 500 entries. Each comes back like a File: {name, path, size, text()}, where `path`
 * is its place in the zip ('Work/Clients/Kickoff.md'). Anything that isn't a zip gives [].
 */
export async function readZip(file) {
  if (!file || typeof file.arrayBuffer !== 'function' || file.size > MAX_ZIP_BYTES) return [];
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf.length < 22) return [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // The end-of-central-directory record: the last 22 bytes, unless a comment (up to 64 KB) follows it.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const utf8 = new TextDecoder('utf-8');
  const out = [];
  for (let n = 0; n < count && out.length < MAX_IMPORT_FILES; n++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== 0x02014b50) break;
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const skip = dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const path = utf8.decode(buf.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, '/');
    p += 46 + nameLen + skip;
    const name = path.split('/').pop();
    if (!name || name.startsWith('.') || /(^|\/)__MACOSX\//.test(path) || flags & 1) continue; // a folder, hidden, or encrypted
    if (local + 30 > buf.length || dv.getUint32(local, true) !== 0x04034b50) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    if (start + csize > buf.length) continue;
    const data = buf.subarray(start, start + csize);
    // A stored entry is its bytes as they are: their count is its size, whatever the directory says (a
    // size stated too small must not get a big file past the import limit). A deflated one is held to
    // the limit while it is inflated (unzipEntry).
    out.push({ name, path, size: method === 0 ? csize : usize, type: '', text: async () => utf8.decode(await unzipEntry(data, method)) });
  }
  return out;
}

/** An entry bigger than an import takes (2 MB): readMarkdownFiles reports it like any file that size. */
const tooLargeEntry = (size) => Object.assign(new Error('too large'), { tooLarge: true, size });

/** One entry's bytes: stored as is, or deflated (never more than an import takes: 2 MB). */
async function unzipEntry(data, method) {
  if (method === 0) {
    if (data.length > MAX_IMPORT_BYTES) throw tooLargeEntry(data.length);
    return data;
  }
  if (method !== 8 || typeof DecompressionStream !== 'function') throw new Error('unsupported compression');
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_IMPORT_BYTES) {
      await reader.cancel().catch(() => {});
      throw tooLargeEntry(total);
    }
    parts.push(value);
  }
  const outBytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    outBytes.set(part, at);
    at += part.length;
  }
  return outBytes;
}

const isZip = (f) => /\.zip$/i.test(f?.name || '') || /^application\/(x-)?zip(-compressed)?$/.test(f?.type || '');

/**
 * The folder a zipped note came from ('Work/Clients' for 'Work/Clients/Kickoff.md'), for notes whose front
 * matter doesn't say. Export all keeps daily notes in 'Daily Notes', which is not a folder.
 */
function pathFolder(path, wrapper) {
  let dirs = String(path || '').split('/').slice(0, -1);
  if (wrapper && dirs[0] === wrapper) dirs = dirs.slice(1);
  if (!dirs.length || (dirs.length === 1 && dirs[0] === 'Daily Notes')) return null;
  return folderMeta(dirs.join('/'));
}

/** A day chip that reads its date ('2026-11-23', as [[2026-11-23]] comes back) gets the label the editor gives it ('Mon, Nov 23'). */
function relabelDays(blocks) {
  const thisYear = new Date().getFullYear();
  for (const b of blocks) {
    for (const r of Array.isArray(b?.c) ? b.c : []) {
      const ref = r?.[2]?.atom ? String(r[2].ref || '') : '';
      const m = /^day:(\d{4}-\d{2}-\d{2})$/.exec(ref);
      if (!m || r[0] !== m[1] || !isYmd(m[1])) continue;
      const d = parseYmd(m[1]);
      r[0] = fmt(d, { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() === thisYear ? {} : { year: 'numeric' }) });
    }
  }
  return blocks;
}

const unquote = (s) => {
  const t = String(s ?? '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1).replace(/\\"/g, '"');
  return t;
};

/** YAML-ish front matter: `key: value`, `key: [a, b]` and `- item` lines only (nothing is evaluated). */
export function parseFrontMatter(text) {
  try {
    const r = coreFrontMatter(text);
    if (r && typeof r.body === 'string') return { meta: r.data || Object.create(null), body: r.body };
  } catch {
    /* fall back to the simple reader below */
  }
  const src = String(text ?? '').replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  const meta = Object.create(null);
  if (!m) return { meta, body: src };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]{0,40})\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const raw = kv[2].trim();
    meta[key] = /^\[.*\]$/.test(raw)
      ? raw
          .slice(1, -1)
          .split(',')
          .map((x) => unquote(x))
          .filter(Boolean)
      : unquote(raw);
  }
  return { meta, body: src.slice(m[0].length) };
}

const blockPlain = (b) => (Array.isArray(b?.c) ? b.c.map((r) => (Array.isArray(r) ? String(r[0] ?? '') : '')).join('') : '');
const tagWord = (t) => String(t ?? '').replace(/^#/, '').trim().replace(/\s+/g, '-');
/** The `day:` of an exported daily note: a real calendar date 'YYYY-MM-DD' in 1000–9999 (isYmd), or null. */
function dayMeta(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return isYmd(s) ? s : null;
}
/** The `folder:` path written by export ('Work/Clients'): segments trimmed, empty ones dropped. */
function folderMeta(v) {
  if (typeof v !== 'string') return null;
  const path = v
    .split('/')
    .map((s) => s.replace(/\s+/g, ' ').trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 8)
    .join('/');
  return path || null;
}

/**
 * Read .md / .markdown / .txt files into note drafts. The note's title comes from the front matter,
 * else the first line, else the file name. `folder` ('Work/Clients') and `day` ('YYYY-MM-DD', a daily
 * note) come back from what exportAll wrote.
 *
 * Nothing is cut: a file that doesn't fit in one note (5,000 blocks, 256 KB) comes back with
 * `tooLong: {reason: 'blocks'|'bytes'|'file', count, size}` and no blocks, for the caller to report.
 * Files over 2 MB are not read at all (reason 'file', `truncated: true`): that is far more than a note holds.
 */
export async function readMarkdownFiles(fileList, { resolveNote } = {}) {
  // A .zip (Export all's own, or one made elsewhere) gives up the Markdown inside it.
  const given = [];
  for (const f of [...(fileList || [])]) {
    if (!isZip(f)) {
      given.push(f);
      continue;
    }
    let entries = [];
    try {
      entries = await readZip(f);
    } catch {
      entries = [];
    }
    // A zip of a folder (made by the system) wraps everything in that folder: it isn't a notes folder.
    const tops = new Set(entries.map((e) => (e.path.includes('/') ? e.path.split('/')[0] : '')));
    const top = tops.size === 1 ? [...tops][0] : '';
    const wrapper = top && top !== 'Daily Notes' && entries.every((e) => e.path.includes('/')) ? top : null;
    for (const e of entries) given.push(Object.assign(e, { folderHint: pathFolder(e.path, wrapper) }));
  }
  const files = given.filter((f) => /\.(md|markdown|mdown|txt|text)$/i.test(f.name || '') || /^text\//.test(f.type || '')).slice(0, MAX_IMPORT_FILES);
  const out = [];
  for (const f of files) {
    const fileTitle = String(f.name || '').replace(/\.[^.]+$/, '');
    const base = { name: f.name, title: fileTitle.trim().slice(0, 120), pinned: false, createdAt: null, editedAt: null, folder: f.folderHint || null, day: null, event: null };
    if (f.size > MAX_IMPORT_BYTES) {
      out.push({ ...base, blocks: [], tooLong: { reason: 'file', count: 0, size: f.size }, truncated: true });
      continue;
    }
    let text = '';
    try {
      text = await f.text();
    } catch (err) {
      // A zipped file that turned out bigger than its stated size: reported like any file over the limit.
      if (err?.tooLarge) out.push({ ...base, blocks: [], tooLong: { reason: 'file', count: 0, size: Math.max(Number(err.size) || 0, Number(f.size) || 0) }, truncated: true });
      continue;
    }
    const { meta, body } = parseFrontMatter(text);
    let blocks = [];
    try {
      // Every block (max: Infinity), so a file over the note limit is reported, never kept in part.
      blocks = markdownToBlocks(body, { resolveNote, max: Infinity });
    } catch {
      // One Body line per line of text; long lines split, never cut.
      const lines = String(body)
        .split(/\r?\n/)
        .map((line) => ({ id: newBlockId(), t: 'p', c: line ? [[line]] : [] }));
      blocks = validateBlocks(lines, { max: Infinity, split: true });
    }
    if (!Array.isArray(blocks)) blocks = [];
    relabelDays(blocks);
    const title = String(typeof meta.title === 'string' && meta.title.trim() ? meta.title : fileTitle).trim().slice(0, 120);
    const first = blocks.find((b) => blockPlain(b).trim());
    if (title && (!first || blockPlain(first).trim() !== title)) blocks.unshift(newBlock('h1', title));
    const tags = (Array.isArray(meta.tags) ? meta.tags : typeof meta.tags === 'string' ? meta.tags.split(/[,\s]+/) : []).map(tagWord).filter((t) => /\p{L}/u.test(t)).slice(0, 30);
    const text2 = blocks.map(blockPlain).join('\n').toLowerCase();
    const missing = tags.filter((t) => !text2.includes(`#${t.toLowerCase()}`));
    if (missing.length) blocks.push(newBlock('p', missing.map((t) => `#${t}`).join(' ')));
    const ts = (v) => {
      const n = typeof v === 'string' ? Date.parse(v) : NaN;
      return Number.isFinite(n) && n > 0 && n < 8.64e15 ? n : null;
    };
    const over = noteOverLimit(blocks);
    out.push({
      ...base,
      title,
      blocks: over ? [] : blocks,
      pinned: meta.pinned === 'true' || meta.pinned === true,
      createdAt: ts(meta.created ?? meta.date),
      editedAt: ts(meta.updated ?? meta.edited ?? meta.modified),
      folder: folderMeta(meta.folder) || base.folder,
      day: dayMeta(meta.day),
      event: eventMeta(meta.event),
      tooLong: over ? { reason: over.reason, count: over.count, size: over.size } : null,
      truncated: false,
    });
  }
  return out;
}
