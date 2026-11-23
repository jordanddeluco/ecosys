// Response hardening (server/http.mjs SECURITY_HEADERS, server/static.mjs BASE_CSP + cspFor):
// every HTML page in the repository gets the full header set and a strict CSP whose only script
// exceptions are exact hashes of that page's own inline scripts; every other response (errors,
// redirects, 304s, SSE, MCP, API) carries the same headers; nothing carries CORS headers; and
// reflected input never comes back as HTML.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createScope, startServer, request, rawHttp, api, mcpPost, bearer, corsHeaders, PING, ROOT } from './_harness.js';

const REQUIRED = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};
const PERMISSIONS = ['camera=()', 'microphone=()', 'geolocation=()'];
const CSP_EXPECT = {
  'default-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'manifest-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
};
const KNOWN = new Set([...Object.keys(CSP_EXPECT), 'script-src']);
const NOT_TOP = new Set(['node_modules', 'server', 'mcp', 'tests']);

function parseCsp(v) {
  const m = new Map();
  for (const part of String(v || '').split(';')) {
    const [name, ...src] = part.trim().split(/\s+/);
    if (name) m.set(name.toLowerCase(), src);
  }
  return m;
}
function inlineScriptHashes(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html))) if (!/\bsrc\s*=/i.test(m[1])) out.push(`'sha256-${createHash('sha256').update(m[2], 'utf8').digest('base64')}'`);
  return out;
}
/** Every .html file the server could serve (dot-folders and tooling folders excluded). */
function htmlFiles(dir = ROOT, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (dir === ROOT && NOT_TOP.has(e.name.toLowerCase())) continue;
    if (e.isDirectory()) htmlFiles(p, out);
    else if (e.name.toLowerCase().endsWith('.html')) out.push(p);
  }
  return out;
}
const urlPath = (file) => '/' + relative(ROOT, file).split(sep).map(encodeURIComponent).join('/');

function checkHeaders(h, label) {
  for (const [k, v] of Object.entries(REQUIRED)) assert.equal(h[k], v, `${label}: ${k}`);
  for (const p of PERMISSIONS) assert.ok(String(h['permissions-policy'] || '').split(/\s*,\s*/).includes(p), `${label}: permissions-policy ${p}`);
  assert.match(h['cache-control'] || '', /\bno-(cache|store)\b/, `${label}: cache-control`);
  const csp = parseCsp(h['content-security-policy']);
  assert.deepEqual(csp.get('frame-ancestors'), ["'none'"], `${label}: frame-ancestors`);
  assert.ok(csp.get('default-src')?.every((x) => x === "'self'" || x === "'none'"), `${label}: default-src`);
}
const BAD_SCRIPT = ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "'wasm-unsafe-eval'", "'strict-dynamic'", '*', 'http:', 'https:', 'data:', 'blob:', 'ws:', 'wss:'];
/** The policy may be stricter than the reference, never looser. */
function checkCsp(value, html, label) {
  const d = parseCsp(value);
  for (const [k, v] of Object.entries(CSP_EXPECT)) {
    const got = d.get(k);
    assert.ok(got && got.length, `${label}: ${k} is missing`);
    assert.ok(got.every((x) => v.includes(x) || x === "'none'"), `${label}: ${k} is looser than ${v.join(' ')}: ${got.join(' ')}`);
  }
  for (const [k, src] of d) {
    if (KNOWN.has(k) || k.startsWith('script-src')) continue;
    if (k === 'upgrade-insecure-requests' || k === 'block-all-mixed-content') continue;
    assert.ok(src.every((x) => x === "'self'" || x === "'none'"), `${label}: extra directive ${k} ${src.join(' ')} loosens the policy`);
  }
  for (const [k, script] of d) {
    if (!k.startsWith('script-src')) continue;
    for (const bad of BAD_SCRIPT) assert.ok(!script.includes(bad), `${label}: ${k} allows ${bad}`);
  }
  const script = d.get('script-src') || [];
  assert.ok(script.includes("'self'") || script.includes("'none'"), `${label}: script-src`);
  const hashes = script.filter((x) => x !== "'self'" && x !== "'none'");
  for (const h of hashes) assert.match(h, /^'sha(256|384|512)-[A-Za-z0-9+/]+=*'$/, `${label}: only hashes may follow 'self'`);
  const allowed = new Set(inlineScriptHashes(html));
  assert.deepEqual(hashes.filter((h) => h.startsWith("'sha256-") && !allowed.has(h)), [], `${label}: hashes that belong to no inline script on this page`);
  assert.deepEqual([...allowed].filter((h) => !hashes.includes(h)), [], `${label}: inline scripts on the page without a hash (they would be blocked)`);
}

describe('security headers and Content-Security-Policy', () => {
  const scope = createScope('headers');
  let s;
  let key;
  let pages;
  before(async () => {
    s = await startServer(scope, { allowedHosts: 'abc.trycloudflare.com' });
    key = s.core.ai.createClient({ kind: 'claude' }).token;
    pages = htmlFiles();
  });
  after(() => scope.cleanup());

  test('every HTML page in the repository gets the full header set and a strict CSP (GET and HEAD)', async (t) => {
    assert.ok(pages.length >= 3, `found ${pages.length} pages`);
    let checked = 0;
    for (const file of pages) {
      const paths = [urlPath(file)];
      if (file.toLowerCase().endsWith(`${sep}index.html`)) paths.push(urlPath(file).replace(/index\.html$/, ''));
      for (const path of paths) {
        const r = await request(s.port, { path });
        if (r.status === 404 && !existsSync(file)) continue; // a temporary preview page another builder removed
        assert.equal(r.status, 200, `${path} -> ${r.status}`);
        assert.equal(r.headers['content-type'], 'text/html; charset=utf-8', path);
        checkHeaders(r.headers, path);
        assert.equal(r.rawHeaders.filter((x, i) => i % 2 === 0 && x.toLowerCase() === 'content-security-policy').length, 1, `${path}: exactly one CSP header`);
        checkCsp(r.headers['content-security-policy'], r.text, path);
        const head = await request(s.port, { method: 'HEAD', path });
        assert.equal(head.status, 200);
        assert.equal(head.headers['content-security-policy'], r.headers['content-security-policy'], `${path}: HEAD gets the same CSP`);
        checked++;
      }
    }
    t.diagnostic(`checked ${checked} page URLs: ${pages.map((p) => relative(ROOT, p)).join(', ')}`);
  });

  test('HTML is never answered with 304, so its CSP always arrives', async () => {
    for (const file of pages.filter(existsSync)) {
      const path = urlPath(file);
      const first = await request(s.port, { path });
      if (first.status !== 200) continue;
      const again = await request(s.port, { path, headers: { 'if-none-match': first.headers.etag, 'if-modified-since': new Date().toUTCString() } });
      assert.equal(again.status, 200, `${path} revalidated to ${again.status}`);
      assert.ok(again.headers['content-security-policy'], path);
    }
  });

  test('error, redirect, 304, SSE, MCP and API responses carry the same security headers', async () => {
    const css = await request(s.port, { path: '/shared/ui.css' });
    const big = await rawHttp(s.port, { method: 'POST', target: '/api/ops', headers: [['X-Ecosys', s.secret], ['Content-Type', 'application/json'], ['Content-Length', '99999999']] });
    const responses = {
      'static 200 (css)': css,
      'static 304': await request(s.port, { path: '/shared/ui.css', headers: { 'if-none-match': css.headers.etag } }),
      'static 404': await request(s.port, { path: '/nope' }),
      'static 400': await rawHttp(s.port, { target: '/%zz' }),
      'static 405': await request(s.port, { method: 'POST', path: '/', body: '{}' }),
      'directory 301': await request(s.port, { path: '/tasks' }),
      'unknown Host 403': await request(s.port, { path: '/', host: 'evil.example' }),
      'tunnel 404': await request(s.port, { path: '/', host: 'abc.trycloudflare.com' }),
      'well-known 404': await request(s.port, { path: '/.well-known/oauth-protected-resource' }),
      'API 200': await api(s, 'GET', '/api/hello'),
      'API 403': await request(s.port, { path: '/api/state' }), // not paired
      'API 404': await api(s, 'GET', '/api/nope'),
      'API 400': await api(s, 'POST', '/api/ops', '{'),
      'API 413': big,
      'SSE 200': await request(s.port, { path: '/api/events?client=h', headers: { 'x-ecosys': s.secret }, headersOnly: true }),
      'MCP 200': await mcpPost(s, PING, bearer(key)),
      'MCP 202': await mcpPost(s, { jsonrpc: '2.0', method: 'notifications/initialized' }, bearer(key)),
      'MCP 400': await mcpPost(s, '{', bearer(key)),
      'MCP 401': await mcpPost(s, PING),
      'MCP 403': await mcpPost(s, PING, { ...bearer(key), origin: 'https://evil.example' }),
      'MCP 405': await mcpPost(s, undefined, bearer(key), '/mcp', { method: 'GET' }),
      'manifest 200': await request(s.port, { path: '/manifest.webmanifest' }),
    };
    assert.equal(responses['static 304'].status, 304);
    assert.equal(responses['API 413'].status, 413);
    assert.equal(responses['MCP 202'].status, 202);
    for (const [label, r] of Object.entries(responses)) {
      assert.ok(r.status > 0, `${label}: ${r.error}`);
      checkHeaders(r.headers, `${label} (${r.status})`);
      assert.deepEqual(corsHeaders(r.headers), [], `${label}: CORS headers`);
    }
  });

  test('no response carries CORS, private-network or timing headers, whatever the Origin', async () => {
    const reqs = [
      { path: '/' }, { path: '/tasks/' }, { path: '/shared/ui.css' }, { path: '/nope' }, { path: '/.git/config' },
      { path: '/api/hello', headers: { 'x-ecosys': '1' } }, { path: '/api/ai', headers: { 'x-ecosys': s.secret } }, { path: '/api/ai', headers: { 'x-ecosys': '1' } },
      { path: '/api/events', headers: { 'x-ecosys': s.secret }, headersOnly: true }, { path: '/api/events', headersOnly: true },
      { method: 'POST', path: '/mcp', body: PING, headers: bearer(key) }, { method: 'POST', path: '/mcp', body: PING },
      { method: 'POST', path: '/mcp', body: PING, headers: bearer(key), host: 'abc.trycloudflare.com' },
      { method: 'OPTIONS', path: '/mcp', host: 'abc.trycloudflare.com', headers: { 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' } },
      { method: 'OPTIONS', path: '/api/ai', headers: { 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-ecosys', 'access-control-request-private-network': 'true' } },
    ];
    for (const origin of [undefined, 'https://evil.example', `http://127.0.0.1:${s.port}`, 'https://claude.ai', 'null']) {
      for (const r0 of reqs) {
        const r = await request(s.port, { ...r0, headers: { ...(r0.headers || {}), origin } });
        assert.deepEqual(corsHeaders(r.headers), [], `${r0.method || 'GET'} ${r0.path} (Origin ${origin})`);
        assert.equal(r.headers['access-control-allow-private-network'], undefined);
      }
    }
  });

  test('reflected input comes back as JSON or plain text with nosniff, never as HTML', async () => {
    const xss = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    const checks = [
      ['MCP unknown tool', await mcpPost(s, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: xss, arguments: {} } }, bearer(key)), /^application\/json/],
      ['MCP unknown method', await mcpPost(s, { jsonrpc: '2.0', id: 1, method: xss }, { ...bearer(key), 'mcp-protocol-version': '2025-06-18' }), /^application\/json/],
      ['MCP id echo', await mcpPost(s, { jsonrpc: '2.0', id: xss, method: 'ping' }, bearer(key)), /^application\/json/],
      ['API op type', await api(s, 'POST', '/api/ops', { ops: [{ op: xss }, { op: 'put', c: xss, item: {} }] }), /^application\/json/],
      ['API undo id', await api(s, 'POST', '/api/ai/undo', { changeId: xss }), /^application\/json/],
      ['static path', await rawHttp(s.port, { target: '/%3Cscript%3Ealert(1)%3C/script%3E' }), /^text\/plain/],
      ['static raw path', await rawHttp(s.port, { target: '/<script>alert(1)</script>' }), /^text\/plain/],
      ['API raw path', await rawHttp(s.port, { target: '/api/<script>', headers: [['X-Ecosys', s.secret]] }), /^application\/json/],
    ];
    for (const [label, r, type] of checks) {
      assert.ok(r.status > 0, label);
      assert.match(r.headers['content-type'] || '', type, `${label}: ${r.headers['content-type']}`);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', label);
      if (/^text\/plain/.test(r.headers['content-type'])) assert.ok(!r.text.includes('<script>'), `${label}: echoed markup`);
    }
  });

  test('responses do not advertise the server software', async () => {
    for (const r of [await request(s.port, { path: '/' }), await api(s, 'GET', '/api/hello'), await mcpPost(s, PING, bearer(key)), await request(s.port, { path: '/nope' })]) {
      assert.equal(r.headers.server, undefined);
      assert.equal(r.headers['x-powered-by'], undefined);
    }
  });

  test('replies that carry connection keys may not be stored by browser caches (Cache-Control: no-store)', async () => {
    // "no-cache" still lets a browser keep the reply in its disk cache (it only has to revalidate
    // before reuse), so the keys would sit in the browser profile's cache folder in plain text.
    const created = await api(s, 'POST', '/api/ai/clients', { kind: 'other', label: 'cache probe' });
    const replies = {
      'GET /api/ai': await api(s, 'GET', '/api/ai'),
      'POST /api/ai/clients': created,
      'POST /api/ai/clients/:id (rotate)': await api(s, 'POST', `/api/ai/clients/${created.json.client.id}`, { rotate: true }),
    };
    const weak = {};
    for (const [label, r] of Object.entries(replies)) {
      assert.equal(r.status, 200, label);
      assert.ok(/"token"/.test(r.text), `${label} carries a key`);
      if (!/\bno-store\b/i.test(r.headers['cache-control'] || '')) weak[label] = r.headers['cache-control'];
    }
    await api(s, 'DELETE', `/api/ai/clients/${created.json.client.id}`);
    assert.deepEqual(weak, {}, 'key-carrying replies without Cache-Control: no-store');
  });

  test('non-HTML files are never served as HTML', async () => {
    const samples = ['/README.md', '/docs/research.md', '/manifest.webmanifest', '/shared/ui.css', '/shared/boot.js', '/shared/icons.js'];
    const icons = existsSync(join(ROOT, 'shared', 'icons')) ? readdirSync(join(ROOT, 'shared', 'icons')).filter((n) => n.endsWith('.svg')).slice(0, 3) : [];
    for (const path of [...samples, ...icons.map((n) => `/shared/icons/${n}`)]) {
      const r = await request(s.port, { path });
      if (r.status === 404) continue;
      assert.equal(r.status, 200, path);
      assert.ok(!/text\/html/.test(r.headers['content-type']), `${path} served as ${r.headers['content-type']}`);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      checkHeaders(r.headers, path);
    }
  });

  test('pages that carry a meta CSP (for static hosting) never weaken script-src', (t) => {
    const missing = [];
    for (const file of pages.filter(existsSync)) {
      const html = readFileSync(file, 'utf8');
      const m = /<meta\s[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/i.exec(html);
      const rel = relative(ROOT, file);
      if (!m) {
        missing.push(rel);
        continue;
      }
      const content = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(m[0]);
      const d = parseCsp(content?.[1] ?? content?.[2]);
      const script = d.get('script-src') || d.get('default-src') || [];
      for (const bad of ["'unsafe-inline'", "'unsafe-eval'", '*', 'http:', 'https:', 'data:']) assert.ok(!script.includes(bad), `${rel}: meta CSP allows ${bad}`);
      assert.deepEqual(d.get('object-src'), ["'none'"], `${rel}: object-src`);
      assert.deepEqual(d.get('base-uri'), ["'none'"], `${rel}: base-uri`);
    }
    if (missing.length) t.diagnostic(`pages without a meta CSP (they rely on the server header locally; GitHub Pages gets none): ${missing.join(', ')}`);
  });
});
