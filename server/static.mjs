// Hardened static file serving for the ecosys apps.
//  - decoded paths with backslashes, NUL/control chars, ':' (NTFS streams), '~' (8.3 short names)
//    or empty segments are refused before touching the disk
//  - any segment starting with '.' is never served (.git, .ecosys, .claude, ...), nor server code
//  - the real path (symlinks and short names expanded) must stay inside the root, with the same rules
//  - directory redirects are built from the encoded path and can never be protocol-relative
import { stat, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, resolve, relative, isAbsolute } from 'node:path';

export const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/** Top-level folders and files that are part of the tooling, not the apps. */
const DENY_TOP = new Set(['node_modules', 'server', 'mcp', 'tests', 'server.mjs', 'package.json', 'package-lock.json', 'start.cmd']);

export const BASE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/**
 * Photos backs up to OneDrive or Google Drive from the browser, so its pages (and only those) may also talk
 * to those two clouds, and play the videos it keeps as blobs. photos/index.html's meta policy lists the same.
 */
export const PHOTOS_CLOUD_HOSTS = [
  'https://login.microsoftonline.com',
  'https://graph.microsoft.com',
  'https://api.onedrive.com',
  'https://*.1drv.com',
  'https://*.sharepoint.com',
  'https://*.microsoftpersonalcontent.com',
  'https://www.googleapis.com',
];
export const photosCsp = (csp) =>
  csp.replace("connect-src 'self'", `connect-src 'self' ${PHOTOS_CLOUD_HOSTS.join(' ')}`).replace("img-src 'self' data: blob:;", "img-src 'self' data: blob:; media-src 'self' blob:;");

/** Reason a decoded path is refused, or null when it may be looked up. */
export function badPath(decoded) {
  if (!decoded.startsWith('/')) return 400;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f:~]/.test(decoded) || decoded.includes('//')) return 400;
  const segs = decoded.split('/').slice(1);
  if (segs.some((s) => s.startsWith('.'))) return 404;
  if (DENY_TOP.has(segs[0]?.toLowerCase())) return 404;
  return null;
}

function inside(root, p) {
  const rel = relative(root, p);
  if (rel === '') return true;
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  return !rel.split(/[\\/]/).some((s) => s.startsWith('.') || s.includes('~') || s.includes(':'));
}

// Pages that still carry inline <script> blocks get their exact hashes added to script-src, so the
// strict policy can be enforced today without breaking them. Injected scripts never match.
const cspCache = new Map();
function cspFor(file, mtimeMs, body, photos = false) {
  const hit = cspCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.csp;
  const html = body.toString('utf8');
  const hashes = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    hashes.push(`'sha256-${createHash('sha256').update(m[2], 'utf8').digest('base64')}'`);
  }
  const base = photos ? photosCsp(BASE_CSP) : BASE_CSP;
  const csp = hashes.length ? base.replace("script-src 'self'", `script-src 'self' ${hashes.join(' ')}`) : base;
  cspCache.set(file, { mtimeMs, csp });
  return csp;
}

/**
 * Serve a GET/HEAD request from `root`. `send(status, text)` writes an error response;
 * `headers` are the security headers to add to a success.
 * @returns {Promise<void>}
 */
export async function serveStatic(req, res, { root, url, headers, send }) {
  let decoded;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return send(400, 'Bad request');
  }
  const bad = badPath(decoded);
  if (bad) return send(bad, bad === 400 ? 'Bad request' : 'Not found');

  let file = resolve(root, '.' + decoded);
  if (!inside(root, file)) return send(404, 'Not found');
  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    if (!decoded.endsWith('/')) {
      const location = '/' + url.pathname.replace(/^[/\\]+/, '') + '/' + url.search;
      res.writeHead(301, { ...headers, Location: location, 'Content-Length': 0 });
      return res.end();
    }
    file = join(file, 'index.html');
    info = await stat(file).catch(() => null);
  }
  if (!info?.isFile()) return send(404, 'Not found');
  const real = await realpath(file).catch(() => null);
  const realRoot = await realpath(root).catch(() => root);
  if (!real || !inside(realRoot, real)) return send(404, 'Not found');

  const type = TYPES[extname(real).toLowerCase()] || 'application/octet-stream';
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const out = { ...headers, 'Content-Type': type, ETag: etag };
  if (req.headers['if-none-match'] === etag && !type.startsWith('text/html')) {
    res.writeHead(304, out);
    return res.end();
  }
  const body = await readFile(real);
  if (type.startsWith('text/html')) out['Content-Security-Policy'] = cspFor(real, info.mtimeMs, body, /^\/photos\//i.test(decoded));
  out['Content-Length'] = body.length;
  res.writeHead(200, out);
  res.end(req.method === 'HEAD' ? undefined : body);
}

