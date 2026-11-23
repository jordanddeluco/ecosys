// Static file serving under attack (server/static.mjs via server/http.mjs): path traversal in every
// spelling, dotfiles, NTFS streams, 8.3 short names, trailing dots/spaces, device names, unicode
// look-alikes, absolute/UNC paths, symlink escapes, very long paths, malformed percent-encoding and
// open redirects. Most probes run against a throw-away fixture root whose forbidden files contain
// canary strings, so a leak is detected whatever status code comes back.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createScope, startServer, rawHttp, request, BS, randomHex } from './_harness.js';

const WIN = process.platform === 'win32';

function makeFixtureRoot(scope) {
  const base = scope.tempDir('static');
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  const canaries = new Map();
  const put = (rel, content, where = root) => {
    const p = join(where, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  const secret = (rel, where = root) => {
    const c = `CANARY-${rel.replace(/[^a-z0-9]/gi, '_')}-${randomHex()}`;
    put(rel, c, where);
    canaries.set(rel, c);
  };
  put('index.html', '<!doctype html><title>fixture</title><p>PUBLIC-INDEX</p>');
  put('public.txt', 'PUBLIC-TXT');
  put('tasks/index.html', '<!doctype html><title>tasks</title><p>PUBLIC-TASKS</p>');
  put('tasks/app.js', 'export const PUBLIC = 1;');
  put('shared/ui.css', 'body{}');
  put('docs/readme.md', '# public');
  put('dir.with.dots/file.txt', 'PUBLIC-DOTS');
  for (const rel of [
    '.git/config', '.git/HEAD', '.git/objects/ab/cdef', '.gitignore', '.env',
    '.ecosys/ai.json', '.ecosys/data.json', '.ecosys/server.json', '.claude/settings.local.json', 'tasks/.secret',
    'server/core.mjs', 'server.mjs', 'mcp/stdio-bridge.mjs', 'tests/x.test.js', 'package.json', 'package-lock.json', 'start.cmd', 'node_modules/x/index.js',
  ]) secret(rel);
  secret('secret.txt', outside);
  const links = [];
  const link = (target, name, type) => {
    try {
      symlinkSync(target, join(root, name), type);
      links.push(name);
    } catch {}
  };
  link(outside, 'linkout', 'junction');
  link(join(root, '.git'), 'gitlink', 'junction');
  link(join(root, '.ecosys'), 'datalink', 'junction');
  link(join(outside, 'secret.txt'), 'filelink.txt', 'file'); // needs a privilege on Windows; skipped if refused
  let ads = false;
  if (WIN) {
    try {
      const c = `CANARY-ADS-${randomHex()}`;
      writeFileSync(join(root, 'public.txt:hidden'), c);
      canaries.set('public.txt:hidden', c);
      ads = readFileSync(join(root, 'public.txt:hidden'), 'utf8') === c && readFileSync(join(root, 'public.txt'), 'utf8') === 'PUBLIC-TXT';
    } catch {}
  }
  return { base, root, outside, canaries, links, ads };
}

/** Real 8.3 short names in `dir` (Windows only, when the volume generates them): [{short, long}]. */
function shortNames(dir) {
  if (!WIN) return [];
  let out = '';
  try {
    out = execFileSync('cmd.exe', ['/d', '/c', 'dir', '/x', '/a', dir], { encoding: 'utf8', windowsHide: true });
  } catch {
    return [];
  }
  const found = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /\s(\S*~\d\S*)\s+(\S.*)$/.exec(line);
    if (m) found.push({ short: m[1], long: m[2].trim() });
  }
  return found;
}

describe('static files: traversal, hidden files and redirects', () => {
  const scope = createScope('static');
  let fx;
  let s;
  let real;
  before(async () => {
    fx = makeFixtureRoot(scope);
    s = await startServer(scope, { root: fx.root });
    real = await startServer(scope); // the real repository root; .ecosys is never requested from it
  });
  after(() => scope.cleanup());

  const WIN_INI = /for 16-bit app support|\[fonts\]|\[extensions\]/i;
  function assertNoLeak(r, label) {
    for (const [name, c] of fx.canaries) assert.ok(!r.text.includes(c), `${label}: leaked ${name} (status ${r.status})`);
    assert.ok(!WIN_INI.test(r.text), `${label}: leaked win.ini`);
  }
  async function probe(target, { allowed = [400, 404], method = 'GET', server = s } = {}) {
    const r = await rawHttp(server.port, { method, target });
    assertNoLeak(r, `${method} ${target}`);
    assert.ok(allowed.includes(r.status), `${method} ${JSON.stringify(target)} -> ${r.status} ${r.error || ''}`);
    return r;
  }

  test('sanity: public fixture files are served', async () => {
    assert.equal((await probe('/', { allowed: [200] })).text.includes('PUBLIC-INDEX'), true);
    assert.equal((await probe('/public.txt', { allowed: [200] })).text, 'PUBLIC-TXT');
    assert.equal((await probe('/tasks/', { allowed: [200] })).text.includes('PUBLIC-TASKS'), true);
    assert.equal((await probe('/dir.with.dots/file.txt', { allowed: [200] })).text, 'PUBLIC-DOTS');
    assert.equal((await probe('/tasks', { allowed: [301] })).headers.location, '/tasks/');
  });

  test('dotfiles and dot-folders (.git, .ecosys, .claude, .env) are never served, however they are spelled', async () => {
    const targets = [
      '/.git/config', '/.git/HEAD', '/.git/objects/ab/cdef', '/.git', '/.git/', '/.gitignore', '/.env',
      '/.ecosys/ai.json', '/.ecosys/data.json', '/.ecosys/server.json', '/.ecosys', '/.ecosys/', '/.claude/settings.local.json', '/tasks/.secret',
      '/%2egit/config', '/%2Egit/HEAD', '/.%67it/config', '/%2e%65cosys/ai.json', '/.ecosys%2Fai.json', '/.ecosys%2fai.json', '/%2e%65nv',
      '/tasks/../.git/config', '/tasks/%2e%2e/.git/config', '/tasks/.%2e/.git/config', '/tasks/%2E%2E/.ecosys/ai.json', '/./.git/config',
      '/tasks/./.secret', '/x/../.env', '/%2e%2e%2f.git/config', '/tasks/%2e%2e%2f.ecosys%2fai.json',
      '/.GIT/config', '/.Ecosys/AI.JSON', '/.well-known/../.git/config', '/.git./config', '/.git%20/config', '/.ecosys./ai.json', '/.ecosys%20/ai.json',
      '/gitlink/config', '/gitlink/HEAD', '/datalink/ai.json',
    ];
    for (const t of targets) {
      const r = await probe(t);
      assert.equal(r.headers.etag, undefined, `${t}: no ETag for a refused file`);
    }
  });

  test('hidden files ignore conditional and range headers and reveal no metadata', async () => {
    for (const method of ['GET', 'HEAD']) {
      const r = await rawHttp(s.port, {
        method,
        target: '/.git/config',
        headers: [['If-None-Match', '*'], ['If-Modified-Since', 'Thu, 01 Jan 1970 00:00:00 GMT'], ['Range', 'bytes=0-10']],
      });
      assert.equal(r.status, 404, method);
      assert.equal(r.headers.etag, undefined);
      assert.equal(r.headers['last-modified'], undefined);
      assert.equal(r.headers['content-range'], undefined);
      assertNoLeak(r, method);
    }
    assert.ok((await rawHttp(s.port, { target: '/public.txt' })).headers.etag, 'sanity: public files do get an ETag');
  });

  test('encoded and literal backslashes or mixed separators never reach hidden files', async () => {
    for (const t of [
      '/%5C.git%5Cconfig', '/tasks%5C..%5C.git%5CHEAD', '/tasks%5c..%5c.ecosys%5cai.json', '/%5C%5C127.0.0.1%5Cc$%5Cx',
      '/tasks/..%5C.git/config', '/tasks%2F..%5C.git%5Cconfig', '/%5c.ecosys/ai.json', '/tasks/%5C%2E%2E%5C.git', '/%5C..%5Coutside%5Csecret.txt',
      // literal backslashes in the request line (the URL parser turns them into '/')
      `/tasks${BS}..${BS}.git${BS}config`, `/tasks${BS}..${BS}.ecosys${BS}ai.json`, `/tasks/..${BS}.git/config`, `/tasks${BS}..${BS}..${BS}outside${BS}secret.txt`,
    ]) await probe(t);
  });

  test('NTFS alternate data streams are refused', async (t) => {
    if (WIN && !fx.ads) t.diagnostic('could not create an alternate data stream on this volume; probing the syntax only');
    for (const target of [
      '/public.txt:hidden', '/public.txt%3Ahidden', '/public.txt%3ahidden', '/public.txt::$DATA', '/public.txt%3A%3A%24DATA', '/index.html::$DATA',
      '/tasks::$INDEX_ALLOCATION/index.html', '/tasks%3A%3A%24INDEX_ALLOCATION/index.html', '/.git::$INDEX_ALLOCATION/config', '/public.txt:Zone.Identifier',
      '/public.txt:hidden:$DATA', '/tasks/index.html%3A%3A%24DATA',
    ]) await probe(target, { allowed: [400] });
  });

  test('Windows 8.3 short names are refused (generic and the real short names on disk)', async (t) => {
    const generic = [
      '/GIT~1/config', '/GIT~1/HEAD', '/git~1/config', '/GITIGN~1', '/ECOSYS~1/ai.json', '/ECOSYS~1/data.json', '/CLAUDE~1/settings.local.json',
      '/PACKAG~1.JSO', '/PACKAG~2.JSO', '/SERVER~1.MJS', '/NODE_M~1/x/index.js', '/%7E', '/GIT%7E1/config', '/ECOSYS%7e1/ai.json', '/tasks/~', '/~/', '/~',
    ];
    for (const target of generic) await probe(target, { allowed: [400] });
    const names = shortNames(fx.root).filter(({ long }) => long.startsWith('.') || ['package-lock.json', 'node_modules', 'server.mjs'].includes(long));
    if (!names.length) t.diagnostic('this volume does not generate 8.3 names; only the generic spellings were probed');
    for (const { short, long } of names) {
      assert.ok(statSync(join(fx.root, short)), `the OS resolves ${short} to ${long}`);
      const target = long === '.git' ? `/${short}/config` : long === '.ecosys' ? `/${short}/ai.json` : long === '.claude' ? `/${short}/settings.local.json` : long === 'node_modules' ? `/${short}/x/index.js` : `/${short}`;
      await probe(target, { allowed: [400] });
    }
  });

  test('encoded, double-encoded and overlong traversal never leaves the root', async () => {
    for (const target of [
      '/%2e%2e/%2e%2e/outside/secret.txt', '/..%2f..%2foutside%2fsecret.txt', '/%2e%2e%2f%2e%2e%2foutside%2fsecret.txt', '/..%2Foutside%2Fsecret.txt',
      '/%252e%252e/%252e%252e/outside/secret.txt', '/%25252e%25252e/outside/secret.txt', '/%252e%252e%252foutside%252fsecret.txt',
      '/..%5c..%5coutside%5csecret.txt', '/%c0%ae%c0%ae/outside/secret.txt', '/%c0%af..%c0%afoutside', '/%e0%80%ae%e0%80%ae/outside/secret.txt',
      '/%u002e%u002e/outside/secret.txt', '/%uff0e%uff0e/outside/secret.txt', '/tasks/../../outside/secret.txt', '/tasks/..%2F..%2Foutside%2Fsecret.txt',
      '/' + '../'.repeat(50) + 'outside/secret.txt', '/' + '%2e%2e/'.repeat(50) + 'outside/secret.txt', '/' + '..%2f'.repeat(50) + 'outside%2fsecret.txt',
      '/' + '%2e%2e%2f'.repeat(50) + 'Windows/win.ini', '/' + '..%5c'.repeat(50) + 'Windows%5cwin.ini', '/....//....//outside/secret.txt', '/..../outside/secret.txt',
      '/.../outside/secret.txt', '/tasks/...%2f...%2foutside%2fsecret.txt',
    ]) await probe(target, { allowed: [400, 404] });
  });

  test('unicode look-alikes and normalization tricks do not reach hidden or denied files', async () => {
    for (const target of [
      '/%EF%BC%8Egit/config', '/%E2%80%A4git/config', '/%E2%80%A4%E2%80%A4/%E2%80%A4%E2%80%A4/outside/secret.txt', '/%EF%BC%8E%EF%BC%8E/%EF%BC%8E%EF%BC%8E/outside/secret.txt',
      '/%C5%BFerver/core.mjs', '/te%C5%BFt%C5%BF/x.test.js', '/%C5%BFtart.cmd', '/.git%E2%80%8B/config', '/%E2%80%8B.git/config', '/.%CC%81git/config',
      '/%EF%BC%8F.git%EF%BC%8Fconfig', '/%E2%88%95.git%E2%88%95config', '/tasks%EF%BC%8F..%EF%BC%8F.git%EF%BC%8Fconfig', '/%C0%AEgit/config',
      '/%F0%9F%98%80/../.git/config', '/node_modules%C2%A0/x/index.js', '/server%E3%80%80/core.mjs', '/%EF%BB%BF.git/config', '/.git%EF%BB%BF/config',
      '/SERVER/core.mjs'.normalize('NFKD'), '/%E2%84%AA.git/config',
    ]) await probe(target, { allowed: [400, 404] });
  });

  test('trailing dots, trailing spaces and DOS device names do not bypass the deny lists', async () => {
    for (const target of [
      '/server./core.mjs', '/server%20/core.mjs', '/server.%20/core.mjs', '/server%2E/core.mjs', '/package.json.', '/package.json%20', '/package.json%2E', '/package.json...',
      '/server.mjs.', '/server.mjs%20', '/start.cmd.', '/start.cmd%20', '/tests./x.test.js', '/mcp%20/stdio-bridge.mjs', '/mcp./stdio-bridge.mjs', '/node_modules./x/index.js',
      '/package-lock.json.', '/CON', '/NUL', '/AUX', '/PRN', '/COM1', '/LPT1', '/CONIN$', '/CONOUT$', '/tasks/CON', '/con.txt', '/nul.html', '/tasks/NUL.js', '/COM%C2%B9',
    ]) await probe(target, { allowed: [400, 404] });
  });

  test('case variations do not bypass the deny list of tooling folders and files', async () => {
    for (const target of [
      '/SERVER/core.mjs', '/Server/core.mjs', '/sErVeR/core.mjs', '/PACKAGE.JSON', '/Package.Json', '/MCP/stdio-bridge.mjs', '/Mcp/stdio-bridge.mjs',
      '/Tests/x.test.js', '/TESTS/x.test.js', '/START.CMD', '/Server.Mjs', '/SERVER.MJS', '/NODE_MODULES/x/index.js', '/Package-Lock.JSON',
    ]) await probe(target, { allowed: [404] });
  });

  test('absolute paths, drive letters, UNC and device paths are refused', async () => {
    const abs = join(fx.outside, 'secret.txt');
    for (const target of [
      '/C:/Windows/win.ini', '/c:/windows/win.ini', '/C%3A/Windows/win.ini', '/C%3A%5CWindows%5Cwin.ini', '/%5C%5C%3F%5CC%3A%5CWindows%5Cwin.ini',
      '/%5C%5Clocalhost%5Cc$%5CWindows%5Cwin.ini', '/%5C%5C.%5Cpipe%5Cx', '/%5C%5C.%5CPhysicalDrive0', `/${encodeURIComponent(abs)}`,
      '/' + abs.replace(/\\/g, '/'), '/etc/passwd', '//etc/passwd', '///etc/passwd', '/%2Fetc%2Fpasswd', '/%2F%2F127.0.0.1%2Fc$%2FWindows%2Fwin.ini',
    ]) await probe(target, { allowed: [400, 404] });
    for (const target of ['C:/Windows/win.ini', 'file:///C:/Windows/win.ini', `http://127.0.0.1:${s.port}/.git/config`, 'http://evil.example/.ecosys/ai.json', '*', '.git/config']) {
      await probe(target, { allowed: [400] });
    }
    // '//?/C:/...' collapses to '/' with a query string: the public index, nothing else.
    const q = await probe('//?/C:/Windows/win.ini', { allowed: [200, 400, 404] });
    if (q.status === 200) assert.ok(q.text.includes('PUBLIC-INDEX'));
  });

  test('symlinks and junctions cannot lead outside the root or into hidden folders', async (t) => {
    if (!fx.links.length) return t.skip('this system refused to create links');
    t.diagnostic(`links created: ${fx.links.join(', ')}`);
    for (const target of ['/linkout/secret.txt', '/linkout/', '/linkout', '/gitlink/config', '/gitlink/HEAD', '/gitlink/', '/datalink/ai.json', '/datalink/data.json', '/filelink.txt']) {
      await probe(target, { allowed: [301, 404] });
    }
  });

  test('NUL, control characters and CRLF are refused, and nothing is injected into headers', async () => {
    for (const target of ['/index.html%00', '/index.html%00.txt', '/tasks%00/', '/%00', '/public.txt%0a', '/%0d%0aSet-Cookie:%20pwned=1', '/%09', '/%7F', '/%1b[31m', '/public.txt%0d%0aX-Injected:%201']) {
      const r = await probe(target, { allowed: [400] });
      assert.equal(r.headers['set-cookie'], undefined);
      assert.equal(r.headers['x-injected'], undefined);
    }
    const q = await probe('/tasks?%0d%0aSet-Cookie:%20pwned=1', { allowed: [301] });
    assert.equal(q.headers['set-cookie'], undefined);
    assert.ok(!/[\r\n]/.test(q.headers.location));
  });

  test('very long paths are refused cleanly and the server keeps answering', async () => {
    for (const [target, allowed] of [
      ['/' + 'a'.repeat(255), [404]],
      ['/' + 'a'.repeat(300), [404]],
      ['/' + Array(70).fill('b'.repeat(200)).join('/'), [404]],
      ['/.git/' + 'c'.repeat(5000), [404]],
      ['/' + 'd'.repeat(20000), [414, 431, 400]],
      ['/' + '/'.repeat(5000) + 'public.txt', [200]],
      ['/' + '../'.repeat(2000) + 'public.txt', [200, 404]],
    ]) {
      const r = await rawHttp(s.port, { target, timeout: 15000 });
      assertNoLeak(r, `long path (${target.length} chars)`);
      assert.ok(allowed.includes(r.status), `${target.length}-char path -> ${r.status} ${r.error || ''}`);
    }
    const huge = await rawHttp(s.port, { target: '/' + 'e'.repeat(100000), timeout: 15000 });
    assert.ok(huge.status === 0 || huge.status === 431 || huge.status === 414 || huge.status === 400, `100 KB path -> ${huge.status}`);
    assert.equal((await rawHttp(s.port, { target: '/public.txt' })).status, 200, 'still serving');
  });

  test('malformed percent-encoding is a 400 for files, and never a 500 anywhere', async () => {
    for (const target of ['/%', '/%%', '/%zz', '/%E0%A4%A', '/%C0%AF', '/%ED%A0%80', '/%F4%90%80%80', '/%FF', '/tasks/%G1', '/%2', '/%u002e', '/tasks/%E2%82', '/%C3']) {
      await probe(target, { allowed: [400] });
    }
    const other = [
      { method: 'GET', target: '/api/%zz', headers: [['X-Ecosys', s.secret]] },
      { method: 'DELETE', target: '/api/ai/clients/%zz', headers: [['X-Ecosys', s.secret]] },
      { method: 'POST', target: '/s/%zz/mcp', headers: [['Content-Type', 'application/json']], body: '{}' },
      { method: 'POST', target: '/s/%E0%A4%A/mcp', headers: [['Content-Type', 'application/json']], body: '{}' },
      { method: 'GET', target: '/.well-known/%zz' },
      { method: 'GET', target: '/tasks/?q=%zz' },
      { method: 'GET', target: '/api/events?client=%zz', headers: [['X-Ecosys', s.secret]], headersOnly: true },
    ];
    for (const o of other) {
      const r = await rawHttp(s.port, o);
      assert.ok(r.status > 0 && r.status < 500, `${o.method} ${o.target} -> ${r.status}`);
    }
    assert.equal(s.log.entries.filter((e) => e.level === 'error').length, 0, s.log.text());
  });

  test('a raw backslash right after the first slash is a 400, not a 500, and is not logged', async () => {
    // A request target such as "/\%zz/" is parsed by `new URL()` as a protocol-relative URL with an
    // invalid host, which throws. That must be a client error, not a server error with a log line.
    const before = s.log.entries.length;
    const statuses = {};
    for (const target of [`/${BS}%zz/`, `/${BS}[/`, `/${BS}%00/`, `/${BS}%/x`]) statuses[target] = (await rawHttp(s.port, { target })).status;
    const logged = s.log.entries.slice(before).map((e) => e.text.split('\n')[0]);
    assert.deepEqual(statuses, Object.fromEntries(Object.keys(statuses).map((k) => [k, 400])), `statuses: ${JSON.stringify(statuses)}; logged: ${JSON.stringify(logged)}`);
    assert.deepEqual(logged, [], 'malformed request targets are not server errors');
  });

  test('directory redirects never leave this origin', async () => {
    const origin = `http://127.0.0.1:${s.port}`;
    const cases = [
      '/tasks', '/tasks?x=1', '/%2Ftasks', '//tasks', '///tasks', '/%5Cevil.example%5C..%5Ctasks', '/%2F%2Fevil.example', '/%2F%2Fevil.example%2Ftasks',
      '/%5C%5Cevil.example/tasks', `/${BS}evil.example/tasks`, `/${BS}${BS}evil.example/tasks`, '/tasks?next=//evil.example', '/tasks?%2F%2Fevil.example',
      '/tasks%3F@evil.example', '/tasks%23@evil.example', '/%09/evil.example', '/tasks/..%2F%2Fevil.example', '/.%2E/tasks', '/tasks%2F', '/tasks;evil.example',
      '/dir.with.dots', '/linkout',
    ];
    for (const target of cases) {
      const r = await rawHttp(s.port, { target });
      assertNoLeak(r, target);
      assert.ok(r.status > 0 && r.status < 500, `${target} -> ${r.status}`);
      const loc = r.headers.location;
      if (loc === undefined) continue;
      assert.equal(r.status, 301, `${target}: a Location only on directory redirects`);
      assert.ok(loc.startsWith('/') && !loc.startsWith('//') && !loc.includes(BS) && !/[\u0000-\u001f\u007f]/.test(loc), `${target} -> Location ${JSON.stringify(loc)}`);
      assert.equal(new URL(loc, `${origin}/a/b`).origin, origin, `${target} -> ${loc} resolves off-origin`);
    }
  });

  test('only GET and HEAD reach files; other methods never return or change them', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE', 'PROPFIND', 'MKCOL', 'MOVE', 'COPY', 'LOCK']) {
      for (const target of ['/public.txt', '/.git/config', '/tasks/']) {
        const r = await rawHttp(s.port, { method, target, headers: [['Destination', `http://127.0.0.1:${s.port}/moved.txt`], ['Overwrite', 'T']] });
        assertNoLeak(r, `${method} ${target}`);
        assert.ok(!r.text.includes('PUBLIC-TXT'), `${method} ${target} returned the file`);
        assert.ok(r.status === 405 || r.status === 400, `${method} ${target} -> ${r.status}`);
        if (r.status === 405) assert.equal(r.headers.allow, 'GET, HEAD');
      }
    }
    assert.equal(readFileSync(join(fx.root, 'public.txt'), 'utf8'), 'PUBLIC-TXT');
    assert.ok(!existsSync(join(fx.root, 'moved.txt')));
  });

  test('the real repository: .git and tooling files are not served, the apps are', async () => {
    for (const target of [
      '/.git/config', '/.git/HEAD', '/GIT~1/config', '/%5C.git%5Cconfig', '/tasks%5C..%5C.git%5CHEAD', '/.gitignore', '/.gitattributes',
      '/server/http.mjs', '/server/static.mjs', '/mcp/stdio-bridge.mjs', '/package.json', '/server.mjs', '/start.cmd', '/tests/server-http.test.js', '/tests/security/_harness.js',
    ]) {
      const r = await rawHttp(real.port, { target });
      assert.ok(r.status === 400 || r.status === 404, `${target} -> ${r.status}`);
      assert.ok(!/\[core\]|ref: refs\/|createEcosysServer|"scripts"|node_modules\//.test(r.text), `${target} leaked`);
    }
    for (const target of ['/', '/tasks/', '/schedule/']) assert.equal((await request(real.port, { path: target })).status, 200, target);
  });
});
