// Photos: the EXIF reader, the two cloud providers (against a fake server) and the backup queue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readExif, parseExifDate, cameraName } from '../photos/lib/exif.js';
import { oneDrive, googleDrive, CloudError } from '../photos/lib/providers.js';
import { queue, counts, DEFAULTS } from '../photos/lib/backup.js';

// ---------------------------------------------------------------- EXIF

/** A minimal JPEG: SOI, an APP1 Exif segment (little-endian TIFF), then SOS. */
function jpegWithExif({ make = 'Apple', model = 'iPhone 15 Pro', taken = '2024:07:14 18:03:22', offset = '', orientation = 6 } = {}) {
  const entries0 = [];
  const strings = [];
  const ascii = (tag, s) => entries0.push({ tag, type: 2, str: `${s}\0` });
  ascii(0x010f, make);
  ascii(0x0110, model);
  entries0.push({ tag: 0x0112, type: 3, val: orientation });
  entries0.push({ tag: 0x8769, type: 4, exif: true });
  const exifEntries = [{ tag: 0x9003, type: 2, str: `${taken}\0` }];
  if (offset) exifEntries.push({ tag: 0x9010, type: 2, str: `${offset}\0` });

  const buf = new ArrayBuffer(1024);
  const v = new DataView(buf);
  const tiff = 12; // after FFD8, FFE1, length, "Exif\0\0"
  let p = 0;
  v.setUint16(p, 0xffd8); p += 2;
  v.setUint16(p, 0xffe1); p += 2;
  const lenAt = p; p += 2;
  [0x45, 0x78, 0x69, 0x66, 0, 0].forEach((b) => v.setUint8(p++, b));
  v.setUint16(tiff, 0x4949);
  v.setUint16(tiff + 2, 42, true);
  v.setUint32(tiff + 4, 8, true);
  let data = 8 + 2 + entries0.length * 12 + 4 + 2 + exifEntries.length * 12 + 4; // where strings go, relative to TIFF
  const exifIfd = 8 + 2 + entries0.length * 12 + 4;
  const writeIfd = (at, entries) => {
    v.setUint16(tiff + at, entries.length, true);
    entries.forEach((e, i) => {
      const o = tiff + at + 2 + i * 12;
      v.setUint16(o, e.tag, true);
      v.setUint16(o + 2, e.type, true);
      if (e.str) {
        v.setUint32(o + 4, e.str.length, true);
        v.setUint32(o + 8, data, true);
        strings.push([data, e.str]);
        data += e.str.length;
      } else if (e.exif) {
        v.setUint32(o + 4, 1, true);
        v.setUint32(o + 8, exifIfd, true);
      } else {
        v.setUint32(o + 4, 1, true);
        v.setUint16(o + 8, e.val, true);
      }
    });
    v.setUint32(tiff + at + 2 + entries.length * 12, 0, true);
  };
  writeIfd(8, entries0);
  writeIfd(exifIfd, exifEntries);
  for (const [at, s] of strings) for (let i = 0; i < s.length; i++) v.setUint8(tiff + at + i, s.charCodeAt(i));
  const end = tiff + data;
  v.setUint16(lenAt, end - lenAt);
  v.setUint16(end, 0xffda);
  return buf.slice(0, end + 2);
}

test('readExif reads date taken, camera and orientation', () => {
  const ex = readExif(jpegWithExif());
  assert.equal(ex.camera, 'iPhone 15 Pro');
  assert.equal(ex.orientation, 6);
  assert.equal(ex.takenAt, new Date(2024, 6, 14, 18, 3, 22).getTime());
});

test('readExif honours the offset the camera recorded', () => {
  const ex = readExif(jpegWithExif({ offset: '+02:00' }));
  assert.equal(ex.takenAt, Date.UTC(2024, 6, 14, 16, 3, 22));
});

test('readExif returns {} for non-JPEGs and truncated files', () => {
  assert.deepEqual(readExif(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer), {});
  assert.deepEqual(readExif(jpegWithExif().slice(0, 30)), {});
  assert.deepEqual(readExif(new ArrayBuffer(0)), {});
});

test('parseExifDate rejects blank camera dates', () => {
  assert.equal(parseExifDate('0000:00:00 00:00:00'), null);
  assert.equal(parseExifDate(''), null);
});

test('cameraName joins make and model sensibly', () => {
  assert.equal(cameraName('Canon', 'Canon EOS R6'), 'Canon EOS R6');
  assert.equal(cameraName('SAMSUNG', 'SM-S918B'), 'Samsung SM-S918B');
  assert.equal(cameraName('Apple', 'iPhone 13'), 'iPhone 13');
  assert.equal(cameraName('', ''), '');
});

// ---------------------------------------------------------------- providers against a fake server

function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url: String(url), method, headers: new Headers(init.headers || {}), body: init.body });
    for (const [match, reply] of routes) {
      if (match(String(url), method)) {
        const r = typeof reply === 'function' ? await reply(String(url), init) : reply;
        return new Response(r.body === undefined ? null : typeof r.body === 'string' || r.body instanceof Blob ? r.body : JSON.stringify(r.body), {
          status: r.status || 200,
          headers: { 'Content-Type': r.type || 'application/json', ...(r.headers || {}) },
        });
      }
    }
    return new Response(JSON.stringify({ error: { code: 'itemNotFound', message: 'not found' } }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  };
  return { f, calls };
}

test('OneDrive: finds Pictures, makes the folder path, and uploads with the bearer token', async () => {
  const { f, calls } = fakeFetch([
    [(u) => u.includes('/special/photos'), { body: { id: 'PICS' } }],
    [(u, m) => m === 'GET' && u.includes('/items/PICS:/ecosys%20Photos'), { body: { id: 'ROOT', folder: {} } }],
    [(u, m) => m === 'POST' && u.endsWith('/items/ROOT/children'), { status: 201, body: { id: 'Y2026' } }],
    [(u, m) => m === 'POST' && u.endsWith('/items/Y2026/children'), { status: 201, body: { id: 'M11' } }],
    [(u, m) => m === 'PUT' && u.includes('/items/M11:/beach.jpg:/content'), { status: 201, body: { id: 'FILE1', name: 'beach.jpg' } }],
    [(u, m) => m === 'PATCH', { body: {} }],
  ]);
  const od = oneDrive({ fetch: f, token: async () => 'T0K' });
  const folder = await od.folder(['ecosys Photos', '2026', '11']);
  assert.equal(folder, 'M11');
  const made = calls.filter((c) => c.method === 'POST').map((c) => JSON.parse(c.body).name);
  assert.deepEqual(made, ['2026', '11']);
  const item = await od.upload(folder, new Blob(['xyz'], { type: 'image/jpeg' }), { name: 'beach.jpg', mime: 'image/jpeg', takenAt: Date.UTC(2026, 10, 3) });
  assert.deepEqual(item, { id: 'FILE1', name: 'beach.jpg' });
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.headers.get('Authorization'), 'Bearer T0K');
  assert.match(put.url, /conflictBehavior=rename/);
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal(JSON.parse(patch.body).fileSystemInfo.createdDateTime, '2026-11-03T00:00:00.000Z');
});

test('OneDrive: big files go up in 320 KiB-aligned chunks without the bearer token', async () => {
  const size = 11 * 1024 * 1024;
  const chunks = [];
  const { f } = fakeFetch([
    [(u) => u.includes(':/createUploadSession'), { body: { uploadUrl: 'https://upload.example/session1' } }],
    [
      (u, m) => u === 'https://upload.example/session1' && m === 'PUT',
      (u, init) => {
        const h = new Headers(init.headers);
        chunks.push({ range: h.get('Content-Range'), auth: h.get('Authorization') });
        const end = Number(h.get('Content-Range').match(/-(\d+)\//)[1]);
        return end === size - 1 ? { status: 201, body: { id: 'BIG', name: 'clip.mp4' } } : { status: 202, body: {} };
      },
    ],
  ]);
  const od = oneDrive({ fetch: f, token: async () => 'T' });
  const item = await od.upload('P', new Blob([new Uint8Array(size)]), { name: 'clip.mp4', mime: 'video/mp4' });
  assert.equal(item.id, 'BIG');
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].range, `bytes 0-${5 * 1024 * 1024 - 1}/${size}`);
  assert.ok(chunks.every((c) => c.auth === null));
  assert.equal((5 * 1024 * 1024) % (320 * 1024), 0);
});

test('a 401 renews the token once and retries', async () => {
  let n = 0;
  const forced = [];
  const { f } = fakeFetch([[(u) => u.includes('/me/drive?'), () => (++n === 1 ? { status: 401, body: { error: { code: 'InvalidAuthenticationToken' } } } : { body: { owner: { user: { displayName: 'Sam' } }, quota: { used: 5, total: 10 } } })]]);
  const od = oneDrive({ fetch: f, token: async (force) => (forced.push(force), force ? 'NEW' : 'OLD') });
  const acct = await od.account();
  assert.equal(acct.name, 'Sam');
  assert.deepEqual(forced, [false, true, false]);
});

test('a full cloud is reported as such', async () => {
  const { f } = fakeFetch([[() => true, { status: 507, body: { error: { code: 'quotaLimitReached', message: 'Insufficient Storage' } } }]]);
  const od = oneDrive({ fetch: f, token: async () => 'T' });
  await assert.rejects(od.upload('P', new Blob(['a']), { name: 'a.jpg' }), (e) => e instanceof CloudError && e.code === 'full');
});

test('Google Drive: reuses its folder, makes missing ones, and uploads multipart with appProperties', async () => {
  const { f, calls } = fakeFetch([
    [(u, m) => m === 'GET' && u.includes('/drive/v3/files?') && decodeURIComponent(u).includes("name = 'ecosys Photos'"), { body: { files: [{ id: 'ROOT' }] } }],
    [(u, m) => m === 'GET' && u.includes('/drive/v3/files?'), { body: { files: [] } }],
    [(u, m) => m === 'POST' && u.includes('/drive/v3/files?fields=id'), (u, init) => ({ body: { id: `F-${JSON.parse(init.body).name}` } })],
    [(u, m) => m === 'POST' && u.includes('uploadType=multipart'), { body: { id: 'G1', name: 'a.jpg' } }],
  ]);
  const gd = googleDrive({ fetch: f, token: async () => 'GT' });
  const folder = await gd.folder(['ecosys Photos', '2026', '11']);
  assert.equal(folder, 'F-11');
  const item = await gd.upload(folder, new Blob(['hello'], { type: 'image/jpeg' }), { name: 'a.jpg', mime: 'image/jpeg', takenAt: 1700000000000, photoId: 'p1' });
  assert.equal(item.id, 'G1');
  const up = calls.find((c) => c.url.includes('uploadType=multipart'));
  assert.match(up.headers.get('Content-Type'), /^multipart\/related; boundary=/);
  const text = await up.body.text();
  assert.match(text, /"ecosysPhotoId":"p1"/);
  assert.match(text, /"parents":\["F-11"\]/);
  assert.match(text, /hello/);
});

test('Google Drive: listing walks folders and keeps the photo id', async () => {
  const { f } = fakeFetch([
    [(u) => decodeURIComponent(u.replace(/\+/g, ' ')).includes("'ROOT' in parents"), { body: { files: [{ id: 'Y', name: '2026', mimeType: 'application/vnd.google-apps.folder' }] } }],
    [(u) => decodeURIComponent(u.replace(/\+/g, ' ')).includes("'Y' in parents"), { body: { files: [{ id: 'X', name: 'x.jpg', mimeType: 'image/jpeg', size: '12', appProperties: { ecosysPhotoId: 'p9', takenAt: '1700000000000' } }, { id: 'T', name: 'notes.txt', mimeType: 'text/plain' }] } }],
  ]);
  const gd = googleDrive({ fetch: f, token: async () => 'GT' });
  const list = await gd.list('ROOT');
  assert.deepEqual(list, [{ id: 'X', name: 'x.jpg', size: 12, mime: 'image/jpeg', takenAt: 1700000000000, photoId: 'p9' }]);
});

// ---------------------------------------------------------------- the backup queue

const ph = (id, extra = {}) => ({ id, type: 'image/jpeg', takenAt: Number(id.slice(1)) * 1000, deletedAt: null, local: true, cloud: null, size: 10, ...extra });

test('queue: newest first, skips the trash, backed-up items and (optionally) videos', () => {
  const cfg = { ...DEFAULTS, provider: 'onedrive' };
  const photos = [
    ph('p1'),
    ph('p3'),
    ph('p2', { deletedAt: 5 }),
    ph('p4', { cloud: { provider: 'onedrive', id: 'x' } }),
    ph('p5', { cloud: { provider: 'gdrive', id: 'y' } }), // backed up elsewhere: goes to the new cloud too
    ph('p6', { type: 'video/mp4' }),
  ];
  assert.deepEqual(queue(cfg, photos).map((p) => p.id), ['p6', 'p5', 'p3', 'p1']);
  assert.deepEqual(queue({ ...cfg, includeVideos: false }, photos).map((p) => p.id), ['p5', 'p3', 'p1']);
  assert.deepEqual(queue({ ...cfg, provider: null }, photos), []);
});

test('counts: what is safe, waiting, and can be freed', () => {
  const cfg = { ...DEFAULTS, provider: 'onedrive' };
  const photos = [ph('p1', { cloud: { provider: 'onedrive', id: 'a' } }), ph('p2', { cloud: { provider: 'onedrive', id: 'b' }, local: false }), ph('p3')];
  const c = counts(cfg, photos);
  assert.equal(c.total, 3);
  assert.equal(c.backedUp, 2);
  assert.equal(c.waiting, 1);
  assert.equal(c.cloudOnly, 1);
  assert.deepEqual(c.freeable.map((p) => p.id), ['p1']);
});
