// notes-app fixes in notes/export.js: Windows device names in exported file and folder names, Export
// all's .zip read back by Import (folders, daily notes, meeting notes' events, day chips), a .zip
// zipped again elsewhere (deflated, wrapped in a folder), and anything that isn't a zip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.ECOSYS_ROOT ? pathToFileURL(`${process.env.ECOSYS_ROOT.replace(/\\/g, '/')}/`) : new URL('../', import.meta.url);
const ex = await import(new URL('notes/export.js', ROOT));
const S = await import(new URL('notes/core/schema.js', ROOT));

const text = (b) => (b?.c || []).map((r) => r[0]).join('');
const texts = (d) => d.blocks.map(text);
const T = Date.UTC(2026, 10, 20, 12);
const note = (id, fields) => ({ ...S.newNote({ ...fields, now: T }), id });
const asFile = (blob, name) => new File([blob], name, { type: 'application/zip' });

test('file and folder names: device names Windows reserves get a "_" (also with an extension or spaces before the dot)', () => {
  assert.deepEqual(
    ['con', 'con.txt', 'NUL.md', 'nul .txt', 'LPT¹', 'COM¹.md', 'CONIN$', 'conout$.txt'].map((s) => ex.safeName(s)),
    ['con_', 'con_.txt', 'NUL_.md', 'nul_ .txt', 'LPT¹_', 'COM¹_.md', 'CONIN$_', 'conout$_.txt'],
  );
  for (const s of ['console', 'Conference.md', 'nullable', 'com10', 'My notes']) assert.equal(ex.safeName(s), s);
  assert.equal(ex.folderPath('f', [{ id: 'f', name: 'con.txt', parentId: null }]), 'con_.txt');
  assert.ok(ex.safeName(`${'a'.repeat(79)}\u{1F600}`).isWellFormed(), 'never half an emoji');
  assert.equal(ex.safeName(`${'a'.repeat(79)}.b`), 'a'.repeat(79), 'no trailing dot after the cut');
});

test("Export all's .zip comes back whole through Import: folders, the daily note, a meeting note's event, pinned, day chips", async () => {
  const folders = [
    { id: 'fwork', name: 'Work', parentId: null },
    { id: 'fcli', name: 'Clients', parentId: 'fwork' },
  ];
  const notes = [
    note('n1', { folderId: 'fcli', pinned: true, blocks: [S.newBlock('h1', 'Kickoff'), S.newBlock('p', 'Agenda for the kickoff')] }),
    note('n2', { day: '2026-11-20', blocks: [S.newBlock('h1', 'Friday, November 20, 2026'), S.newBlock('p', 'A quiet day')] }),
    note('n3', { event: { id: 'ev1', date: '2026-11-23' }, blocks: [S.newBlock('h1', 'Team standup'), S.newBlock('h3', 'Notes'), S.newBlock('p', 'Ship it')] }),
    note('n4', { blocks: [S.newBlock('h1', 'Plans'), { id: 'bd', t: 'p', c: [['See '], ['2026-11-23', '', { ref: 'day:2026-11-23', atom: 1 }]] }] }),
    { ...note('n5', { blocks: [S.newBlock('h1', 'Gone')] }), trashedAt: T },
  ];
  const files = ex.exportFiles(notes, folders);
  assert.deepEqual(files.map((f) => f.name).sort(), ['Daily Notes/2026-11-20.md', 'Plans.md', 'Team standup.md', 'Work/Clients/Kickoff.md'], 'a note in Recently Deleted is left out');
  const standup = files.find((f) => f.name === 'Team standup.md').data;
  assert.match(standup, /^---\n[\s\S]*\nevent: ev1@2026-11-23\n---\n/, 'the meeting note names its event in the front matter');

  const zip = asFile(ex.zipStore(files), 'ecosys-notes-2026-11-22.zip');
  const back = await ex.readMarkdownFiles([zip]);
  assert.equal(back.length, 4, 'every note in the zip is read (the app takes its own .zip)');
  const by = (title) => back.find((d) => d.title === title);
  assert.equal(by('Kickoff').folder, 'Work/Clients');
  assert.equal(by('Kickoff').pinned, true);
  assert.equal(by('Friday, November 20, 2026').day, '2026-11-20');
  assert.deepEqual(by('Team standup').event, { id: 'ev1', date: '2026-11-23' });
  assert.deepEqual(texts(by('Team standup')), ['Team standup', 'Notes', 'Ship it']);
  const chip = by('Plans').blocks[1].c.find((r) => r[2]?.ref === 'day:2026-11-23');
  assert.ok(chip, 'the day chip is still a chip');
  assert.notEqual(chip[0], '2026-11-23', `the chip reads as a day, the way the editor labels it: "${chip[0]}"`);
  assert.match(chip[0], /23/);
});

test('a .zip made elsewhere: deflated entries and a wrapping folder are read; folders come from the paths', async (t) => {
  if (typeof CompressionStream !== 'function') return t.skip('no CompressionStream in this Node');
  const deflate = async (s) => new Uint8Array(await new Response(new Blob([s]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  // A zip of the folder "My export" (as Explorer or Finder make one), its entries deflated.
  const entries = [
    { name: 'My export/Recipes/Soup.md', text: '# Soup\n\nLeeks and potatoes' },
    { name: 'My export/Loose note.md', text: '# Loose note\n\nNo folder' },
    { name: 'My export/.DS_Store', text: 'x' },
    { name: '__MACOSX/My export/._Soup.md', text: 'x' },
  ];
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const raw = enc.encode(e.text);
    const data = await deflate(e.text);
    const name = enc.encode(e.name);
    const crc = ex.crc32(raw);
    const local = new Uint8Array(30 + name.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 0x0800, true);
    v.setUint16(8, 8, true); // deflate
    v.setUint32(14, crc, true);
    v.setUint32(18, data.length, true);
    v.setUint32(22, raw.length, true);
    v.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, data);
    const cen = new Uint8Array(46 + name.length);
    const c = new DataView(cen.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 8, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, raw.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    cen.set(name, 46);
    central.push(cen);
    offset += local.length + data.length;
  }
  const size = central.reduce((n, x) => n + x.length, 0);
  const end = new Uint8Array(22);
  const e2 = new DataView(end.buffer);
  e2.setUint32(0, 0x06054b50, true);
  e2.setUint16(8, entries.length, true);
  e2.setUint16(10, entries.length, true);
  e2.setUint32(12, size, true);
  e2.setUint32(16, offset, true);
  const zip = asFile(new Blob([...parts, ...central, end]), 'My export.zip');

  const listed = await ex.readZip(zip);
  assert.deepEqual(listed.map((x) => x.path), ['My export/Recipes/Soup.md', 'My export/Loose note.md'], 'hidden files and __MACOSX copies are skipped');
  const back = await ex.readMarkdownFiles([zip]);
  const soup = back.find((d) => d.title === 'Soup');
  assert.deepEqual(texts(soup), ['Soup', 'Leeks and potatoes'], 'a deflated entry is read');
  assert.equal(soup.folder, 'Recipes', 'the folder comes from the path, without the folder the zip wraps everything in');
  assert.equal(back.find((d) => d.title === 'Loose note').folder, null);
});

test('anything that is not a zip gives no files, and Markdown files are read as before', async () => {
  assert.deepEqual(await ex.readZip(new File(['not a zip at all, just text'], 'x.zip')), []);
  assert.deepEqual(await ex.readZip(new File([new Uint8Array(10)], 'tiny.zip')), []);
  const back = await ex.readMarkdownFiles([new File(['nope'], 'broken.zip', { type: 'application/zip' }), new File(['# Hello\n\nworld'], 'hello.md', { type: 'text/markdown' })]);
  assert.equal(back.length, 1, 'the broken zip gives nothing, the Markdown file is read');
  assert.ok(texts(back[0]).includes('Hello') && texts(back[0]).includes('world'), JSON.stringify(texts(back[0])));
  assert.equal(back[0].event, null);
  assert.equal(back[0].folder, null);
});

test('a malformed event in the front matter is ignored', async () => {
  const back = await ex.readMarkdownFiles([
    new File(['---\ntitle: "A"\nevent: not-an-event\n---\n\n# A\n'], 'a.md', { type: 'text/markdown' }),
    new File(['---\ntitle: "B"\nevent: ev1@2026-02-30\n---\n\n# B\n'], 'b.md', { type: 'text/markdown' }),
  ]);
  assert.deepEqual(back.map((d) => d.event), [null, null]);
});
