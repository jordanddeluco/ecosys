// notes-app, second pass (notes/export.js): the 2 MB per-file import limit holds for files inside a .zip
// whatever sizes the zip's directory states. A stored entry is as big as its bytes; a deflated one is
// held to the limit while it is inflated. Both come back as "too long" files (reason 'file'), never parsed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.ECOSYS_ROOT ? pathToFileURL(`${process.env.ECOSYS_ROOT.replace(/\\/g, '/')}/`) : new URL('../', import.meta.url);
const ex = await import(new URL('notes/export.js', ROOT));

const enc = new TextEncoder();
const LIMIT = 2 * 1024 * 1024;

/** A one-entry zip: `data` as written (stored, or already deflated with `method: 8`), sizes as stated. */
function zipOne(name, data, { method = 0, raw = data, csize = data.length, usize = raw.length } = {}) {
  const nm = enc.encode(name);
  const crc = ex.crc32(raw);
  const local = new Uint8Array(30 + nm.length);
  const v = new DataView(local.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true);
  v.setUint16(8, method, true);
  v.setUint32(14, crc, true);
  v.setUint32(18, csize, true);
  v.setUint32(22, usize, true);
  v.setUint16(26, nm.length, true);
  local.set(nm, 30);
  const cen = new Uint8Array(46 + nm.length);
  const c = new DataView(cen.buffer);
  c.setUint32(0, 0x02014b50, true);
  c.setUint16(4, 20, true);
  c.setUint16(6, 20, true);
  c.setUint16(10, method, true);
  c.setUint32(16, crc, true);
  c.setUint32(20, csize, true);
  c.setUint32(24, usize, true);
  c.setUint16(28, nm.length, true);
  c.setUint32(42, 0, true);
  cen.set(nm, 46);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, 1, true);
  e.setUint16(10, 1, true);
  e.setUint32(12, cen.length, true);
  e.setUint32(16, local.length + data.length, true);
  return new File([local, data, cen, end], 'notes.zip', { type: 'application/zip' });
}

const big = enc.encode(`# Big\n\n${'word '.repeat(700000)}`); // ~3.5 MB of text

test('a stored entry whose directory says it is 100 bytes is still the 3.5 MB it holds: reported, not read', async () => {
  const honest = await ex.readMarkdownFiles([zipOne('big.md', big)]);
  assert.equal(honest.length, 1);
  assert.equal(honest[0].tooLong?.reason, 'file', 'a stored entry over 2 MB is not read');
  const t0 = Date.now();
  const [liar] = await ex.readMarkdownFiles([zipOne('big.md', big, { usize: 100 })]);
  assert.ok(liar, 'the file is reported, not dropped');
  assert.equal(liar.tooLong?.reason, 'file', `the stated size does not get it past the limit: ${JSON.stringify(liar.tooLong)}`);
  assert.ok(liar.tooLong.size > LIMIT, 'it is reported with its real size');
  assert.equal(liar.truncated, true);
  assert.deepEqual(liar.blocks, [], 'nothing of it was parsed into blocks');
  assert.ok(Date.now() - t0 < 2000, 'and it is not parsed first: the answer comes at once');
});

test('the zip entry list gives a stored entry the size of its bytes', async () => {
  const [entry] = await ex.readZip(zipOne('note.md', enc.encode('# Hi\n\nThere'), { usize: 5 }));
  assert.equal(entry.size, enc.encode('# Hi\n\nThere').length);
});

test('a deflated entry that inflates past 2 MB (stating 100 bytes) is reported as too long, not dropped', async (t) => {
  if (typeof CompressionStream !== 'function' || typeof DecompressionStream !== 'function') return t.skip('no CompressionStream in this Node');
  const deflated = new Uint8Array(await new Response(new Blob([big]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  const [d] = await ex.readMarkdownFiles([zipOne('big.md', deflated, { method: 8, raw: big, usize: 100 })]);
  assert.ok(d, 'the file is reported');
  assert.equal(d.tooLong?.reason, 'file', JSON.stringify(d.tooLong));
  assert.ok(d.tooLong.size > LIMIT);
  assert.deepEqual(d.blocks, []);
});

test('small files in a zip still import as before', async () => {
  const [d] = await ex.readMarkdownFiles([zipOne('Hello.md', enc.encode('# Hello\n\nA small note'))]);
  assert.equal(d.tooLong, null);
  assert.deepEqual(
    d.blocks.map((b) => (b.c || []).map((r) => r[0]).join('')),
    ['Hello', 'A small note'],
  );
});
