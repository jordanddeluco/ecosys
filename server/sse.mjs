// Server-sent events for the browser sync channel (GET /api/events).
import { isId, uid } from './util.mjs';

const HEARTBEAT_MS = 25000;
const MAX_CLIENTS = 64;

export class SseHub {
  constructor() {
    this.clients = new Map(); // connection key → {id, res}
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.timer.unref?.();
  }

  /** Attach a response as an event stream. `clientId` is the browser tab's sync id. */
  attach(req, res, clientId, extraHeaders = {}) {
    if (this.clients.size >= MAX_CLIENTS) {
      // Drop the oldest connection rather than refusing the newest tab.
      const [oldestKey, oldest] = this.clients.entries().next().value;
      this.clients.delete(oldestKey);
      try {
        oldest.res.end();
      } catch {}
    }
    const id = isId(clientId) ? clientId : uid();
    const key = uid();
    res.writeHead(200, {
      ...extraHeaders,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n: connected\n\n');
    req.socket.setKeepAlive?.(true);
    req.socket.setNoDelay?.(true);
    req.socket.setTimeout?.(0);
    this.clients.set(key, { id, res });
    const drop = () => this.clients.delete(key);
    req.on('close', drop);
    res.on('error', drop);
    return { id, key };
  }

  send(key, event, data) {
    const c = this.clients.get(key);
    if (c) this.write(c, event, data);
  }

  write(c, event, data) {
    try {
      c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // the close handler removes it
    }
  }

  /** Send to every connected tab except those whose sync id equals `except`. */
  broadcast(event, data, { except = null } = {}) {
    for (const c of this.clients.values()) if (!except || c.id !== except) this.write(c, event, data);
  }

  heartbeat() {
    for (const c of this.clients.values()) {
      try {
        c.res.write(': hb\n\n');
      } catch {}
    }
  }

  get size() {
    return this.clients.size;
  }

  close() {
    clearInterval(this.timer);
    for (const c of this.clients.values()) {
      try {
        c.res.end();
      } catch {}
    }
    this.clients.clear();
  }
}
