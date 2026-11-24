// Turning files into library items: what they are, when they were taken, how big they are, a preview to
// show in the grids, and a fingerprint so the same photo imported twice is kept once.

import { readExif } from './exif.js';
import * as lib from './library.js';

const THUMB = 480; // longest side of a preview, in pixels (sharp on a 2× screen at the largest grid size)
const IMAGE_TYPES = /^image\/(jpeg|png|gif|webp|avif|bmp|svg\+xml|heic|heif)$/;
const VIDEO_TYPES = /^video\/(mp4|webm|quicktime|ogg|x-m4v)$/;
const EXT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp', mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm' };

/** The file's media type, from the browser or (when it doesn't know, as on Windows for .heic) its extension. */
export function mediaType(file) {
  const t = String(file.type || '').toLowerCase();
  if (IMAGE_TYPES.test(t) || VIDEO_TYPES.test(t)) return t;
  const ext = String(file.name || '').split('.').pop().toLowerCase();
  return EXT_TYPES[ext] || '';
}
export const isVideoType = (t) => String(t).startsWith('video/');

export async function sha256(blob) {
  const buf = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Import files into the library. onProgress({done, total, added, skipped}) after each one.
 * Returns { added: [photo], skipped: [{name, reason}] }.
 */
export async function importFiles(files, { albumId = null, onProgress } = {}) {
  const list = [...files];
  const added = [];
  const skipped = [];
  let n = 0;
  for (const file of list) {
    try {
      const photo = await importOne(file, { albumId });
      if (photo.duplicate) skipped.push({ name: file.name, reason: 'duplicate', photo: photo.duplicate });
      else added.push(photo);
    } catch (err) {
      skipped.push({ name: file.name, reason: err?.message || 'unreadable' });
    }
    onProgress?.({ done: ++n, total: list.length, added: added.length, skipped: skipped.length });
  }
  return { added, skipped };
}

async function importOne(file, { albumId, cloud = null, keepOriginal = true, takenHint = null } = {}) {
  const type = mediaType(file);
  if (!type) throw new Error('not a photo or video');
  const hash = await sha256(file);
  const dup = lib.findByHash(hash);
  if (dup) {
    // Already here: restored from the trash, put in the album, or linked to its cloud copy instead of added twice.
    const patch = {};
    if (dup.deletedAt) patch.deletedAt = null;
    if (albumId && !dup.albumIds?.includes(albumId)) patch.albumIds = [...(dup.albumIds || []), albumId];
    if (cloud && !dup.cloud) patch.cloud = cloud;
    if (Object.keys(patch).length) await lib.updatePhotos([dup.id], patch);
    return { duplicate: dup };
  }
  const video = isVideoType(type);
  const exif = type === 'image/jpeg' ? readExif(await file.slice(0, 262144).arrayBuffer()) : {};
  const shot = video ? await videoPreview(file) : await imagePreview(file);
  const meta = {
    id: lib.uid(),
    name: cleanName(file.name, type),
    type,
    size: file.size,
    width: shot.width || exif.width || 0,
    height: shot.height || exif.height || 0,
    takenAt: exif.takenAt || takenHint || file.lastModified || Date.now(),
    addedAt: Date.now(),
    duration: shot.duration || 0,
    camera: exif.camera || '',
    exposure: exif.exposure || '',
    hash,
    favorite: false,
    albumIds: albumId ? [albumId] : [],
    deletedAt: null,
    local: keepOriginal,
    cloud,
  };
  await lib.addPhoto(meta, keepOriginal ? new Blob([file], { type }) : null, shot.thumb);
  return meta;
}

/** Add an item downloaded from the cloud: its preview stays, the original only if `keepOriginal`. */
export function importFromCloud(blob, { name, cloud, takenAt = null, keepOriginal = false }) {
  const file = new File([blob], name, { type: blob.type || EXT_TYPES[String(name).split('.').pop().toLowerCase()] || '', lastModified: takenAt || Date.now() });
  return importOne(file, { cloud, keepOriginal, takenHint: takenAt });
}

function cleanName(name, type) {
  const n = String(name || '').replace(/[\u0000-\u001f\u007f/\\]/g, '').trim().slice(0, 180);
  if (n) return n;
  const ext = Object.entries(EXT_TYPES).find(([, t]) => t === type)?.[0] || 'jpg';
  return `photo.${ext}`;
}

// ---------------------------------------------------------------- previews

async function imagePreview(blob) {
  let bmp;
  try {
    bmp = await createImageBitmap(blob); // EXIF orientation is applied (imageOrientation defaults to from-image)
  } catch {
    // The browser can't draw it (HEIC outside Safari): keep it, with a placeholder preview.
    return { width: 0, height: 0, thumb: await placeholderThumb(blob.type || 'image') };
  }
  const { width, height } = bmp;
  const thumb = await drawThumb(bmp, width, height);
  bmp.close?.();
  return { width, height, thumb };
}

function videoPreview(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'metadata';
    let settled = false;
    const finish = async (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = { width: v.videoWidth || 0, height: v.videoHeight || 0, duration: Number.isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : 0 };
      try {
        out.thumb = ok && out.width ? await drawThumb(v, out.width, out.height) : await placeholderThumb('video');
      } catch {
        out.thumb = await placeholderThumb('video');
      }
      URL.revokeObjectURL(url);
      v.removeAttribute('src');
      v.load();
      resolve(out);
    };
    const timer = setTimeout(() => finish(false), 15000);
    v.addEventListener('loadedmetadata', () => {
      v.currentTime = Math.min(0.5, (v.duration || 1) / 3);
    });
    v.addEventListener('seeked', () => finish(true), { once: true });
    v.addEventListener('error', () => finish(false), { once: true });
    v.src = url;
  });
}

async function drawThumb(source, w, h) {
  const scale = Math.min(1, THUMB / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, cw, ch);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.82));
}

async function placeholderThumb(kind) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 240;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2a2b36';
  ctx.fillRect(0, 0, 240, 240);
  ctx.fillStyle = '#9b9cab';
  ctx.font = '600 22px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(String(kind).startsWith('video') ? 'Video' : String(kind).replace(/^image\//, '').toUpperCase(), 120, 128);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.8));
}

// ---------------------------------------------------------------- sample photos

/**
 * A dozen generated landscapes spread over the last few months, so an empty library can be tried out.
 * They are ordinary items: favourite them, put them in albums, back them up, delete them.
 */
export async function makeSamples(onProgress) {
  const scenes = [
    ['Sunrise over the lake', ['#ffb36b', '#ff6f91', '#4b3b8f'], 0],
    ['Alpine meadow', ['#9fd8ff', '#5aa9e6', '#2f6f3e'], 3],
    ['City at dusk', ['#3a1c71', '#d76d77', '#ffaf7b'], 6],
    ['Desert road', ['#f6d365', '#fda085', '#7a4a2a'], 11],
    ['Northern lights', ['#0b1d3a', '#1fd1a5', '#0a2a43'], 15],
    ['Beach afternoon', ['#89f7fe', '#66a6ff', '#f2d7a0'], 22],
    ['Forest trail', ['#c3e88d', '#4e9f3d', '#1e5128'], 30],
    ['Snowy peaks', ['#e0eafc', '#cfdef3', '#7f8fa6'], 41],
    ['Autumn park', ['#f7971e', '#ffd200', '#8e3b14'], 57],
    ['Harbour lights', ['#141e30', '#243b55', '#f8b500'], 73],
    ['Lavender field', ['#d9a7c7', '#a18cd1', '#5b3f8c'], 96],
    ['Golden hour', ['#ffe259', '#ffa751', '#6d3b2c'], 128],
  ];
  const files = [];
  for (const [i, [name, colors, daysAgo]] of scenes.entries()) {
    const blob = await paintScene(colors, i);
    const at = new Date();
    at.setDate(at.getDate() - daysAgo);
    at.setHours(7 + ((i * 5) % 12), (i * 17) % 60, 0, 0);
    files.push(new File([blob], `${name}.jpg`, { type: 'image/jpeg', lastModified: at.getTime() }));
  }
  return importFiles(files, { onProgress });
}

function paintScene([sky, glow, land], seed) {
  const w = seed % 3 === 1 ? 1200 : 1600;
  const h = seed % 3 === 1 ? 1600 : 1066;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, sky);
  grad.addColorStop(0.62, glow);
  grad.addColorStop(1, land);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  // the sun
  const sx = w * (0.25 + ((seed * 37) % 50) / 100);
  const sy = h * 0.42;
  const sun = g.createRadialGradient(sx, sy, 0, sx, sy, h * 0.18);
  sun.addColorStop(0, 'rgba(255,255,240,0.95)');
  sun.addColorStop(0.35, 'rgba(255,240,200,0.55)');
  sun.addColorStop(1, 'rgba(255,240,200,0)');
  g.fillStyle = sun;
  g.fillRect(0, 0, w, h);
  // three ridges, darker towards the front
  let r = seed * 9301 + 49297;
  const rand = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  for (let layer = 0; layer < 3; layer++) {
    const base = h * (0.55 + layer * 0.13);
    g.beginPath();
    g.moveTo(0, h);
    g.lineTo(0, base);
    for (let x = 0; x <= w; x += w / 8) g.lineTo(x, base - rand() * h * (0.16 - layer * 0.04));
    g.lineTo(w, h);
    g.closePath();
    g.fillStyle = shade(land, 0.55 - layer * 0.22);
    g.fill();
  }
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.86));
}

function shade(hex, lighten) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (v) => Math.round(v + (255 - v) * Math.max(0, lighten) - v * Math.max(0, -lighten));
  return `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}
