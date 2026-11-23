// ecosys local server: serves the apps, keeps your data in .ecosys/ on this computer, syncs open
// tabs live, and lets AI assistants you connect (Claude, ChatGPT, Grok, ...) work with it over MCP.
//   node server.mjs            http://127.0.0.1:4300
//   node server.mjs --open     also opens the browser (with the pairing link, so it is connected)
//   PORT=5000 node server.mjs  another port
//   HOST=0.0.0.0 node server.mjs                     also serve the apps (not your data) to your network
//   ECOSYS_ALLOWED_HOSTS=abc.trycloudflare.com ...   let a tunnel reach the MCP endpoint (only that)
//   ECOSYS_DATA_DIR=...                              keep the data somewhere else: outside this folder,
//                                                    or in one whose name starts with a dot (never served)
// A browser reaches your data only once it is paired: open the link the banner shows once in each
// browser (the secret in it lives in the data folder's pair.json; see server/http.mjs).
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { rmSync, readFileSync } from 'node:fs';
import { createCore, dataDirProblem, DEFAULT_DATA_DIR, ROOT } from './server/core.mjs';
import { createEcosysServer, parseAllowedHosts } from './server/http.mjs';

const PORT = Number(process.env.PORT) || 4300;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.ECOSYS_DATA_DIR ? resolve(process.env.ECOSYS_DATA_DIR) : DEFAULT_DATA_DIR;
const ALLOWED = parseAllowedHosts(process.env.ECOSYS_ALLOWED_HOSTS);

// A data folder the static server would serve (ai.json holds the connection keys) is refused before
// anything is written to it.
const dataProblem = dataDirProblem(DATA_DIR);
if (dataProblem) {
  console.error(dataProblem);
  process.exit(1);
}

const core = await createCore({ dataDir: DATA_DIR });
let app;
try {
  app = createEcosysServer({ core, root: ROOT, port: PORT, host: HOST, allowedHosts: ALLOWED });
} catch (err) {
  // pair.json (the browser pairing secret) could not be read: say so instead of a stack trace.
  if (err?.code !== 'EPAIRFILE') throw err;
  console.error(err.message);
  core.close();
  process.exit(1);
}

app.server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Is ecosys already running? Try PORT=4301 node server.mjs`);
    process.exit(1);
  }
  throw err;
});

app.server.listen(PORT, HOST, () => {
  app.writeServerInfo();
  const url = `http://${HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST}:${PORT}/`;
  // The only place the pairing secret is ever shown: this console, which only this user sees.
  const pairUrl = app.pairingUrl(url);
  const lines = [
    '',
    '  ecosys is running',
    '',
    `  Open this link to connect a browser: ${pairUrl}`,
    '  (once in each browser; after that the addresses below work there)',
    '',
    `  Home      ${url}`,
    `  Tasks     ${url}tasks/`,
    `  Schedule  ${url}schedule/`,
    `  Notes     ${url}notes/`,
    `  AI (MCP)  ${url}mcp   (connect from Home, Connect AI)`,
    `  Data      ${DATA_DIR}`,
  ];
  if (ALLOWED.length) lines.push(`  Tunnels   ${ALLOWED.join(', ')} (MCP only)`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    lines.push(`  Network   apps are visible on your network; your data and AI access answer only on this computer${ALLOWED.length ? ' and through the tunnels above' : ''}`);
  }
  lines.push('', '  Ctrl+C to stop', '');
  console.log(lines.join('\n'));
  if (process.argv.includes('--open')) openBrowser(pairUrl);
});

function openBrowser(url) {
  // Fixed command and a URL we built ourselves (its secret is base64url); no shell, so nothing in it
  // is ever interpreted.
  const [cmd, args] =
    process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  try {
    const info = JSON.parse(readFileSync(resolve(DATA_DIR, 'server.json'), 'utf8'));
    if (info.pid === process.pid) rmSync(resolve(DATA_DIR, 'server.json'), { force: true });
  } catch {}
  app.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// A closed terminal: SIGHUP elsewhere, and on Windows also closing the console window (start.cmd), which
// leaves a few seconds to clean up; Ctrl+Break is SIGBREAK. Without these, server.json would stay
// behind naming a port that someone else may listen on later.
process.on('SIGHUP', shutdown);
if (process.platform === 'win32') process.on('SIGBREAK', shutdown);
