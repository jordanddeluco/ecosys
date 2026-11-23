// notes/export.js Markdown import: a file is imported whole or reported as too long for one note
// (5,000 blocks, 256 KB of blocks), never cut to its first 5,000 blocks or to its first 2 MB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.ECOSYS_ROOT ? pathToFileURL(`${process.env.ECOSYS_ROOT.replace(/\\/g, '/')}/`) : new URL('../', import.meta.url);
const ex = await import(new URL('notes/export.js', ROOT));
const S = await import(new URL('notes/core/schema.js', ROOT));

const LIMIT = S.NOTE_LIMITS.blocks;
const md = (name, text) => new File([text], name, { type: 'text/markdown' });
const paras = (n, word = 'line') => Array.from({ length: n }, (_, i) => `${word} ${i}`).join('\n\n');
const text = (b) => (b.c || []).map((r) => r[0]).join('');

test('a Markdown file with more blocks than a note holds is reported, not cut to the first 5,000', async () => {
  // The file name becomes the title block, so LIMIT - 1 paragraphs make exactly LIMIT blocks.
  const [fits, over] = await ex.readMarkdownFiles([md('fits.md', paras(LIMIT - 1)), md('over.md', paras(LIMIT + 1000))]);
  assert.equal(fits.tooLong, null);
  assert.equal(fits.blocks.length, LIMIT);
  assert.equal(text(fits.blocks[0]), 'fits');
  assert.equal(text(fits.blocks.at(-1)), `line ${LIMIT - 2}`, 'the last paragraph is there');
  assert.equal(S.noteOverLimit(fits.blocks), null);

  assert.equal(over.name, 'over.md');
  assert.deepEqual(over.blocks, [], 'nothing of a file that does not fit is handed over for import');
  assert.equal(over.tooLong.reason, 'blocks');
  assert.equal(over.tooLong.count, LIMIT + 1001, 'every block counted (markdownToBlocks with max: Infinity)');
  assert.equal(over.truncated, false);
});

test('a file over 256 KB of blocks is reported as too long (reason bytes)', async () => {
  // 30 paragraphs of 10,000 characters: few blocks, ~300 KB.
  const [r] = await ex.readMarkdownFiles([md('big.md', paras(30, 'x'.repeat(10000)))]);
  assert.equal(r.tooLong?.reason, 'bytes');
  assert.ok(r.tooLong.size > S.NOTE_LIMITS.noteBytes);
  assert.deepEqual(r.blocks, []);
});

test('a file over 2 MB is reported without being read or cut', async () => {
  const big = new File([new Uint8Array(2 * 1024 * 1024 + 1).fill(0x61)], 'huge.md', { type: 'text/markdown' });
  const [r] = await ex.readMarkdownFiles([big]);
  assert.equal(r.tooLong?.reason, 'file');
  assert.equal(r.truncated, true);
  assert.deepEqual(r.blocks, []);
  assert.equal(r.title, 'huge');
});

test('front matter: title, tags, folder and a day in 1000–9999 come back; other years do not', async () => {
  const front = (day) => `---\ntitle: Trip\ntags: [travel, हिंदी]\nfolder: Work/Clients\nday: ${day}\npinned: true\n---\nPack the bags\n`;
  const [a, b, c] = await ex.readMarkdownFiles([md('a.md', front('2026-11-22')), md('b.md', front('0491-05-01')), md('c.md', front('2026-02-30'))]);
  assert.equal(a.tooLong, null);
  assert.equal(a.title, 'Trip');
  assert.equal(text(a.blocks[0]), 'Trip');
  assert.ok(a.blocks.some((x) => text(x).includes('#travel') && text(x).includes('#हिंदी')), 'tags missing from the text are added as a line');
  assert.equal(a.folder, 'Work/Clients');
  assert.equal(a.day, '2026-11-22');
  assert.equal(a.pinned, true);
  assert.equal(b.day, null, 'year 0491 is not a day the data validators keep');
  assert.equal(c.day, null, 'not a real date');
});

test('only text files are read; an empty list gives nothing', async () => {
  assert.deepEqual(await ex.readMarkdownFiles([new File(['x'], 'photo.png', { type: 'image/png' })]), []);
  assert.deepEqual(await ex.readMarkdownFiles(null), []);
  const [t] = await ex.readMarkdownFiles([new File(['hello'], 'plain.txt', { type: 'text/plain' })]);
  assert.equal(t.tooLong, null);
  assert.deepEqual(t.blocks.map(text), ['plain', 'hello']);
});
