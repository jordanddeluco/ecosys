# ecosys

A small ecosystem of simple personal apps that work together. The first two:

- **tasks** — a to-do app: Inbox, Today (with This Evening), Upcoming, Anytime, Someday and Logbook, plus your own lists and tags.
- **schedule** — a calendar: day, 3-day, week, month and agenda views, with your tasks on the same timeline.

They share one local data store, so a change in one app shows up in the other instantly — even in another tab or window.

## Run it

Needs [Node.js](https://nodejs.org) 18 or newer. There is nothing to install.

```bash
npm start
```

That serves everything at http://127.0.0.1:4300 and opens your browser. On Windows you can also double-click `start.cmd`.

| App      | URL                               |
| -------- | --------------------------------- |
| Home     | http://127.0.0.1:4300/            |
| tasks    | http://127.0.0.1:4300/tasks/      |
| schedule | http://127.0.0.1:4300/schedule/   |

Tip: in Chrome or Edge, use **Install app** in the address bar on each app to get its own window and taskbar icon.

To use it from your phone on the same Wi-Fi, run `HOST=0.0.0.0 node server.mjs` (PowerShell: `$env:HOST='0.0.0.0'; node server.mjs`) and open your computer's IP on port 4300. Each browser keeps its own data — use Settings → Export / Import backup to move it.

## How the apps work together

- **One object, two views.** A task with a date shows up on the calendar; one with a time and length is a time block. Check it off in either app and it's done in both. Resize the block and the task's length changes.
- **Plan your day.** In schedule, press `i` for the Tasks panel and drag tasks onto the grid. You can also drag a task from a tasks window straight into a schedule window.
- **Events in your lists.** Today and Upcoming in tasks show your schedule's events above each day's tasks.
- **Type naturally, anywhere.**
  - In tasks: `Call mom tomorrow 6pm for 20m #Personal !! @phone`, `Pay rent every 1st`, `Renew passport by dec 15`, `Read tonight`, `Learn sourdough someday`.
  - In schedule: `Lunch with Sam fri 1pm at Cafe Luna #Work`, `Standup 9:30-9:45 every weekday`, or start with `task` to add a task: `task Buy milk tonight`.
  - Recognised words are highlighted as you type. Click a chip, or wrap words in "quotes", to keep them in the title.
- **One switcher, one ⌘K.** The grid icon (top left) switches apps. `Ctrl+K` / `⌘K` searches and runs commands. Press `?` for every keyboard shortcut.

## Design

A blend of x.com, proton.me and iOS:

- **From X:** Light, Dim and Lights out themes; a choice of accent colour; pill buttons; hairline dividers; solid toasts with Undo.
- **From Proton:** violet-tinted surfaces, the sidebar with its app switcher, and private-by-default data.
- **From iOS:** large titles, inset grouped lists, segmented controls, switches, sheets and round checkboxes that fill with the list colour.

See [docs/research.md](docs/research.md) for what was taken from which app and why.

## Project layout

```
server.mjs            zero-dependency static server (one origin = shared data)
index.html            Home: launcher + today at a glance
shared/
  ui.css              design tokens (3 themes, 7 accents) + shared components
  shell.js            theme, app switcher, toasts/undo, menus, modals, ⌘K palette, settings, date picker
  store.js            localStorage store with live cross-tab sync, export/import
  model.js            tasks & events domain logic (smart lists, repeats, time blocks, layout)
  nlp.js              natural-language parser used by both apps
  recur.js            recurrence rules
  dates.js, minical.js, icons.js, seed.js
tasks/                the tasks app
schedule/             the schedule app
tests/                parser and recurrence tests — run with `npm test`
```

Adding the next app: create a folder with an `index.html` that loads `/shared/ui.css`. Call `initShell({ app: 'yourapp' })` and read and write through `db` from `shared/store.js`. Then add it to `APPS` in `shared/shell.js` so it appears in the switcher.

## Privacy

There are no accounts, no tracking and no network calls. Your data lives in this browser's local storage on this device. Settings → Your data has Export, Import, Load sample data and Erase.
