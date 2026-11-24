# ecosys

A small suite of personal apps that work as one: **Tasks**, **Schedule**, **Notes**, **Photos** and a **Home** page that shows your day at a glance. It runs in any modern browser, keeps your data on your own computer, and needs nothing installed but Node.js. If you want, your own AI assistant (Claude, ChatGPT or Grok) can read and update it for you.

**Live demo:** https://jordanddeluco.github.io/ecosys/ (browser-only, see [GitHub Pages](#github-pages))

## The apps

- **Home**: a greeting, today's tasks with check circles, the rest of today's schedule with a mini calendar, a quick note box with your latest notes, and the status of your AI connections.
- **Tasks**: a to-do app in the spirit of Microsoft To Do and Todoist. Inbox, Today, Upcoming, Important and Completed, plus your own lists and labels, priorities P1 to P4, steps, deadlines and repeats.
- **Schedule**: a calendar in the spirit of Google Calendar and Apple Calendar. Day, multi-day, week, month, year and schedule views, with your tasks on the same timeline.
- **Notes**: notes in the spirit of Apple Notes, with nested coloured folders, tags, checklists, links and backlinks, daily and meeting notes, search operators, version history and Markdown export. See the [Notes guide](docs/notes.md).
- **Photos**: a photo and video library laid out like Apple Photos and Google Photos, with Years, Months, Days and All views, Memories, albums, favourites, Recently Deleted and a full-screen viewer. It can back up to **OneDrive** or **Google Drive**, into a folder of its own in your cloud, the way Samsung Gallery backs up to OneDrive. See the [Photos guide](docs/photos.md).

## How they work together

- **One object, two views.** A task with a date shows up on the calendar; give it a time and length and it becomes a time block. Check it off in either app and it's done in both. Resize the block and the task's length changes.
- **Plan your day.** In Schedule, press `I` for the Tasks panel and drag tasks onto the grid, or drag a task from a Tasks window straight into a Schedule window.
- **Events in your lists.** Today and Upcoming in Tasks show the day's events above its tasks.
- **Notes that connect.** Every day has a note that shows that day's plan, every event can have meeting notes, and checklist items can be sent to Tasks and stay linked both ways.
- **Type naturally.**
  - In Tasks (Add task, or press `Q`): `Call mom tomorrow 6pm for 20m #Personal p1 @phone`, `Pay rent every 1st`, `Renew passport by dec 15`.
  - In Schedule (Create, or press `C`): `Lunch with Sam fri 1pm at Cafe Luna #Work`, `Standup 9:30-9:45 every weekday`.
  - Recognised words are highlighted as you type. Remove a detected chip, or wrap words in "quotes", to keep them in the name.
- **One search for everything.** `Ctrl+K` (`Cmd+K` on a Mac) searches tasks, events and notes across all the apps and runs commands. The grid button switches apps, `?` shows the keyboard shortcuts, and `,` opens Settings.

## Run it on your computer

You need [Node.js](https://nodejs.org) 22 or newer. There is nothing else to install: ecosys has no dependencies.

```bash
npm start
```

This starts ecosys at http://127.0.0.1:4300 and opens your browser. On Windows you can also double-click `start.cmd`. Stop it with Ctrl+C.

| App | Address |
| --- | --- |
| Home | http://127.0.0.1:4300/ |
| Tasks | http://127.0.0.1:4300/tasks/ |
| Schedule | http://127.0.0.1:4300/schedule/ |
| Notes | http://127.0.0.1:4300/notes/ |
| Photos | http://127.0.0.1:4300/photos/ |
| AI endpoint (MCP, for AI apps rather than your browser) | http://127.0.0.1:4300/mcp |

In Chrome or Edge, use **Install app** in the address bar to give an app its own window and taskbar icon.

**Options**

| Command or setting | What it does |
| --- | --- |
| `npm start` | Start the server and open the browser |
| `npm run serve` | Start the server only (`node server.mjs`) |
| `PORT=4301 node server.mjs` | Use another port (PowerShell: `$env:PORT=4301; node server.mjs`) |
| `HOST=0.0.0.0 node server.mjs` | Also open the apps from other devices on your network (see below) |
| `ECOSYS_ALLOWED_HOSTS=<name>` | Let a tunnel reach the AI endpoint (see [AI setup](docs/ai-setup.md#assistants-that-run-in-the-cloud)) |
| `ECOSYS_DATA_DIR=<folder>` | Keep your data in another folder, outside the ecosys folder: a folder inside it is served like the apps, AI connection keys included (unless its name starts with a dot, like `.ecosys`). A relative path starts from the folder you run the command in |
| `npm run -s mcp -- --client <id>` | Run the stdio bridge for AI apps by hand. AI apps should launch `node mcp/stdio-bridge.mjs` directly, as [AI setup](docs/ai-setup.md) shows |

**On your phone, on the same Wi-Fi:** start ecosys with `HOST=0.0.0.0 node server.mjs` (PowerShell: `$env:HOST='0.0.0.0'; node server.mjs`) and open `http://<your computer's IP>:4300/` on the phone. Only the apps are served to the network: your data, the sync and AI access stay on the computer, so the phone keeps its own separate data in its browser. Move data between them with Settings → Export backup and Import backup.

## Where your data lives

**When ecosys runs on your computer,** your data is saved in the `.ecosys` folder next to the code: `.ecosys/data.json`, plus AI connection settings, undo history for AI changes and automatic backups. The folder is never served to the web and is ignored by git. Every browser you open ecosys in keeps a copy for offline use and syncs with that folder, so a change in one tab, window or browser shows up in the others within moments, and so do the changes an AI assistant makes. If the server stops, pages that are already open keep working and catch up when it is back.

The first browser that connects to a new data folder brings its data with it. Later browsers adopt the folder's data, adding anything of their own that the folder doesn't have yet.

**Without the server** (the GitHub Pages copy, or any static web host), everything stays in that one browser.

Settings → Your data has **Export backup** (a JSON file with everything), **Import backup**, **Start over with sample data** and **Erase everything**. Notes also exports to Markdown (one note, or all of them as a `.zip`).

**Photos are different:** they are too big for the shared data file, so each browser keeps its own photo library (IndexedDB), and the way to have them everywhere is Cloud backup: connect OneDrive or Google Drive and use **Restore** in another browser.

## Connect an AI assistant

ecosys can let Claude, ChatGPT, Grok or any app that speaks MCP (the Model Context Protocol) read and change your tasks, calendar and notes.

1. Run ecosys on your computer (`npm start`).
2. Open **Connect AI**: the AI tile on Home, the app menu (the app's name at the top of the sidebar) in Tasks, Schedule and Notes, Settings → AI assistants, or `Ctrl+K` and type "Connect AI".
3. Pick your assistant and follow the steps shown. A new connection is **Read & write** (the xAI API one starts **Read only**); you can switch any of them under Connections. Claude Desktop is one click (**Add to Claude Desktop**). Claude Code, Grok CLI, Cursor and other apps on your computer connect directly. Claude on the web, ChatGPT and the Grok app need a tunnel, because they connect from their companies' servers.

Each assistant gets its own key, and you can make it read-only, rotate its key or remove it at any time. One switch turns all AI access off. Every change an assistant makes appears in Connect AI with its name and can be undone. In Notes you can hide any note or folder from assistants; the [Notes guide](docs/notes.md#notes-and-ai-assistants) says what that covers.

The full guide, for each assistant and for tunnels, is [docs/ai-setup.md](docs/ai-setup.md).

## Privacy and security

- **No accounts, no tracking, no cloud.** The apps never contact another website. Your data stays in your browser and, when the server runs, in `.ecosys` on your computer.
- **The server only listens on this computer** (`127.0.0.1`) unless you choose otherwise. Your data and AI access only answer requests that really come from this computer: a host-name allowlist, a loopback-connection check and same-origin request checks block other devices, other websites and DNS-rebinding tricks.
- **AI access is opt-in and limited:** a separate random key for each assistant, read-only connections, a global Off and Read only switch, a rate limit, an activity log and undo. Through a tunnel only the AI endpoint is reachable, and only with a key. Assistants are told that the text in your tasks, events and notes is data, never instructions.
- **Hardened pages:** a strict Content-Security-Policy (no inline scripts, no outside connections), every value escaped before it is shown, and every record validated wherever it comes from: a backup, another tab, the server or an assistant. Notes are stored as structured blocks, not HTML.
- **Careful file handling:** atomic writes, a lock shared with the AI bridge, automatic backups before bulk replacements, and no hidden files, server code or dot-folders ever served.

[docs/architecture.md](docs/architecture.md#security-controls) lists every control and where it lives.

## GitHub Pages

The `main` branch is published with GitHub Pages, so the apps can be tried without installing anything. That copy has no server behind it, so:

- your data stays in that browser only (about 5 MB), with no sync between browsers or devices;
- AI connections are not available (Connect AI explains how to run ecosys locally instead);
- it is a different site from your local copy, so their data is separate (use Export and Import backup to move it);
- GitHub Pages can't send security headers, so only the page's own Content-Security-Policy applies;
- the page runs on `jordanddeluco.github.io`, an address it shares with every other GitHub Pages project of that account. Scripts on those sites can read data stored there. Use the local version for real data, or host ecosys on its own domain.

## Tests

All tests use Node's built-in test runner.

```bash
npm test                      # unit, sync, notes, server and MCP tests (a few seconds)
node --test tests/mcp/        # MCP conformance, both protocol versions, every tool
node --test tests/security/   # paths, hosts, CSRF, auth, key leaks, headers and CSP
node --test tests/fuzz/       # property and fuzz tests (FUZZ_SEED=<n> to repeat a run)
node --test tests/e2e/        # end-to-end in headless Chrome (needs Google Chrome)
```

The server, MCP and end-to-end suites start their own server on a random port with a temporary data folder, so they never touch your `.ecosys` data. See [docs/architecture.md](docs/architecture.md#tests) and [tests/e2e/README.md](tests/e2e/README.md).

## Project layout

```
index.html, home.js, home.css   Home
tasks/                          the Tasks app
schedule/                       the Schedule app
notes/                          the Notes app
photos/                         the Photos app
  lib/                          library (IndexedDB), import and EXIF, OneDrive / Google Drive backup and sign-in
  cloud-config.js               optional app registrations for cloud backup (client IDs, not secrets)
  core/                         notes data model, Markdown, search, note operations (shared with the server)
  editor/                       the rich-text editor
  export.js, history/           Markdown and .zip export and import; version history (IndexedDB)
shared/
  ui.css, icons.js, boot.js     design tokens and components, icons, theme bootstrap
  shell.js                      app shell: switcher, menus, modals, fields, toasts, Ctrl+K palette, settings
  store.js, sync.js             data store (localStorage cache) and live sync with the server
  sanitize.js                   validators and HTML sanitizer (browser and server)
  model.js, nlp.js, recur.js    tasks and events logic, natural-language parser, repeats
  ai.js                         Connect AI panel and connect animation
server.mjs, server/             the local server: static files, sync API, live updates, MCP endpoint and tools
mcp/stdio-bridge.mjs            MCP over stdio for AI apps that launch a command
docs/                           guides and design notes
tests/                          unit, server, MCP, security, fuzz and end-to-end tests
```

Adding an app:

1. Create a folder with an `index.html` that loads `../shared/boot.js` and `../shared/ui.css` and carries the same Content-Security-Policy meta tag as the others, and call `initShell({ app: 'yourapp' })`.
2. Add the app to `APPS` in `shared/shell.js`, and give it an icon in `appIcon()` (otherwise it shows the Home mark).
3. Read and write through `db` from `shared/store.js`. It only knows the six existing collections (`tasks`, `lists`, `events`, `calendars`, `notes`, `folders`): a write to any other name throws "ecosys: unknown collection". To store a new kind of record, add the collection to `COLLECTIONS` and `SCHEMAS` in `shared/sanitize.js` and to `COLLECTIONS` in `server/validate.mjs`, so the browser, the sync and the server all accept it.
4. A settings key is dropped unless it is a known one, or an app prefix (`notes`, `tasks`, `schedule`, `home`, `ai`, `ui`, `shell`) plus a capital letter, like `notesView`, holding a plain value. To give your app its own settings, add its prefix to `EXT_KEY_RE` in `shared/sanitize.js`; the browser and the server both validate with that file.

## Documentation

- [docs/notes.md](docs/notes.md): the Notes user guide (organising, shortcuts, Markdown, links, daily and meeting notes, search, export, history, AI).
- [docs/ai-setup.md](docs/ai-setup.md): connecting Claude, ChatGPT, Grok and other MCP apps, tunnels, staying safe.
- [docs/architecture.md](docs/architecture.md): modules, data model, sync protocol, server routes, MCP, security and CSP.
- [docs/research.md](docs/research.md): what was taken from which app and why, and the decisions behind each version.

**Design:** the apps borrow from the best in each category (tasks from Microsoft To Do and Todoist, the calendar from Google and Apple Calendar, notes from Apple Notes), with a visual language that blends x.com (Light, Dim and Lights out themes, accent colours, pill buttons), proton.me (violet-tinted surfaces, the app switcher) and iOS (grouped lists, segmented controls, switches, sheets). Icons, checkboxes, menus, date and time pickers and tooltips are all custom, so they look the same on every system.
