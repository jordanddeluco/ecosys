// ecosys — tiny zero-dependency static server.
// All apps are served from one origin so they share the same local data store.
//   node server.mjs            → http://127.0.0.1:4300
//   node server.mjs --open     → also opens the browser
//   PORT=5000 HOST=0.0.0.0 node server.mjs   → expose on your network
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT) || 4300;
const HOST = process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

function send(res, code, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...extra });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    // Collapse leading slashes so "//foo" isn't parsed as a protocol-relative URL.
    const url = new URL(req.url.replace(/^\/+/, '/'), 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    // Never serve dotfiles/dot-directories (.git, .claude, …).
    if (pathname.split('/').some((seg) => seg.startsWith('.'))) return send(res, 404, 'Not found');

    let file = resolve(ROOT, '.' + pathname);
    if (file !== ROOT && !file.startsWith(ROOT + sep)) return send(res, 403, 'Forbidden');

    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      if (!pathname.endsWith('/')) {
        res.writeHead(301, { Location: pathname + '/' + url.search });
        return res.end();
      }
      file = join(file, 'index.html');
      info = await stat(file).catch(() => null);
    }
    if (!info?.isFile()) return send(res, 404, 'Not found');

    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (err) {
    console.error(err);
    send(res, 500, 'Server error');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Is ecosys already running? Try PORT=4301 node server.mjs`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/`;
  console.log(`\n  ecosys is running\n\n  Home      ${url}\n  Tasks     ${url}tasks/\n  Schedule  ${url}schedule/\n\n  Ctrl+C to stop\n`);
  if (process.argv.includes('--open')) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd);
  }
});
