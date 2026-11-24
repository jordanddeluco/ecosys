// A small EXIF reader for JPEG photos: when the photo was taken, which camera took it, and how it is turned.
// Pure (an ArrayBuffer in, plain values out), so it runs in the browser and under `node --test` alike.
// Only the tags the app shows are read; anything malformed is skipped rather than thrown.

const TAGS = {
  0x010f: 'make',
  0x0110: 'model',
  0x0112: 'orientation',
  0x0132: 'dateTime',
  0x8769: 'exifIfd',
  0x9003: 'dateTimeOriginal',
  0x9004: 'dateTimeDigitized',
  0x9010: 'offsetTimeOriginal',
  0xa002: 'pixelWidth',
  0xa003: 'pixelHeight',
  0x829a: 'exposureTime',
  0x829d: 'fNumber',
  0x8827: 'iso',
  0x920a: 'focalLength',
};
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

/**
 * Read the EXIF block of a JPEG. Returns {} for anything that isn't a JPEG with EXIF.
 * @param {ArrayBuffer} buf the start of the file (the first 256 KB is plenty)
 */
export function readExif(buf) {
  try {
    const v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return {};
    let p = 2;
    while (p + 4 <= v.byteLength) {
      if (v.getUint8(p) !== 0xff) return {};
      const marker = v.getUint8(p + 1);
      if (marker === 0xda || marker === 0xd9) return {}; // image data starts: no EXIF before it
      const len = v.getUint16(p + 2);
      if (marker === 0xe1 && p + 10 <= v.byteLength && v.getUint32(p + 4) === 0x45786966 && v.getUint16(p + 8) === 0) {
        return parseTiff(v, p + 10, Math.min(v.byteLength, p + 2 + len));
      }
      if (len < 2) return {};
      p += 2 + len;
    }
  } catch {
    /* truncated or malformed: no EXIF */
  }
  return {};
}

function parseTiff(v, start, end) {
  const order = v.getUint16(start);
  if (order !== 0x4949 && order !== 0x4d4d) return {};
  const le = order === 0x4949;
  const u16 = (o) => v.getUint16(o, le);
  const u32 = (o) => v.getUint32(o, le);
  if (u16(start + 2) !== 42) return {};
  const raw = {};
  const seen = new Set();
  const readIfd = (off) => {
    const at = start + off;
    if (seen.has(at) || at + 2 > end) return;
    seen.add(at);
    const n = u16(at);
    for (let i = 0; i < n; i++) {
      const e = at + 2 + i * 12;
      if (e + 12 > end) return;
      const name = TAGS[u16(e)];
      if (!name) continue;
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = (TYPE_SIZE[type] || 0) * count;
      if (!size) continue;
      const data = size <= 4 ? e + 8 : start + u32(e + 8);
      if (data + size > end) continue;
      if (type === 2) {
        let s = '';
        for (let k = 0; k < count; k++) {
          const c = v.getUint8(data + k);
          if (!c) break;
          s += String.fromCharCode(c);
        }
        raw[name] = s.trim();
      } else if (type === 3) raw[name] = u16(data);
      else if (type === 4 || type === 9) raw[name] = type === 9 ? v.getInt32(data, le) : u32(data);
      else if (type === 5 || type === 10) {
        const num = type === 10 ? v.getInt32(data, le) : u32(data);
        const den = type === 10 ? v.getInt32(data + 4, le) : u32(data + 4);
        raw[name] = den ? num / den : null;
      }
    }
    if (raw.exifIfd && !seen.has(start + raw.exifIfd)) readIfd(raw.exifIfd);
  };
  readIfd(u32(start + 4));

  const out = {};
  const taken = parseExifDate(raw.dateTimeOriginal || raw.dateTimeDigitized || raw.dateTime, raw.offsetTimeOriginal);
  if (taken) out.takenAt = taken;
  const camera = cameraName(raw.make, raw.model);
  if (camera) out.camera = camera;
  if (raw.orientation >= 1 && raw.orientation <= 8) out.orientation = raw.orientation;
  if (raw.pixelWidth > 0 && raw.pixelHeight > 0) {
    out.width = raw.pixelWidth;
    out.height = raw.pixelHeight;
  }
  const exp = [];
  if (raw.fNumber) exp.push(`ƒ/${round(raw.fNumber, 1)}`);
  if (raw.exposureTime) exp.push(raw.exposureTime >= 1 ? `${round(raw.exposureTime, 1)}s` : `1/${Math.round(1 / raw.exposureTime)}s`);
  if (raw.focalLength) exp.push(`${round(raw.focalLength, 1)}mm`);
  if (raw.iso) exp.push(`ISO ${raw.iso}`);
  if (exp.length) out.exposure = exp.join(' · ');
  return out;
}

const round = (n, d) => String(Math.round(n * 10 ** d) / 10 ** d);

/**
 * "2024:07:14 18:03:22" (+ "+02:00") → epoch ms. Without an offset the time is read as local time, which is
 * what a camera's clock shows. Returns null for the all-zero dates some cameras write.
 */
export function parseExifDate(s, offset = '') {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || ''));
  if (!m) return null;
  const [y, mo, d, h, mi, se = '0'] = m.slice(1).map(Number);
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const o = /^([+-])(\d{2}):(\d{2})$/.exec(String(offset || ''));
  if (o) {
    const mins = (Number(o[2]) * 60 + Number(o[3])) * (o[1] === '-' ? -1 : 1);
    return Date.UTC(y, mo - 1, d, h, mi, se) - mins * 60000;
  }
  const t = new Date(y, mo - 1, d, h, mi, se).getTime();
  return Number.isFinite(t) ? t : null;
}

/** "Apple" + "iPhone 15 Pro" → "iPhone 15 Pro"; "Canon" + "Canon EOS R6" → "Canon EOS R6"; "SAMSUNG" + "SM-S918B" → "Samsung SM-S918B". */
export function cameraName(make, model) {
  const mk = String(make || '').trim();
  const md = String(model || '').trim();
  if (!md) return mk ? titleCase(mk) : '';
  if (!mk || md.toLowerCase().startsWith(mk.toLowerCase().split(' ')[0]) || /^apple$/i.test(mk)) return md;
  return `${titleCase(mk.split(' ')[0])} ${md}`;
}
const titleCase = (s) => (s === s.toUpperCase() ? s.charAt(0) + s.slice(1).toLowerCase() : s);
