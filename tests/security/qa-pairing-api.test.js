// QA (pairing): the browser API answers only browsers paired with this data folder (lead decision 1).
//  - Every /api route, the event stream included, refuses a request without the exact secret with
//    403 {"error":"pairing_required"}; GET /api/hello stays public and says only whether it was paired.
//  - The stdio bridge's notify takes a connection key's proof, never the pairing secret.
//  - pair.json: made on first start, kept across restarts, private; a damaged one is replaced, an
//    unreadable one stops start-up.
//  - The secret never appears in a response, a log line, server.json or another data file; the start
//    banner shows it once, in the pairing link, and --open opens exactly that link.
//  - Smaller items from the same review: SIGHUP / SIGBREAK clean up server.json, PORT=80 accepts the
//    Origins browsers send, the bridge's notify names records instead of sending them.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCore } from '../../server/core.mjs';
import { createEcosysServer, PAIR_FILE, pairingSecret } from '../../server/http.mjs';
import { broadAccess } from '../../server/util.mjs';
import {
  createScope, startServer, startWrapped, spawnServer, startBridge, request, rawHttp, api, openSse, bearer, captureLog,
  leaked, nearMiss, sleep, freePort, envWith, legacyCall, SERVER_ENTRY, ROOT,
} from './_harness.js';

const silent = { error() {}, warn() {}, info() {}, log() {} };
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const PAIRING = { error: 'pairing_required' };

describe('QA pairing: the browser API needs this data folder\'s pairing secret', () => {
  const scope = createScope('qa-pair');
  after(() => scope.cleanup());

  const fingerprint = (s) => {
    s.core.store.refresh();
    s.core.ai.refresh();
    return JSON.stringify({ rev: s.core.store.rev, data: s.core.store.toJSON(), mode: s.core.ai.mode(), clients: s.core.ai.state.clients.map((c) => [c.id, c.token, c.access, c.label]) });
  };

  test('every /api route, the event stream included, refuses anything but the exact secret with 403 pairing_required', async () => {
    const s = await startServer(scope);
    const other = await startServer(scope);
    const victim = s.core.ai.createClient({ kind: 'claude' });
    const K = s.secret;
    assert.match(K, SECRET_RE);
    assert.notEqual(K, other.secret, 'each data folder has its own secret');
    const routes = [
      ['GET', '/api/state'], ['GET', '/api/events?client=qa'], ['GET', '/api/ai'], ['GET', '/api/ai/status'],
      ['POST', '/api/ops', { client: 'qa', ops: [{ op: 'replace', c: 'tasks', items: [] }] }],
      ['POST', '/api/import', { data: { tasks: [] }, settings: {} }],
      ['POST', '/api/ai/mode', { mode: 'off' }],
      ['POST', '/api/ai/clients', { kind: 'other' }],
      ['POST', `/api/ai/clients/${victim.id}`, { rotate: true }],
      ['DELETE', `/api/ai/clients/${victim.id}`],
      ['POST', '/api/ai/undo', { changeId: 'chg_x' }],
      ['POST', '/api/ai/install/claude-desktop', {}],
      ['GET', '/api/nope'], ['POST', '/api/nope', {}], ['GET', '/api'], ['PUT', '/api/ops', {}], ['OPTIONS', '/api/ai'], ['HEAD', '/api/state'],
    ];
    const flipped = [...K].map((ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase())).join('');
    const wrong = [
      ['no header', {}],
      ['the header from before pairing', { 'x-ecosys': '1' }],
      ['an empty header', { 'x-ecosys': '' }],
      ['one character off', { 'x-ecosys': nearMiss(K) }],
      ['one character short', { 'x-ecosys': K.slice(0, -1) }],
      ['one character more', { 'x-ecosys': `${K}A` }],
      ['the other case', { 'x-ecosys': flipped }],
      ['sent twice', { 'x-ecosys': [K, K] }],
      ['another data folder\'s secret', { 'x-ecosys': other.secret }],
      ['a connection key instead', { 'x-ecosys': victim.token }],
      ['as a Bearer token', { authorization: `Bearer ${K}` }],
      ['as a cookie', { cookie: `ecosys=${K}; pair=${K}` }],
      ['under another header name', { 'x-ecosys-pair': K, 'x-ecosys-secret': K }],
    ];
    const before = fingerprint(s);
    let n = 0;
    for (const [label, headers] of wrong) {
      for (const [method, path, body] of routes) {
        const r = await request(s.port, { method, path, body, headers, headersOnly: path.startsWith('/api/events'), timeout: 5000 });
        const what = `${label}: ${method} ${path} -> ${r.status} ${r.text.slice(0, 80)}`;
        assert.equal(r.status, 403, what);
        assert.ok(!/event-stream/.test(r.headers['content-type'] || ''), `${what}: a stream`);
        if (method !== 'HEAD' && !path.startsWith('/api/events')) assert.deepEqual(r.json, PAIRING, what);
        assert.deepEqual(leaked(r.text, [K, victim.token]), [], what);
        n++;
      }
    }
    // In the query string or the fragment (which never reaches a server anyway) it counts for nothing.
    for (const path of [`/api/state?pair=${K}`, `/api/state?x-ecosys=${K}`, `/api/state#pair=${K}`]) assert.deepEqual((await request(s.port, { path })).json, PAIRING, path);
    assert.ok(n > 200, `${n} refused requests`);
    assert.equal(fingerprint(s), before, 'nothing changed');
    // Control: the exact secret gets every route (the stream included).
    for (const [method, path, body] of routes.filter(([m]) => m === 'GET')) {
      const r = await request(s.port, { method, path, body, headers: { 'x-ecosys': K }, headersOnly: path.startsWith('/api/events') });
      assert.notEqual(r.status, 403, `${method} ${path} with the secret -> ${r.status}`);
      if (path.startsWith('/api/events')) assert.match(r.headers['content-type'], /^text\/event-stream/);
    }
  });

  test('GET /api/hello is public: it says only whether the request was paired', async () => {
    const s = await startServer(scope);
    const keys = (r) => Object.keys(r.json || {}).sort().join(',');
    for (const [label, headers, paired] of [['no header', {}, false], ['the old header', { 'x-ecosys': '1' }, false], ['a near miss', { 'x-ecosys': nearMiss(s.secret) }, false], ['the secret', { 'x-ecosys': s.secret }, true]]) {
      const r = await request(s.port, { path: '/api/hello', headers });
      assert.equal(r.status, 200, label);
      assert.equal(keys(r), 'app,features,ok,paired,version', `${label}: nothing beyond ok, app, version, features and paired`);
      assert.deepEqual({ ok: r.json.ok, app: r.json.app, paired: r.json.paired }, { ok: true, app: 'ecosys', paired }, label);
      assert.equal(r.headers['cache-control'], 'no-store');
    }
    // Still a browser-API route: another site can't read it, and a tunnel or another device doesn't get it.
    assert.equal((await request(s.port, { path: '/api/hello', headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request(s.port, { path: '/api/hello', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await request(s.port, { path: '/api/hello', headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 404);
  });

  test('the stdio bridge\'s notify takes a connection key\'s proof, never the pairing secret', async () => {
    const s = await startServer(scope);
    const c = s.core.ai.createClient({ kind: 'claude' });
    const { notifyProof } = await import('../../server/util.mjs');
    const body = JSON.stringify({ events: [] });
    const at = String(Date.now());
    const proof = `${c.id} ${at} ${notifyProof(c.token, c.id, at, body)}`;
    const post = (headers) => request(s.port, { method: 'POST', path: '/api/internal/notify', body, headers });
    assert.equal((await post({ 'x-ecosys-proof': proof })).status, 200, 'a proof alone: the bridge never holds the pairing secret');
    assert.equal((await post({ 'x-ecosys': s.secret })).status, 401, 'the pairing secret is no notify credential');
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ 'x-ecosys-proof': proof, origin: 'https://evil.example' })).status, 403, 'and the browser checks still apply');
  });

  test('a raw TCP relay on this computer (a port forward, another account) gets nothing without the secret', async () => {
    const s = await startServer(scope);
    const key = s.core.ai.createClient({ kind: 'chatgpt' }).token;
    const relay = net.createServer((c) => {
      const up = net.connect(s.port, '127.0.0.1');
      c.pipe(up).pipe(c);
      c.on('error', () => {});
      up.on('error', () => {});
    });
    await new Promise((r) => relay.listen(0, '127.0.0.1', r));
    scope.defer(() => new Promise((r) => relay.close(() => r())));
    const before = fingerprint(s);
    const via = (opts) => rawHttp(relay.address().port, { host: `127.0.0.1:${s.port}`, ...opts, headers: [['X-Ecosys', '1'], ...(opts.headers || [])] });
    for (const target of ['/api/ai', '/api/state', '/api/ai/status']) {
      const r = await via({ target });
      assert.equal(r.status, 403, target);
      assert.deepEqual(JSON.parse(r.text), PAIRING, target);
      assert.ok(!r.text.includes(key));
    }
    assert.equal((await via({ target: '/api/events?client=x', headersOnly: true })).status, 403);
    const wipe = JSON.stringify({ client: 'x', ops: [{ op: 'replace', c: 'tasks', items: [] }] });
    assert.equal((await via({ method: 'POST', target: '/api/ops', headers: [['Content-Type', 'application/json']], body: wipe })).status, 403);
    assert.equal(JSON.parse((await via({ target: '/api/hello' })).text).paired, false);
    assert.equal(fingerprint(s), before);
  });

  test('pair.json: made on first start, kept across restarts, private to this user', async () => {
    const dir = scope.tempDir('pairfile');
    const core = await createCore({ dataDir: dir, log: silent });
    const port = await freePort();
    const app = createEcosysServer({ core, port, log: silent });
    const file = join(dir, PAIR_FILE);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(saved).sort(), ['secret', 'v']);
    assert.equal(saved.v, 1);
    assert.match(saved.secret, SECRET_RE, '32 random bytes, base64url');
    assert.equal(app.pairingUrl(`http://127.0.0.1:${port}/`), `http://127.0.0.1:${port}/#pair=${saved.secret}`);
    if (process.platform === 'win32') {
      const broad = broadAccess(dir);
      if (broad !== null) assert.deepEqual(broad, [], 'Everyone, Authenticated Users and Users cannot open the folder that holds it');
    } else assert.equal(statSync(file).mode & 0o077, 0, 'only this user can read it (0600)');
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp file left behind');
    await app.close();
    // A restart (and a second server on the same folder) keeps it; a browser stays paired.
    const core2 = await createCore({ dataDir: dir, log: silent });
    const app2 = createEcosysServer({ core: core2, port, log: silent });
    assert.equal(app2.pairingUrl('x/'), `x/#pair=${saved.secret}`);
    assert.equal(pairingSecret(dir), saved.secret);
    await app2.close();
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), saved, 'the file is unchanged');
  });

  test('a damaged pair.json is replaced with one warning that names no secret; an unreadable one stops start-up', async () => {
    for (const bad of ['not json {', '{"v":1,"secret":"short"}', '{"v":1}', '[]', '"just a string"']) {
      const dir = scope.tempDir('pairbad');
      writeFileSync(join(dir, PAIR_FILE), bad);
      const log = captureLog();
      const secret = pairingSecret(dir, { log });
      assert.match(secret, SECRET_RE, bad);
      assert.equal(JSON.parse(readFileSync(join(dir, PAIR_FILE), 'utf8')).secret, secret, 'the new one is saved');
      const warns = log.entries.filter((e) => e.level === 'warn');
      assert.equal(warns.length, 1, `${bad}: one warning (${log.text()})`);
      assert.match(warns[0].text, /pair\.json/);
      assert.deepEqual(leaked(log.text(), [secret]), [], 'the warning does not show the secret');
    }
    // Something ecosys can't read (here: a folder where the file should be) is never written over.
    const dir = scope.tempDir('pairdir');
    mkdirSync(join(dir, PAIR_FILE));
    assert.throws(() => pairingSecret(dir, { log: silent }), (err) => err.code === 'EPAIRFILE' && /pair\.json/.test(err.message));
    const core = await createCore({ dataDir: dir, log: silent });
    const appPort = await freePort();
    assert.throws(() => createEcosysServer({ core, port: appPort, log: silent }), (err) => err.code === 'EPAIRFILE');
    core.close();
    // server.mjs says so and stops (exit 1), without a stack trace.
    const port = await freePort();
    const child = spawn(process.execPath, [SERVER_ENTRY], { cwd: scope.tempDir('pairdir-cwd'), env: envWith({ PORT: String(port), HOST: '127.0.0.1', ECOSYS_DATA_DIR: dir, ECOSYS_ALLOWED_HOSTS: '' }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 1, out);
    assert.match(out, /could not read .*pair\.json/);
    assert.doesNotMatch(out, /\n\s+at /, 'no stack trace');
    assert.ok(statSync(join(dir, PAIR_FILE)).isDirectory(), 'nothing was written over it');
  });

  test('the secret never appears in a response, the event stream, the log, server.json or the other data files', async () => {
    const s = await startServer(scope, { allowedHosts: 'abc.trycloudflare.com' });
    const K = s.secret;
    const bodies = [];
    const keep = async (p) => {
      const r = await p;
      bodies.push(r.text, JSON.stringify(r.headers));
      return r;
    };
    const tab = openSse(s.port, { path: '/api/events?client=leak-tab' });
    await tab.ready;
    await tab.wait((e) => e.event === 'ai');
    const client = (await keep(api(s, 'POST', '/api/ai/clients', { kind: 'claude' }))).json.client;
    for (const [m, p, b] of [
      ['GET', '/api/hello'], ['GET', '/api/state'], ['GET', '/api/ai'], ['GET', '/api/ai/status'], ['GET', '/api/nope'], ['POST', '/api/ops', '{'],
      ['POST', '/api/ops', { client: 'leak', ops: [{ op: 'put', c: 'tasks', item: { id: 'leak1', title: 'Leak probe', createdAt: 1, updatedAt: 1 } }] }],
      ['POST', '/api/ai/mode', { mode: 'read' }], ['POST', '/api/ai/mode', { mode: 'write' }], ['POST', '/api/import', { data: {} }],
      ['POST', `/api/ai/clients/${client.id}`, { label: 'Renamed' }], ['POST', '/api/ai/undo', { changeId: 'chg_nope' }],
    ]) await keep(api(s, m, p, b));
    for (const headers of [{}, { 'x-ecosys': '1' }, { 'x-ecosys': nearMiss(K) }, { 'x-ecosys': K, origin: 'https://evil.example' }]) {
      await keep(request(s.port, { path: '/api/state', headers }));
      await keep(request(s.port, { path: '/api/hello', headers }));
    }
    await keep(request(s.port, { path: '/api/ai', host: 'abc.trycloudflare.com', headers: { 'x-ecosys': K } }));
    await keep(legacyCall(s, client.token, 'tools/call', { name: 'create_tasks', arguments: { tasks: [{ title: 'From the AI' }] } }));
    await keep(api(s, 'POST', '/api/internal/notify', { events: [] }, bearer(client.token)));
    await tab.wait((e) => e.event === 'ops');
    await sleep(200);
    tab.close();
    s.app.writeServerInfo();
    s.core.ai.flush();
    const files = {};
    const walk = (d, rel = '') => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`);
        else if (`${rel}${e.name}` !== PAIR_FILE) files[`${rel}${e.name}`] = readFileSync(join(d, e.name), 'utf8');
      }
    };
    walk(s.dataDir);
    assert.ok(files['server.json'] && files['data.json'] && files['ai.json'], Object.keys(files).join(', '));
    const haystacks = { 'API replies (bodies and headers)': bodies.join('\n'), 'the event stream': tab.state.raw, 'the server log': s.log.text(), ...files };
    for (const [where, text] of Object.entries(haystacks)) assert.deepEqual(leaked(text, [K]), [], `the pairing secret leaked into ${where}`);
    assert.ok(tab.state.raw.includes('Leak probe'), 'the stream really carried this session');
  });

  test('server.mjs: the start banner shows the pairing link once; --open opens exactly that link', async () => {
    const srv = await spawnServer(scope);
    await sleep(100);
    const out = srv.output();
    const link = `http://127.0.0.1:${srv.port}/#pair=${srv.secret}`;
    assert.ok(out.includes(`Open this link to connect a browser: ${link}`), out);
    assert.equal(out.split(srv.secret).length - 1, 1, 'the secret is printed once, in the link, and nowhere else');
    // --open, with the browser launcher swapped for a recorder (no browser starts).
    const dir = scope.tempDir('open');
    const record = join(dir, 'opened.json');
    const stub = join(dir, 'child-process-stub.mjs');
    writeFileSync(stub, `import { writeFileSync } from 'node:fs';\nexport const spawn = (cmd, args) => { writeFileSync(${JSON.stringify(record)}, JSON.stringify({ cmd, args })); return { on() { return this; }, unref() {} }; };\nexport * from 'node:child_process';\n`);
    const hook = join(dir, 'hook.mjs');
    const serverUrl = pathToFileURL(SERVER_ENTRY).href;
    writeFileSync(hook, `import { registerHooks } from 'node:module';\nregisterHooks({ resolve(spec, ctx, next) { if (spec === 'node:child_process' && ctx.parentURL === ${JSON.stringify(serverUrl)}) return { url: ${JSON.stringify(pathToFileURL(stub).href)}, shortCircuit: true }; return next(spec, ctx); } });\n`);
    const data = scope.tempDir('open-data');
    const port = await freePort();
    const child = spawn(process.execPath, ['--import', pathToFileURL(hook).href, SERVER_ENTRY, '--open'], { cwd: ROOT, env: envWith({ PORT: String(port), HOST: '127.0.0.1', ECOSYS_DATA_DIR: data, ECOSYS_ALLOWED_HOSTS: '' }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    scope.defer(() => child.exitCode === null && child.kill());
    const until = Date.now() + 15000;
    while (!existsSync(record) && Date.now() < until && child.exitCode === null) await sleep(50);
    assert.ok(existsSync(record), `--open launched nothing:\n${log}`);
    const opened = JSON.parse(readFileSync(record, 'utf8'));
    const secret = JSON.parse(readFileSync(join(data, PAIR_FILE), 'utf8')).secret;
    assert.deepEqual(opened.args, [`http://127.0.0.1:${port}/#pair=${secret}`], 'the browser is given exactly the pairing link');
    assert.equal(opened.cmd, { win32: 'explorer.exe', darwin: 'open' }[process.platform] || 'xdg-open');
    child.kill();
  });

  for (const sig of ['SIGHUP', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])]) {
    test(`${sig} (a closed terminal or console window) removes server.json and stops the server`, async () => {
      const data = scope.tempDir(`sig-${sig}`);
      const port = await freePort();
      const wrapper = join(scope.tempDir('sig-wrap'), 'run.mjs');
      // Windows has no way to send a console-close event to another process: the signal is emitted inside it.
      writeFileSync(wrapper, `import { existsSync } from 'node:fs';\nawait import(${JSON.stringify(pathToFileURL(SERVER_ENTRY).href)});\nconst t = setInterval(() => { if (existsSync(${JSON.stringify(join(data, 'server.json'))})) { clearInterval(t); process.emit(${JSON.stringify(sig)}); } }, 20);\n`);
      const child = spawn(process.execPath, [wrapper], { cwd: ROOT, env: envWith({ PORT: String(port), HOST: '127.0.0.1', ECOSYS_DATA_DIR: data, ECOSYS_ALLOWED_HOSTS: '' }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      const code = await Promise.race([new Promise((r) => child.on('exit', r)), sleep(15000).then(() => 'timeout')]);
      if (code === 'timeout') child.kill();
      assert.equal(code, 0, `the server stopped on ${sig}:\n${out}`);
      assert.ok(out.includes('ecosys is running'), out);
      assert.equal(existsSync(join(data, 'server.json')), false, 'server.json is gone');
    });
  }

  test('PORT=80: the Origins browsers send there (no port) are same-origin; another port\'s are not', async () => {
    const s = await startWrapped(scope, { appPort: 80 });
    for (const [host, origin] of [['127.0.0.1', 'http://127.0.0.1'], ['localhost', 'http://localhost'], ['[::1]', 'http://[::1]'], ['127.0.0.1:80', 'http://127.0.0.1:80']]) {
      const r = await request(s.port, { method: 'POST', path: '/api/ops', host, body: { client: 'x', ops: [] }, headers: { 'x-ecosys': s.secret, origin, 'sec-fetch-site': 'same-origin' } });
      assert.equal(r.status, 200, `Host ${host}, Origin ${origin}: ${r.text}`);
    }
    for (const origin of ['http://127.0.0.1:8080', 'https://127.0.0.1', 'http://evil.example']) {
      const r = await request(s.port, { method: 'POST', path: '/api/ops', host: '127.0.0.1', body: { client: 'x', ops: [] }, headers: { 'x-ecosys': s.secret, origin } });
      assert.equal(r.status, 403, origin);
    }
  });

  test('the bridge names changed records in its notify, never their content; the server relays them from disk', async () => {
    const got = [];
    const listener = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        got.push(b);
        res.end('{}');
      });
    });
    await new Promise((r) => listener.listen(0, '127.0.0.1', r));
    scope.defer(() => new Promise((r) => listener.close(() => r())));
    const dataDir = scope.tempDir('refs');
    const core = await createCore({ dataDir, log: silent });
    const c = core.ai.createClient({ kind: 'claude' });
    core.close();
    // A server.json left behind: a live pid (this process stands in for a reused one), a port someone else holds now.
    writeFileSync(join(dataDir, 'server.json'), JSON.stringify({ pid: process.pid, port: listener.address().port, host: '127.0.0.1', startedAt: 1, version: '0' }));
    const b = startBridge(dataDir, ['--client', c.id]);
    const call = async (id, name, args) => {
      await b.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
      return b.wait((m) => m.id === id, 15000);
    };
    await call(1, 'notes_create', { markdown: '# Results\n\nThe biopsy came back clear' });
    const made = await call(2, 'create_tasks', { tasks: [{ title: 'Call the oncologist' }] });
    const taskId = made.result.structuredContent?.tasks?.[0]?.task_id || made.result.structuredContent?.created?.[0]?.task_id;
    if (taskId) await call(3, 'update_tasks', { tasks: [{ task_id: taskId, title: 'Call Dr Patel about the scan' }] });
    await sleep(700);
    await b.end();
    await b.exited;
    assert.ok(got.length >= 2, `the listener was notified (${got.length})`);
    for (const body of got) {
      for (const secret of ['biopsy', 'Results', 'oncologist', 'Patel', 'scan']) assert.ok(!body.includes(secret), `a notify carried "${secret}": ${body.slice(0, 300)}`);
      for (const ev of JSON.parse(body).events) {
        if (ev.event === 'ops') for (const o of ev.data.ops) assert.ok((o.op === 'settings' && Object.keys(o).length === 1) || (['put', 'del'].includes(o.op) && JSON.stringify(Object.keys(o).sort()) === '["c","id","op"]'), JSON.stringify(o));
        else assert.deepEqual(Object.keys(ev.data).sort(), ['clientName', 'type'], JSON.stringify(ev));
      }
    }
    // A running server relays a named change with the record as it is on disk, also for an older bridge's
    // notify that sent records (its copy is never what browsers get).
    const s = await startServer(scope);
    const key = s.core.ai.createClient({ kind: 'claude' });
    const tab = openSse(s.port, { path: '/api/events?client=refs-tab' });
    await tab.ready;
    await tab.wait((e) => e.event === 'ai');
    const { DataStore } = await import('../../server/store.mjs');
    const other = new DataStore({ dir: s.dataDir, validators: s.core.validators, log: silent });
    const first = other.transaction((tx) => tx.put('tasks', { id: 'ref1', title: 'On disk', createdAt: 1, updatedAt: 1 }));
    await api(s, 'POST', '/api/internal/notify', { events: [{ event: 'ops', data: { rev: first.rev, ops: [{ op: 'put', c: 'tasks', id: 'ref1' }] } }] }, bearer(key.token));
    const ev1 = await tab.wait((e) => (e.event === 'ops' || e.event === 'snapshot') && e.data?.rev === first.rev);
    assert.equal(ev1.event, 'ops');
    assert.equal(ev1.data.ops[0].item.title, 'On disk', 'the record comes from disk');
    const second = other.transaction((tx) => tx.put('tasks', { id: 'ref2', title: 'Real title', createdAt: 1, updatedAt: 1 }));
    const forged = { op: 'put', c: 'tasks', item: { ...second.ops[0].item, title: 'Forged title' } };
    await api(s, 'POST', '/api/internal/notify', { events: [{ event: 'ops', data: { rev: second.rev, ops: [forged] } }] }, bearer(key.token));
    const ev2 = await tab.wait((e) => (e.event === 'ops' || e.event === 'snapshot') && e.data?.rev === second.rev);
    assert.equal(ev2.event, 'ops');
    assert.equal(ev2.data.ops[0].item.title, 'Real title', 'an older bridge\'s record is replaced by the one on disk');
    // A record the disk doesn't have (or a change it can't name) is never relayed: a snapshot instead.
    const third = other.transaction((tx) => tx.put('tasks', { id: 'ref3', title: 'Third', createdAt: 1, updatedAt: 1 }));
    await api(s, 'POST', '/api/internal/notify', { events: [{ event: 'ops', data: { rev: third.rev, ops: [{ op: 'put', c: 'tasks', id: 'notthere' }] } }] }, bearer(key.token));
    assert.equal((await tab.wait((e) => (e.event === 'ops' || e.event === 'snapshot') && e.data?.rev === third.rev)).event, 'snapshot');
    const fourth = other.transaction((tx) => tx.put('tasks', { id: 'ref4', title: 'Fourth', createdAt: 1, updatedAt: 1 }));
    await api(s, 'POST', '/api/internal/notify', { events: [{ event: 'ops', data: { rev: fourth.rev, ops: [{ op: 'other' }] } }] }, bearer(key.token));
    assert.equal((await tab.wait((e) => (e.event === 'ops' || e.event === 'snapshot') && e.data?.rev === fourth.rev)).event, 'snapshot');
    tab.close();
    assert.ok(!tab.state.raw.includes('Forged title'));
  });
});
