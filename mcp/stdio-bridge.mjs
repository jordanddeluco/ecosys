#!/usr/bin/env node
// ecosys MCP server over stdio, for local AI apps that launch a command (Claude Desktop, Claude
// Code, Grok CLI, ...). It runs the same MCP handler as the HTTP server, in-process, against
// .ecosys/data.json, so it works whether or not `node server.mjs` is running. When the server is
// running, it is told about each change so open browser tabs update live.
//
//   node mcp/stdio-bridge.mjs --client <connection id>     (or ECOSYS_CLIENT=<id>)
//   node mcp/stdio-bridge.mjs --token <connection key>     (or ECOSYS_MCP_TOKEN=<key>)
//   --data <dir>  / ECOSYS_DATA_DIR    use another data folder
//
// Connection ids and keys come from ecosys, Connect AI. stdout carries only MCP messages; logs go
// to stderr. The process exits when stdin closes. A message is one line of at most MAX_LINE
// characters; a longer line is answered with one error and skipped up to its newline.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { createCore, dataDirProblem, DEFAULT_DATA_DIR } from '../server/core.mjs';
import { rpcError, ERR } from '../server/mcp.mjs';
import { safeParse, describeError, notifyProof } from '../server/util.mjs';

const MAX_LINE = 4 * 1024 * 1024;

// Nothing but protocol messages may reach stdout.
const log = {
  log: (...a) => console.error(...a),
  info: (...a) => console.error(...a),
  warn: (...a) => console.error(...a),
  error: (...a) => console.error(...a),
};
console.log = log.log;
console.info = log.info;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const dataDir = arg('data') || process.env.ECOSYS_DATA_DIR ? resolve(arg('data') || process.env.ECOSYS_DATA_DIR) : DEFAULT_DATA_DIR;
const clientId = arg('client') || process.env.ECOSYS_CLIENT || null;
const token = arg('token') || process.env.ECOSYS_MCP_TOKEN || null;

// The same rule as the server: a data folder inside the folder ecosys serves would be served to
// browsers, connection keys included (unless its name starts with a dot). Nothing is written to it.
const dataProblem = dataDirProblem(dataDir, { label: arg('data') ? '--data' : 'ECOSYS_DATA_DIR' });
if (dataProblem) {
  log.error(`ecosys: ${dataProblem}`);
  process.exit(1);
}

// ------------------------------------------------------------------ live updates to a running server
//
// After each change the bridge tells a running server (the port in server.json) which records changed,
// so open tabs update at once; the server reads the records themselves from disk. A notify never holds
// the user's data: server.json can outlive its server (a crash) and name a port someone else listens
// on by then. It never holds the browser pairing secret either: it proves a connection key instead.

let pending = [];
let inflight = Promise.resolve();

/** What a notify says about one change: which record (never what it holds), or that something else changed. */
const changeRef = (o) => {
  if (o?.op === 'put' && typeof o.item?.id === 'string') return { op: 'put', c: o.c, id: o.item.id };
  if (o?.op === 'del') return { op: 'del', c: o.c, id: o.id };
  if (o?.op === 'settings') return { op: 'settings' };
  return { op: 'other' }; // the server answers that with a full reload
};

function serverPort() {
  let info;
  try {
    info = JSON.parse(readFileSync(join(dataDir, 'server.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!Number.isInteger(info?.port) || !Number.isInteger(info?.pid)) return null;
  try {
    process.kill(info.pid, 0); // throws ESRCH when that server is gone
  } catch (err) {
    if (err.code !== 'EPERM') return null;
  }
  return info.port;
}

function flush(client) {
  if (!pending.length || !client) return;
  const events = pending;
  pending = [];
  const port = serverPort();
  if (!port) return;
  const body = JSON.stringify({ events });
  // The key itself is never sent: whatever listens on that port (normally ecosys, but server.json
  // only says which port it had) gets a proof that is useless for anything but this notify.
  const at = String(Date.now());
  const proof = `${client.id} ${at} ${notifyProof(client.token, client.id, at, body)}`;
  // Best effort: if this fails, the server's file watcher picks the change up anyway.
  inflight = inflight.then(
    () =>
      new Promise((done) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: '/api/internal/notify',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
              // Not a credential: a server from before pairing wanted it. The proof is what counts.
              'X-Ecosys': '1',
              'X-Ecosys-Proof': proof,
            },
            timeout: 1500,
          },
          (res) => {
            res.resume();
            res.on('end', done);
            res.on('error', done);
          },
        );
        req.on('timeout', () => req.destroy());
        req.on('error', done);
        req.end(body);
      }),
  );
}

// ------------------------------------------------------------------ MCP over stdio

const core = await createCore({
  dataDir,
  log,
  emit: (event, data) => {
    if (event === 'ops' && Array.isArray(data?.ops)) pending.push({ event, data: { rev: data.rev, ops: data.ops.map(changeRef) } });
    else if (event === 'ai' && data?.type === 'connected') pending.push({ event, data: { type: 'connected', clientName: data.clientName ?? null } });
  },
});

function currentClient() {
  core.ai.refresh();
  if (clientId) return core.ai.get(clientId);
  if (token) return core.ai.byToken(token);
  return null;
}

if (!currentClient()) {
  log.error(
    clientId || token
      ? `ecosys: no connection matches ${clientId ? `--client ${clientId}` : 'the given key'} in ${dataDir}. Reconnect from ecosys, Connect AI.`
      : 'ecosys: pass --client <id> (or ECOSYS_CLIENT). Get one from ecosys, Connect AI.',
  );
}

function write(msg) {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n');
  } catch {
    quit();
  }
}

// A waiting assistant hears of a tool-list change (Connect AI changed this connection's access, AI
// access or notes access) without sending anything first. The check reads only ai.json (a stat, and a
// reload when it changed), never data.json, so an idle bridge costs nothing when browsers save. It is
// [] unless the session began with initialize and its tools changed since it was last told; a
// notes-access change comes with the session's next message.
const listWatch = setInterval(() => {
  for (const m of core.mcp.notifications?.(currentClient()) || []) write(m);
}, 3000);
listWatch.unref?.();

function handleLine(line) {
  const text = line.replace(/\r$/, '');
  if (!text.trim()) return;
  let msg;
  try {
    msg = safeParse(text);
  } catch {
    return write(rpcError(null, ERR.PARSE, 'Parse error'));
  }
  const client = currentClient();
  let out;
  try {
    out = core.mcp.handle(msg, { client, transport: 'stdio' });
  } catch (err) {
    log.error(`ecosys: request failed: ${describeError(err)}`);
    if (msg && typeof msg === 'object' && 'id' in msg) write(rpcError(msg.id, ERR.INTERNAL, 'Internal error'));
    return;
  }
  for (const m of out.before || []) write(m);
  if (out.body && out.status !== 202) write(out.body);
  scheduleFlush(client);
}

// Lines that arrive together are handled together; send their events in one request.
let flushQueued = false;
function scheduleFlush(client) {
  if (flushQueued || !pending.length) return;
  flushQueued = true;
  setImmediate(() => {
    flushQueued = false;
    flush(client);
  });
}

// Framing. `buf` holds the start of the current line. Once a line grows past MAX_LINE it is
// answered with one error and everything up to its newline is dropped (`skipping`): the rest of
// that line is never read as a new message, so nothing can be smuggled in behind a long one.
let buf = '';
let skipping = false;
const tooLarge = () => write(rpcError(null, ERR.INVALID_REQUEST, `Message too large (over ${MAX_LINE} characters)`));
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  let start = 0;
  for (let nl = chunk.indexOf('\n'); nl >= 0; nl = chunk.indexOf('\n', start)) {
    if (skipping) skipping = false;
    else if (buf.length + (nl - start) > MAX_LINE) tooLarge();
    else handleLine(buf + chunk.slice(start, nl));
    buf = '';
    start = nl + 1;
  }
  if (skipping || start >= chunk.length) return;
  if (buf.length + (chunk.length - start) > MAX_LINE) {
    buf = '';
    skipping = true;
    tooLarge();
  } else buf += chunk.slice(start);
});

// Changes are on disk the moment they are made; only the activity of read calls waits (up to a
// second) to be saved, so save it before leaving.
function quit() {
  clearInterval(listWatch);
  core.close();
  process.exit(0);
}

let ending = false;
function end() {
  clearInterval(listWatch);
  if (ending) return;
  ending = true;
  if (buf.trim()) handleLine(buf);
  core.close();
  // Give the live-update ping a moment, then go.
  setImmediate(() => {
    flush(currentClient());
    Promise.race([inflight, new Promise((r) => setTimeout(r, 400))]).finally(quit);
  });
}
process.stdin.on('end', end);
process.stdin.on('close', end);
process.stdout.on('error', quit);
process.on('SIGTERM', quit);
process.on('SIGINT', quit);
