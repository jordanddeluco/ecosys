// MCP over Streamable HTTP: both protocol eras, auth (bearer, bare key, secret path), read-only
// credentials, modes, header validation, rate limiting (server/mcp.mjs + server/http.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { createEcosysServer } from '../server/http.mjs';
import { MODERN, LEGACY } from '../server/mcp.mjs';

const silent = { warn() {}, error() {}, info() {}, log() {} };
const V = MODERN[0];
const META = { 'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0' } };

let port;
let core;
let app;
let dataDir;
let writer;
let reader;

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

function post(path, body, headers = {}, method = 'POST') {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const r = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(data), ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    r.on('error', reject);
    r.end(data);
  });
}
const auth = (c) => ({ authorization: `Bearer ${c.token}` });
const legacyCall = (c, method, params = {}, id = 1, extra = {}) => post('/mcp', { jsonrpc: '2.0', id, method, params }, { ...auth(c), 'mcp-protocol-version': '2025-06-18', ...extra });
const modernCall = (c, method, params = {}, id = 1, extra = {}) =>
  post('/mcp', { jsonrpc: '2.0', id, method, params: { ...params, _meta: META } }, {
    ...auth(c),
    'mcp-protocol-version': V,
    'mcp-method': method,
    ...(method === 'tools/call' ? { 'mcp-name': params.name } : {}),
    ...extra,
  });

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ecosys-mcp-'));
  core = await createCore({ dataDir, log: silent });
  port = await freePort();
  app = createEcosysServer({ core, port, log: silent });
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  core.store.applyOps([{ op: 'put', c: 'calendars', item: { id: 'cal1', name: 'Personal', color: 'iris', visible: true, order: 0, createdAt: 1, updatedAt: 1 } }]);
  writer = core.ai.createClient({ kind: 'claude' });
  reader = core.ai.createClient({ kind: 'grok', access: 'read' });
});
after(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

// ------------------------------------------------------------------ auth + transport rules

test('no credential, wrong credential: 401 with a JSON-RPC error and WWW-Authenticate', async () => {
  for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: `Bearer ${writer.token}x` }, { authorization: 'Basic abc' }]) {
    const r = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers);
    assert.equal(r.status, 401);
    assert.equal(r.json.jsonrpc, '2.0');
    assert.ok(r.json.error.code < 0);
    assert.match(r.headers['www-authenticate'], /^Bearer realm="ecosys"$/);
    assert.ok(!/resource_metadata/.test(r.headers['www-authenticate']), 'no OAuth discovery advertised');
  }
});

test('bearer, bare key and secret path all work; a wrong secret path does not', async () => {
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } };
  assert.equal((await post('/mcp', init, auth(writer))).status, 200);
  assert.equal((await post('/mcp', init, { authorization: writer.token })).status, 200);
  assert.equal((await post(`/s/${writer.token}/mcp`, init)).status, 200);
  assert.equal((await post(`/s/${writer.token.slice(0, -2)}zz/mcp`, init)).status, 401);
  assert.equal((await post('/s/short/mcp', init)).status, 401);
});

test('GET/DELETE are 405, /.well-known is 404, batches and bad JSON are 400', async () => {
  for (const m of ['GET', 'DELETE']) {
    const r = await post('/mcp', undefined, auth(writer), m);
    assert.equal(r.status, 405);
    assert.equal(r.headers.allow, 'POST');
  }
  for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server', '/.well-known/openid-configuration', '/.well-known/oauth-protected-resource/mcp']) {
    const r = await post(p, undefined, {}, 'GET');
    assert.equal(r.status, 404, p);
    assert.equal(r.headers.location, undefined, 'never redirect');
  }
  const batch = await post('/mcp', [{ jsonrpc: '2.0', id: 1, method: 'ping' }], auth(writer));
  assert.equal(batch.status, 400);
  assert.equal(batch.json.error.code, -32600);
  const bad = await post('/mcp', '{"jsonrpc":', auth(writer));
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, -32700);
  assert.equal(bad.json.id, undefined, 'no id when it cannot be read');
  const nul = await post('/mcp', { jsonrpc: '2.0', id: null, method: 'ping' }, auth(writer));
  assert.equal(nul.status, 400);
});

test('a foreign Origin is refused; no Origin (server-to-server) is fine', async () => {
  const r = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, { ...auth(writer), origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  const ok = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, { ...auth(writer), origin: `http://127.0.0.1:${port}` });
  assert.equal(ok.status, 200);
});

// ------------------------------------------------------------------ legacy era

test('legacy handshake: initialize, notifications/initialized, ping, tools/list, tools/call', async () => {
  const init = await post('/mcp', { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'openai-mcp', version: '1.0.0' } } }, auth(writer));
  assert.equal(init.status, 200);
  assert.match(init.headers['content-type'], /application\/json/);
  assert.equal(init.headers['mcp-session-id'], undefined, 'stateless: no session id');
  const r = init.json.result;
  assert.equal(r.protocolVersion, '2025-06-18');
  assert.deepEqual(r.capabilities, { tools: { listChanged: false } });
  assert.equal(r.serverInfo.name, 'ecosys');
  assert.match(r.instructions, /get_overview/);
  assert.equal(r.resultType, undefined, 'no modern fields in legacy results');
  const future = await post('/mcp', { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2099-01-01', capabilities: {} } }, auth(writer));
  assert.equal(future.json.result.protocolVersion, LEGACY[0], 'unknown version: answer with our latest legacy');
  const note = await post('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, { ...auth(writer), 'mcp-protocol-version': '2025-06-18' });
  assert.equal(note.status, 202);
  assert.equal(note.text, '');
  assert.deepEqual((await legacyCall(writer, 'ping')).json.result, {});
  const list = await legacyCall(writer, 'tools/list');
  const names = list.json.result.tools.map((t) => t.name);
  assert.ok(names.includes('create_tasks') && names.includes('get_overview'));
  assert.equal(list.json.result.ttlMs, undefined);
  for (const t of list.json.result.tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(typeof t.annotations.readOnlyHint, 'boolean');
  }
  const call = await legacyCall(writer, 'tools/call', { name: 'create_tasks', arguments: { tasks: [{ title: 'From legacy' }] } });
  assert.equal(call.json.result.isError, false);
  assert.equal(call.json.result.content[0].type, 'text');
  assert.equal(typeof call.json.result.structuredContent, 'object');
  const unknown = await legacyCall(writer, 'tools/call', { name: 'rm_rf', arguments: {} });
  assert.equal(unknown.json.error.code, -32602);
  const nf = await legacyCall(writer, 'resources/list');
  assert.equal(nf.status, 200);
  assert.equal(nf.json.error.code, -32601);
  const badVersion = await legacyCall(writer, 'ping', {}, 1, { 'mcp-protocol-version': '1999-01-01' });
  assert.equal(badVersion.status, 400);
  const noHeader = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, auth(writer));
  assert.equal(noHeader.status, 200, 'missing version header = 2025-03-26');
});

// ------------------------------------------------------------------ modern era

test('modern: server/discover with resultType, caching fields and serverInfo', async () => {
  const r = await modernCall(writer, 'server/discover');
  assert.equal(r.status, 200);
  const res = r.json.result;
  assert.equal(res.resultType, 'complete');
  assert.ok(res.supportedVersions.includes(V));
  for (const v of LEGACY.slice(0, 3)) assert.ok(res.supportedVersions.includes(v));
  assert.deepEqual(res.capabilities, { tools: { listChanged: false } });
  assert.equal(typeof res.ttlMs, 'number');
  assert.ok(['public', 'private'].includes(res.cacheScope));
  assert.equal(res._meta['io.modelcontextprotocol/serverInfo'].name, 'ecosys');
  assert.ok(res.instructions.slice(0, 512).includes('ecosys'));
});

test('modern: tools/list and tools/call (incl. base64 Mcp-Name)', async () => {
  const list = await modernCall(writer, 'tools/list');
  assert.equal(list.json.result.resultType, 'complete');
  assert.equal(typeof list.json.result.ttlMs, 'number');
  assert.equal(list.json.result.cacheScope, 'private');
  const call = await modernCall(writer, 'tools/call', { name: 'get_context', arguments: {} });
  assert.equal(call.status, 200);
  assert.equal(call.json.result.resultType, 'complete');
  assert.equal(call.json.result.isError, false);
  assert.match(call.json.result.content[0].text, /^Today is/);
  const b64 = await post(
    '/mcp',
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_context', arguments: {}, _meta: META } },
    { ...auth(writer), 'mcp-protocol-version': V, 'mcp-method': 'tools/call', 'mcp-name': `=?base64?${Buffer.from('get_context').toString('base64')}?=` },
  );
  assert.equal(b64.status, 200);
  assert.equal(b64.json.result.isError, false);
});

test('modern: header mismatches (-32020), unsupported version (-32022), missing _meta fields, unknown method (404)', async () => {
  const noHeader = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } }, { ...auth(writer), 'mcp-method': 'tools/list' });
  assert.equal(noHeader.status, 400);
  assert.equal(noHeader.json.error.code, -32020);
  const wrongMethod = await modernCall(writer, 'tools/list', {}, 1, { 'mcp-method': 'tools/call' });
  assert.equal(wrongMethod.json.error.code, -32020);
  const wrongName = await modernCall(writer, 'tools/call', { name: 'get_context', arguments: {} }, 1, { 'mcp-name': 'get_overview' });
  assert.equal(wrongName.status, 400);
  assert.equal(wrongName.json.error.code, -32020);
  const old = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '2030-01-01' } } }, {
    ...auth(writer),
    'mcp-protocol-version': '2030-01-01',
    'mcp-method': 'tools/list',
  });
  assert.equal(old.status, 400);
  assert.equal(old.json.error.code, -32022);
  assert.equal(old.json.error.data.requested, '2030-01-01');
  assert.ok(old.json.error.data.supported.includes(V));
  const { 'io.modelcontextprotocol/clientCapabilities': _drop, ...noCaps } = META;
  const missing = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: noCaps } }, { ...auth(writer), 'mcp-protocol-version': V, 'mcp-method': 'tools/list' });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, -32602);
  const nf = await modernCall(writer, 'prompts/list');
  assert.equal(nf.status, 404);
  assert.equal(nf.json.error.code, -32601);
  const cursor = await modernCall(writer, 'tools/list', { cursor: 'abc' });
  assert.equal(cursor.json.error.code, -32602);
});

// ------------------------------------------------------------------ access control

test('read-only credentials only see and can only use read tools', async () => {
  const list = await legacyCall(reader, 'tools/list');
  const tools = list.json.result.tools;
  assert.ok(tools.length >= 8);
  assert.ok(tools.every((t) => t.annotations.readOnlyHint === true), tools.map((t) => t.name).join(','));
  const w = await legacyCall(reader, 'tools/call', { name: 'create_tasks', arguments: { tasks: [{ title: 'nope' }] } });
  assert.equal(w.json.result.isError, true);
  assert.match(w.json.result.content[0].text, /read-only/);
});

test('mode read hides write tools for everyone; mode off blocks every tool call', async () => {
  core.ai.setMode('read');
  const list = await legacyCall(writer, 'tools/list');
  assert.ok(list.json.result.tools.every((t) => t.annotations.readOnlyHint));
  core.ai.setMode('off');
  const r = await legacyCall(writer, 'tools/call', { name: 'get_overview', arguments: {} });
  assert.equal(r.json.result.isError, true);
  assert.match(r.json.result.content[0].text, /AI access is turned off in ecosys/);
  core.ai.setMode('write');
});

test('a removed credential stops working at once', async () => {
  const temp = core.ai.createClient({ kind: 'other' });
  assert.equal((await legacyCall(temp, 'ping')).status, 200);
  core.ai.deleteClient(temp.id);
  assert.equal((await legacyCall(temp, 'ping')).status, 401);
});

test('connected bookkeeping: lastSeen and client name are recorded', async () => {
  const c = core.ai.createClient({ kind: 'chatgpt' });
  await post('/mcp', { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'openai-mcp', version: '1.0.0' } } }, auth(c));
  const st = core.ai.statusClients().find((x) => x.id === c.id);
  assert.equal(st.connected, true);
  assert.equal(core.ai.get(c.id).lastClientName, 'openai-mcp 1.0.0');
});

test('rate limit: 120 requests per minute per credential', async () => {
  const c = core.ai.createClient({ kind: 'other', label: 'Flood' });
  let last;
  for (let i = 0; i < 121; i++) last = await legacyCall(c, 'ping', {}, i);
  assert.equal(last.status, 429);
  assert.ok(last.headers['retry-after']);
  assert.equal((await legacyCall(writer, 'ping')).status, 200, 'other credentials are not affected');
});
