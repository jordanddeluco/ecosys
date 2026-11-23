// QA security: who counts as "this computer".
//  - The browser API trusts any loopback TCP peer that sends a local Host and no proxy header. A raw
//    TCP forward on this computer (netsh interface portproxy, ssh -R, ngrok tcp, socat) or another
//    account on the same PC is such a peer, and gets every key and all data.
//  - On Windows the data folder (keys and data) gets whatever ACL its parent passes down; under a
//    folder like C:\projects that is "Authenticated Users: Modify".
//  - The stdio bridge sends changed records to whatever listens on the port in server.json.
//  - Smaller items: GET /api/events no longer needs its X-Ecosys exemption; PORT=80 refuses the
//    Origin browsers really send; SIGHUP (a closed console window) leaves server.json behind.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AIStore } from '../../server/ai-store.mjs';
import { createCore } from '../../server/core.mjs';
import { createScope, startServer, startWrapped, spawnServer, startBridge, api, request, rawHttp, sleep } from './_harness.js';

const T = {
  relay: 'The browser API has no credential: any loopback TCP peer (a raw TCP forward, another account on this PC) reads every key and all data',
  acl: 'On Windows the data folder inherits its parent ACL (under C:\\projects: Authenticated Users can modify, Users can read ai.json)',
  notify: 'The stdio bridge sends changed records (note text, task titles) to whatever listens on the port named in server.json',
  events: 'GET /api/events is still exempt from X-Ecosys although sync.js sends it',
  port80: 'With PORT=80 the Origin browsers send (http://127.0.0.1, no port) is refused, so sync and Connect AI fail',
  sighup: 'server.json is left behind when the console window closes (SIGHUP is not handled)',
};
const silent = { error() {}, warn() {}, info() {}, log() {} };

describe('QA security: local trust', () => {
  const scope = createScope('qa-trust');
  after(() => scope.cleanup());

  test('a loopback peer without a pairing secret cannot read keys or data, or write', { todo: T.relay }, async () => {
    const s = await startServer(scope);
    const key = (await api(s, 'POST', '/api/ai/clients', { kind: 'chatgpt' })).json.client.token;
    const relay = net.createServer((c) => {
      const up = net.connect(s.port, '127.0.0.1');
      c.pipe(up).pipe(c);
      c.on('error', () => {});
      up.on('error', () => {});
    });
    await new Promise((r) => relay.listen(0, '127.0.0.1', r));
    scope.defer(() => new Promise((r) => relay.close(() => r())));
    const port = relay.address().port;
    const host = `127.0.0.1:${s.port}`;
    const keys = await rawHttp(port, { target: '/api/ai', host, headers: [['X-Ecosys', '1']] });
    assert.ok(!keys.text.includes(key), `GET /api/ai through a TCP relay answered ${keys.status} with the connection key`);
    const state = await rawHttp(port, { target: '/api/state', host, headers: [['X-Ecosys', '1']] });
    assert.ok(state.status === 401 || state.status === 403, `GET /api/state through a TCP relay answered ${state.status}`);
    const body = JSON.stringify({ client: 'x', ops: [{ op: 'replace', c: 'tasks', items: [] }] });
    const wipe = await rawHttp(port, { method: 'POST', target: '/api/ops', host, headers: [['X-Ecosys', '1'], ['Content-Type', 'application/json']], body });
    assert.ok(wipe.status === 401 || wipe.status === 403, `POST /api/ops through a TCP relay answered ${wipe.status}`);
  });

  test('on Windows the data folder gets a private ACL, not its parent\'s', { todo: T.acl, skip: process.platform !== 'win32' && 'Windows ACLs only' }, () => {
    const dataDir = join(scope.tempDir('acl'), '.ecosys');
    new AIStore({ dir: dataDir, log: silent }).createClient({ kind: 'claude' });
    const acl = execFileSync('icacls', [dataDir], { encoding: 'utf8' });
    const inherited = acl.split(/\r?\n/).filter((l) => /\(I\)/.test(l)).map((l) => l.trim());
    assert.deepEqual(inherited, [], 'the data folder must not inherit its parent folder\'s permissions');
  });

  test('the bridge never sends note text to whatever listens on the port in server.json', { todo: T.notify }, async () => {
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
    const dataDir = scope.tempDir('notify');
    const core = await createCore({ dataDir, log: silent });
    const c = core.ai.createClient({ kind: 'claude' });
    core.close();
    // A server.json left behind: a live pid (this process stands in for a reused one) and a port
    // that someone else listens on now.
    writeFileSync(join(dataDir, 'server.json'), JSON.stringify({ pid: process.pid, port: listener.address().port, host: '127.0.0.1', startedAt: 1, version: '0.3.0' }));
    const b = startBridge(dataDir, ['--client', c.id]);
    await b.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'notes_create', arguments: { markdown: '# Results\n\nThe biopsy came back clear' } } }) + '\n');
    await b.wait((m) => m.id === 1);
    await sleep(600);
    await b.end();
    await b.exited;
    assert.ok(!got.some((x) => x.includes('biopsy')), `the listener received the note text in ${got.length} request(s)`);
  });

  test('GET /api/events needs X-Ecosys like every other browser API route', { todo: T.events }, async () => {
    const s = await startServer(scope);
    // What an old browser's <img src> sends: no Origin, no Fetch Metadata, no custom header.
    const r = await request(s.port, { path: '/api/events?client=qa', headersOnly: true, timeout: 4000 });
    assert.equal(r.status, 403);
  });

  test('PORT=80: a same-origin request with the Origin a browser sends is accepted', { todo: T.port80 }, async () => {
    const s = await startWrapped(scope, { appPort: 80 });
    for (const [host, origin] of [['127.0.0.1', 'http://127.0.0.1'], ['localhost', 'http://localhost']]) {
      const r = await request(s.port, { method: 'POST', path: '/api/ops', host, body: { client: 'x', ops: [] }, headers: { 'x-ecosys': s.secret, origin, 'sec-fetch-site': 'same-origin' } });
      assert.equal(r.status, 200, `Host ${host}, Origin ${origin}: ${r.status} ${r.text}`);
    }
  });

  test('server.json is removed when the server gets SIGHUP (a closed console window)', { todo: T.sighup, skip: process.platform === 'win32' && 'a child cannot be sent a console-close event from here' }, async () => {
    const srv = await spawnServer(scope);
    assert.ok(existsSync(join(srv.dataDir, 'server.json')));
    srv.child.kill('SIGHUP');
    await new Promise((r) => srv.child.once('exit', r));
    assert.equal(existsSync(join(srv.dataDir, 'server.json')), false);
  });
});
