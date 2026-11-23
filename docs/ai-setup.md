# Connect an AI assistant to ecosys

ecosys can let an AI assistant (Claude, ChatGPT, Grok, or any app that speaks MCP, the Model Context Protocol) read and change your tasks, calendar and notes. You decide which assistants get in, whether each one may make changes, and you can switch everything off with one click.

Your data never leaves your computer unless you choose to open a tunnel (see [Assistants that run in the cloud](#assistants-that-run-in-the-cloud)). Every change an assistant makes is listed in ecosys, and recent changes can be undone.

## Contents

- [Before you start](#before-you-start)
- [Which setup do I need?](#which-setup-do-i-need)
- [Claude Desktop](#claude-desktop)
- [Claude Code](#claude-code)
- [Claude on the web or phone](#claude-on-the-web-or-phone)
- [ChatGPT](#chatgpt)
- [Grok: app, API and CLI](#grok-app-api-and-cli)
- [Other MCP apps](#other-mcp-apps)
- [Assistants that run in the cloud: tunnels](#assistants-that-run-in-the-cloud)
- [Staying safe](#staying-safe)
- [What an assistant can do](#what-an-assistant-can-do)
- [Troubleshooting](#troubleshooting)

## Before you start

1. **Run ecosys on your computer.** In the ecosys folder run `npm start` (or double-click `start.cmd` on Windows). It opens http://127.0.0.1:4300. AI connections only exist in this local version; the GitHub Pages copy of ecosys has no server, so it cannot connect to an assistant.
2. **Open Connect AI.** Click the ecosys logo menu and choose **Connect AI**.
3. **Add a connection for each assistant.** Pick the assistant and whether it **can make changes** or is **read only**. Each connection gets its own:
   - **Connection key**: a long random password. Apps that can send a header use it as `Authorization: Bearer <key>`.
   - **Secret URL**: `/s/<key>/mcp`. For apps that can only take a web address.
   - **Connection id**: a short id used by the local Claude Desktop / CLI setup.

   Give every assistant its own connection. ecosys then knows who changed what, and you can cut one off without touching the others.

The **AI access** switch at the top of Connect AI applies to all connections:

| Setting | Effect |
| --- | --- |
| On | Each connection works as you set it (changes or read only). |
| Read only | Every assistant can look, none can change anything. |
| Off | Every request is refused with "AI access is turned off in ecosys". |

## Which setup do I need?

| Assistant | Runs where | How it reaches ecosys | What you give it |
| --- | --- | --- | --- |
| Claude Desktop | your computer | starts `mcp/stdio-bridge.mjs` | one click: **Add to Claude Desktop** |
| Claude Code | your computer | command or `http://127.0.0.1:4300/mcp` | connection id, or key |
| Grok CLI (`grok`) | your computer | command or `http://127.0.0.1:4300/mcp` | connection id, or key |
| Cursor, VS Code, other local apps | your computer | command or `http://127.0.0.1:4300/mcp` | connection id, or key |
| Claude on the web, Claude mobile | Anthropic's servers | a tunnel | secret URL (or key as a header) |
| ChatGPT | OpenAI's servers | a tunnel | secret URL |
| Grok app (grok.com) | xAI's servers | a tunnel | secret URL |
| xAI API (Grok via API) | xAI's servers | a tunnel | tunnel URL plus key |

"Your computer" apps work right away. Cloud apps cannot see `127.0.0.1`, so they need a tunnel: a temporary public HTTPS address that forwards to ecosys.

## Claude Desktop

**The easy way:** in Connect AI choose **Claude**, then **Add to Claude Desktop**. ecosys adds itself to Claude Desktop's settings file (it keeps a dated `.bak` copy of the old file and leaves everything else in it alone). Then:

1. Quit Claude Desktop completely (on Windows: right-click the tray icon, Quit; on macOS: Claude menu, Quit). Closing the window is not enough.
2. Open Claude Desktop again.
3. In a chat, open the **+** menu, then **Connectors**: **ecosys** should be listed with its tools.

Claude asks before using a tool the first time; you can choose to always allow the read-only ones.

Claude Desktop starts ecosys's MCP bridge itself, so this works even when the ecosys server is not running. When it is running, open ecosys tabs update live while Claude works.

**By hand** (if the button can't find Claude Desktop): open Claude Desktop, **Settings, Developer, Edit Config**, and add an `ecosys` entry under `mcpServers` (keep anything already there):

```json
{
  "mcpServers": {
    "ecosys": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\path\\to\\ecosys\\mcp\\stdio-bridge.mjs", "--client", "<connection id>"]
    }
  }
}
```

- Use full paths. Connect AI shows the exact Node path and bridge path for your computer.
- macOS: Node is usually `/usr/local/bin/node` or `/opt/homebrew/bin/node` (apps don't see your shell's PATH).
- Settings file locations: Windows `%APPDATA%\Claude\claude_desktop_config.json`, macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Linux `~/.config/Claude/claude_desktop_config.json`. Some Microsoft Store installs read a copy under `%LOCALAPPDATA%\Packages\Claude_...\LocalCache\Roaming\Claude\`; the button updates that one too when it exists.
- Logs: `%APPDATA%\Claude\logs\mcp-server-ecosys.log` (Windows) or `~/Library/Logs/Claude/` (macOS).

## Claude Code

Pick one.

**Local command (works without the ecosys server running):**

```
claude mcp add --transport stdio --scope user ecosys -- node "C:\path\to\ecosys\mcp\stdio-bridge.mjs" --client <connection id>
```

**Over HTTP (needs the ecosys server running):**

```
claude mcp add --transport http --scope user ecosys http://127.0.0.1:4300/mcp --header "Authorization: Bearer <key>"
```

Then type `/mcp` in Claude Code to check that ecosys is connected. `--scope user` makes it available in every project; leave it out to add it to the current project only. Remove it with `claude mcp remove ecosys`.

Tip: rather than pasting the key into a shared `.mcp.json`, reference an environment variable: `"headers": {"Authorization": "Bearer ${ECOSYS_MCP_TOKEN}"}`.

## Claude on the web or phone

claude.ai, the Claude mobile apps and Claude Desktop's **custom connectors** connect from Anthropic's servers, so they need a [tunnel](#assistants-that-run-in-the-cloud).

1. Start a tunnel and note its address, for example `https://example-words.trycloudflare.com`.
2. In Claude: **Settings, Connectors, Add custom connector**.
3. Name: `ecosys`. URL: your tunnel address plus the **secret URL** from Connect AI, for example `https://example-words.trycloudflare.com/s/<key>/mcp`.
4. Authentication: **No sign-in** (the secret URL is the key). If your account offers **Request headers**, you can instead use the plain `/mcp` URL and add the header `Authorization` with the value `Bearer <key>`.

Quick tunnel addresses change every time the tunnel restarts; edit the connector's URL when that happens. Free Claude plans allow one custom connector.

## ChatGPT

ChatGPT connects from OpenAI's servers, so it needs a [tunnel](#assistants-that-run-in-the-cloud). ChatGPT cannot send a key in a header, so use the **secret URL**.

1. Start a tunnel.
2. In ChatGPT open **Settings** (or **Plugins**), then **Apps / Connectors, Advanced, Developer mode** if your plan requires it, then **Create** / **Add custom MCP server**.
3. Server URL: `https://<tunnel address>/s/<key>/mcp`. Authentication: **No authentication** (the secret URL is the key).
4. Accept the warning, create it, and enable it in a chat (type `@` or use the tools menu).

Notes:

- Availability depends on your plan. OpenAI's help pages list Business, Enterprise and Edu for full access (including changes); some plans are read only.
- ChatGPT asks before every tool that changes data. Tools marked read-only run without asking.
- ChatGPT keeps a snapshot of ecosys's tool list. After an ecosys update, use **Refresh** on the connector.

## Grok: app, API and CLI

**Grok app (grok.com):** needs a [tunnel](#assistants-that-run-in-the-cloud). Go to **grok.com/connectors, New Connector, Custom**, and enter `https://<tunnel address>/s/<key>/mcp`. Grok refuses `localhost` addresses, so a tunnel is required.

**xAI API (Responses API remote MCP):** the call comes from xAI's servers, so it needs a tunnel too:

```json
{
  "model": "<grok model>",
  "input": [{ "role": "user", "content": "What's on my calendar today?" }],
  "tools": [{
    "type": "mcp",
    "server_url": "https://<tunnel address>/mcp",
    "server_label": "ecosys",
    "authorization": "<key>",
    "allowed_tools": ["get_overview", "find_tasks", "find_events", "find_free_time"]
  }]
}
```

ecosys accepts the key with or without the `Bearer ` prefix. The API has **no approval step**: Grok can call any tool you allow without asking. Use a **read only** connection, or limit `allowed_tools`, unless you really want unattended changes.

**Grok CLI (`grok`):** runs on your computer, no tunnel needed:

```
grok mcp add ecosys -- node "C:\path\to\ecosys\mcp\stdio-bridge.mjs" --client <connection id>
```

or over HTTP (server running): `grok mcp add --transport http ecosys http://127.0.0.1:4300/mcp --header "Authorization: Bearer <key>"`. Check it with `grok mcp list`.

## Other MCP apps

Any MCP client can connect in one of two ways:

| Transport | Settings |
| --- | --- |
| Local command (stdio) | command `node`, arguments `<ecosys>/mcp/stdio-bridge.mjs --client <connection id>` (or set `ECOSYS_CLIENT=<id>`; `ECOSYS_MCP_TOKEN=<key>` also works) |
| Streamable HTTP | URL `http://127.0.0.1:4300/mcp`, header `Authorization: Bearer <key>`; or URL `http://127.0.0.1:4300/s/<key>/mcp` with no header |

ecosys speaks both the current MCP revision (2026-07-28) and older ones (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05), so older and newer clients both work. Responses are plain JSON (no streaming), which also keeps tunnels happy.

For testing, the MCP Inspector works too: `npx @modelcontextprotocol/inspector` (a developer tool; ecosys itself installs nothing).

## Assistants that run in the cloud

Cloud assistants need a public HTTPS address. A **tunnel** gives ecosys one while it runs, without opening your router.

### What a tunnel exposes

ecosys only answers the MCP endpoint (`/mcp` and `/s/<key>/mcp`) on a tunnel address. The apps, your data API and the settings are **not** reachable through it (they return "Not found"), and every MCP request still needs a valid connection key.

This also holds for a tunnel set to rewrite the Host header to `127.0.0.1` (for example cloudflared's `--http-host-header` or ngrok's `--host-header=rewrite`). Such a tunnel still marks what it relays with forwarding headers (`X-Forwarded-For`, `CF-Connecting-IP` and similar), and ecosys treats those requests as tunnel traffic: MCP only.

Use an **HTTP** tunnel like the ones below. Do not forward the port with a raw TCP tunnel (`ngrok tcp`, `ssh -R`, port forwarding on your router). Those hand ecosys connections that look exactly like this computer, so anyone who reaches the tunnel would get the full app and data API.

### 1. Start a tunnel

**Cloudflare quick tunnel** (free, no account):

```
winget install --id Cloudflare.cloudflared
cloudflared tunnel --url http://127.0.0.1:4300
```

It prints an address like `https://example-words.trycloudflare.com`. It changes every time you restart it. For a fixed address, use a named Cloudflare tunnel with your own domain (`cloudflared tunnel login`, `cloudflared tunnel create ecosys`, `cloudflared tunnel route dns ecosys mcp.example.com`, `cloudflared tunnel run --url http://127.0.0.1:4300 ecosys`).

**ngrok** (free account, one fixed address): `ngrok config add-authtoken <ngrok token>`, then `ngrok http 4300`. It prints an address like `https://your-name.ngrok-free.dev`.

### 2. Tell ecosys to accept the tunnel's address

ecosys refuses requests addressed to names it doesn't know (this blocks DNS-rebinding attacks). Restart ecosys with the tunnel's host name:

```
# PowerShell
$env:ECOSYS_ALLOWED_HOSTS = 'example-words.trycloudflare.com'; node server.mjs

# macOS / Linux / Git Bash
ECOSYS_ALLOWED_HOSTS=example-words.trycloudflare.com node server.mjs
```

- Separate several names with commas.
- A name starting with a dot allows every subdomain, for example `.trycloudflare.com` for quick tunnels whose address keeps changing. That is convenient but lets any address under that domain reach the MCP endpoint (still only with a valid key).
- Connect AI shows the resulting public URLs.

### 3. Give the assistant the public URL

Use `https://<tunnel address>/s/<key>/mcp` (secret URL) or `https://<tunnel address>/mcp` plus the `Authorization: Bearer <key>` header, as described for each assistant above.

**Stop the tunnel when you're done** (Ctrl+C in its window). The address dies with it.

## Staying safe

- **Keys are passwords.** Anyone with a connection key, or a secret URL, can use that connection. Don't paste them into chats, screenshots or shared files.
- **Secret URLs leak more easily than headers** (browser history, logs, screenshots). If one may have leaked, use **Rotate key** in Connect AI: the old key stops working at once.
- **One connection per assistant.** Remove a connection to cut that assistant off without affecting others.
- **Prefer read only** for assistants that act without asking you first (the xAI API, scheduled agents) or that you only use for questions.
- **Turn AI access Off** when you don't need it. The switch takes effect immediately for every connection.
- **Changes are undoable.** Connect AI lists each change with the assistant's name; **Undo** restores it. Assistants can also undo their own changes (`undo_change`). Items you edited again afterwards are left alone. ecosys keeps undo data for the latest 200 changes, up to 64 MB in total (the oldest go first). A single change of more than 5 MB, such as deleting a list with thousands of long tasks, is listed but cannot be undone; the assistant is told so in the reply.
- **Watch for prompt injection.** Text in tasks, events and notes is shown to the assistant as data. ecosys tells assistants never to follow instructions found there, but treat imported or shared content with care, and keep an eye on the activity list.
- **Your data stays on this computer** in the `.ecosys` folder next to ecosys (ignored by git, never served to the web). It holds your data, the connection keys, the undo history (`.ecosys/changes`) and up to 30 automatic backups (`.ecosys/backups`) taken before imports and bulk replacements.
- **Rate limit:** each connection can make 120 requests a minute; failed key guesses are throttled. Tool arguments have size limits (for example 64 characters for a date), so one oversized request cannot stall ecosys.
- **Network:** ecosys listens on `127.0.0.1` only. If you start it with `HOST=0.0.0.0` (to open the apps on your phone), the apps are visible on your network, but your data API and AI access still only answer on this computer and through allowlisted tunnels. "This computer" means the connection itself comes from this computer: another device that sends `Host: 127.0.0.1` is refused. The MCP endpoint is not offered on the network, because a key sent from another device would travel as plain HTTP; use a tunnel (HTTPS) for assistants on other machines.

## What an assistant can do

Reading (never changes anything):

| Tool | What it does |
| --- | --- |
| `get_overview` | Today or the next days: overdue tasks, events, planned tasks, free time |
| `get_context` | Date, time zone, working hours, lists, calendars, labels |
| `find_tasks` | Search tasks by text, list, label, priority, status and dates |
| `get_task` | One task with notes and steps |
| `find_events` | Events in a date range, repeating events expanded |
| `get_event` | One event or one occurrence of a repeating event |
| `find_free_time` | Open slots in working hours |
| `find_changes` | Recent changes made by assistants, with ids to undo |

Changing (only with a connection that can make changes):

| Tool | What it does |
| --- | --- |
| `create_tasks` | Add tasks (up to 50); accepts "Call mom tomorrow 6pm p1" style text |
| `update_tasks` | Change task fields, labels and steps |
| `complete_tasks` | Complete or reopen tasks; repeating tasks move to their next date |
| `create_events` | Add events, including repeating and all-day ones |
| `update_event` | Change an event, one occurrence, or this-and-following |
| `schedule_tasks` | Plan tasks into free calendar slots (shows a plan first) |
| `create_list` | Add a task list |
| `delete_items` | Delete tasks, events, single occurrences or lists |
| `undo_change` | Revert an earlier change |

The notes app adds its own note tools when it is installed.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "Unauthorized" / 401 | The key or secret URL is wrong, was rotated, or the connection was removed. Copy it again from Connect AI. |
| "Forbidden: unknown Host header" / 403 through a tunnel | Add the tunnel's host name to `ECOSYS_ALLOWED_HOSTS` and restart ecosys. |
| "Forbidden: 127.0.0.1 and localhost only answer on the computer that runs ecosys" | The request came from another device. Open the apps there by this computer's IP address (with `HOST=0.0.0.0`); connect assistants through a tunnel. |
| "Not found" through a tunnel | Only `/mcp` and `/s/<key>/mcp` work through a tunnel. Check the URL ends in `/mcp`. |
| "Not found: AI connections only answer on the computer that runs ecosys" | The assistant used this computer's network address. Use `http://127.0.0.1:4300/mcp` on this computer, or a tunnel from elsewhere. |
| "too large to undo" / "no longer kept" | Undo data is kept for recent changes only (see [Staying safe](#staying-safe)). Fix it by hand, or ask the assistant to change it back. |
| "... is too long (max N characters)" | An argument went over its size limit. Shorten it; for dates use `YYYY-MM-DD`. |
| "AI access is turned off in ecosys" | Set AI access to On (or Read only) in Connect AI. |
| "This ecosys connection is read-only" | Change the connection to **can make changes**, or set AI access back to On. |
| Claude Desktop doesn't show ecosys | Quit Claude Desktop fully and reopen it. Check `mcp-server-ecosys.log` in Claude's logs folder. Use full paths for Node and the bridge. |
| A cloud assistant stopped working after a restart | Quick tunnel addresses change. Update the URL in the assistant and in `ECOSYS_ALLOWED_HOSTS`. |
| "Rate limit" / 429 | More than 120 requests a minute from one connection. Wait a minute. |
| Times are off by hours | ecosys uses this computer's time zone. Check the clock and time zone settings of the computer running ecosys. |
| Port 4300 is busy | Another copy of ecosys is running, or start this one with `PORT=4301`. Use the matching URL in your assistant. |
