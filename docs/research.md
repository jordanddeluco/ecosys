# ecosys — research notes

Condensed from research into the best task apps, calendar apps, and the design languages of x.com, proton.me and Apple iOS (Nov 2026). Each item lists what was taken and where it lives in ecosys.

The sections are in order: the first research (v1), the [v2 redesign](#v2-redesign--what-changed-and-why), and [v3](#v3-notes-ai-over-mcp-and-a-hardening-pass): the audits, the Notes app and AI over MCP. Later versions replace some earlier choices; each section says what changed.

## Tasks — what we took

| Idea | Source | In ecosys |
|---|---|---|
| Inbox / Today / Upcoming / Anytime / Someday / Logbook smart lists | Things 3 | `tasks` sidebar, keys 1–6 |
| "This Evening" section inside Today | Things 3 | Today view, `evening` flag, "tonight" in quick add |
| Calendar events shown in Today and Upcoming | Things 3, OmniFocus Forecast | events from `schedule` appear read-only |
| Two optional dates: **when** (plan) vs **deadline** (hard) | Things, Todoist, Marvin | `date` + `deadline`; "by fri" sets a deadline |
| No overdue guilt: past "when" dates quietly roll into Today; only deadlines turn red | Things | Today view |
| Inline natural-language quick add with highlighted tokens and a one-click escape | Todoist, TickTick, Fantastical | `shared/nlp.js`, chips under the input; click a chip to keep the words |
| Repeat on a fixed schedule or after completion; late completion jumps to the next future date | Todoist `every` / `every!`, Things | repeat picker, `toggleTask()` |
| One level of checklist inside a task | Things | task inspector |
| Single-key shortcuts + Cmd/Ctrl+K command menu + `?` cheat sheet | Linear, Todoist, Things | everywhere |
| Undo everywhere, instant local-first writes | Linear, Todoist | toasts with Undo, Cmd/Ctrl+Z |
| One-click export | lesson from Microsoft To Do's shutdown | Settings → Data |
| Leave out of v1: Pomodoro, habits, kanban, AI, collaboration | anti-bloat lessons (TickTick, OmniFocus, Marvin) | — |

## Schedule — what we took

| Idea | Source | In ecosys |
|---|---|---|
| Day / N-day / Week / Month / Agenda with `d` `x` `w` `m` `a` (and `1`–`5`), `t` today, `j`/`k` next/prev | Google Calendar, Notion Calendar | view switcher + keys |
| Natural-language event entry with a live preview | Fantastical | quick add bar ("Lunch fri 1pm at Cafe Luna #Work") |
| Click or drag to create, drag to move, drag the edge to resize, 15-minute snapping, Esc cancels | Google, Notion, TickTick | time grid |
| Red "now" line, auto-scrolled into view | Apple, Google | time grid |
| Mini month that highlights the visible range | Fantastical, Apple | sidebar |
| Calendar colours with show/hide toggles | everyone | sidebar |
| Overlapping events split into columns, expanding into free space | Apple, Google | `layoutColumns()` |
| Recurring edits ask "This event / This and following / All events" | Google, Apple | event editor |
| Task panel of unscheduled tasks to drag onto the grid; dropping uses the task's duration | Amie, TickTick, Todoist, Sunsama | schedule sidebar |
| One object: the time block *is* the task — checking either completes it, resizing writes back the duration | lesson from Outlook/Todoist drift | `scheduleTask()` |
| Pick which task lists appear on the calendar (not all-or-nothing) | lesson from Apple Reminders | Settings / sidebar |
| Workload counter for the day | Sunsama, Marvin | "planned" total |
| Month view shows titles, not just dots | lesson from iOS | month view |

## Design — the blend

- **X**: three display themes (Light, Dim, Lights out) and accent choices, pill-shaped buttons and nav hovers, 15/20 body text, the frosted sticky header, hairline dividers, flat high-contrast surfaces, glow-shadow popovers, the solid toast with an inline action.
- **Proton**: violet-tinted neutrals and layered surfaces (weak/strong, elevated/lowered), the 4/8/12/16/24 radius scale, the sidebar recipe (logo + 9-dot app switcher, primary button, 36–40px items), the app-switcher grid of 52px tiles, privacy-first framing ("your data stays on this device").
- **iOS**: large titles that collapse into the header, inset grouped lists, segmented controls, switches, sheets with a grabber on small screens, round checkboxes that fill with the list colour, system status colours, translucent materials, spring motion.
- **Accent — Iris**: sits between X blue (#1D9BF0) and Proton purple (#6D4AFF). The ecosystem mark and app icons use a blue→violet gradient joining the two.

## Pitfalls we're designing against

Capture friction · overdue pile-ups and red badges on soft dates · parsers that guess silently · rituals that become chores · loose task↔event links that drift · recurrence edits that duplicate events · hidden shortcuts · notification spam · paywalled basics · vendor lock-in (so: local data, one-click export).

## v2 redesign — what changed and why

Direction: tasks should feel like **Microsoft To Do × Todoist**; schedule like **Google Calendar × Apple Calendar**, and both should be cleaner.

### tasks

| Change | Taken from |
|---|---|
| Smart lists simplified to Inbox · Today · Upcoming · Important · Completed (Anytime, Someday and This Evening removed) | To Do + Todoist |
| Inbox = every task without a list, even dated ones | Todoist's Inbox project, To Do's "Tasks" list |
| Flat rows: a priority-coloured ring, a one-line description, then the date (green today, orange tomorrow, purple this week, red overdue), with the list on the right | Todoist |
| A star on every row; starring sets priority 1 and fills Important | To Do |
| Inline composer ("Add task" → name, description, Date / Priority / List chips, parsed-token chips with ×) | Todoist quick add, To Do's "Add a task" row |
| P1–P4 (`p1`…`p4`, keys `1`–`4`) | Todoist |
| Overdue section with **Reschedule** (Today / Tomorrow / pick a date) | Todoist |
| Suggestions popover for planning the day | To Do's My Day suggestions |
| Upcoming = week strip + one section per day, each with its own "Add task" | Todoist |
| Collapsible "Completed (n)" in every list, sort menu (My order / Due date / Priority / A–Z / Created) | To Do |
| Detail pane: steps, Add to Today, due date, time block, deadline, repeat, priority, list, labels, note | To Do |
| Completion chime (Settings → Completion sound) | To Do |
| Keys: `q`/`a` add, `e`/`x` complete, `s` star, `1`–`4` priority, `v` move, `g i/t/u/s/c` go to | Todoist |
| The brand menu holds Settings, appearance, shortcuts and export, replacing the busy sidebar footer | Todoist's account menu |

### schedule

| Change | Taken from |
|---|---|
| Top bar: menu, Today, previous and next, title, search, view menu, Tasks | Google Calendar |
| Collapsible sidebar with an elevated **Create** button, mini month and "My calendars" (Tasks is listed as a calendar) | Google Calendar |
| One Create card for clicks, drags and the button. Event/Task tabs; typed dates, times, places and repeats update it live | Google's quick create + Apple's quick event |
| Day headers: weekday above a big date, today filled with the accent | Google |
| Tinted events with a colour bar; later overlapping events stack on top of earlier ones | Apple tint + Google overlap |
| Red now line with the time in the gutter | Apple / Google |
| Event card with edit, delete, duplicate and close actions, colour square, title, time, repeat, place, calendar | Google |
| Month cells with "N more" opening a day popover; click an empty cell to create | Google |
| Year view (12 mini months, busy days marked) | Apple |
| "Schedule" list view and a 4-day view (2–5 configurable) | Google |
| Tasks side panel: Add a task, "to schedule", time-blocked, no date | Google Tasks |
| Removed: the always-visible quick-add bar and the per-day load bars (clutter) | — |

## v3: Notes, AI over MCP, and a hardening pass

What the owner asked for:

1. A cleaner, simpler UI (tasks like Microsoft To Do and Todoist, the calendar like Google and Apple Calendar, the look of x.com, proton.me and iOS).
2. Custom icons and controls that match the UI, instead of emoji, Unicode symbols and the operating system's own controls.
3. Everything connected, working well and secure.
4. A place to plug in an AI (Claude, ChatGPT, Grok) that can read and write tasks, the calendar and notes, with a connect animation.
5. A Home page like proton.me and iCloud.com.
6. A notes app as good as Apple Notes and Samsung Notes.

### The audits

Before any building, v2 was audited three ways, and every finding was checked against the code.

| Audit | Findings | Main themes |
| --- | --- | --- |
| Security and integration | 40 confirmed: 10 security (3 medium, 7 low) and 30 integration (15 medium, 15 low) | Stored XSS from ids and numbers written into HTML attributes unescaped; backups imported without any validation; the dev server's dotfile filter bypassed on Windows (backslashes, 8.3 short names) so `.git` could be read; no Content-Security-Policy or security headers; an open redirect; no Host check (DNS rebinding); a GitHub Pages origin shared with other sites. Integration bugs included events an hour off on DST days, repeat edits that left exdates behind, undo that restored a whole collection and wiped other tabs' changes, shortcuts that never fired, Cmd/Ctrl+K that didn't search across apps, modals without a focus trap, undo that survived Erase, and a blank page when localStorage is blocked |
| Design | 68 critiques: Tasks 19, Schedule 25, shell and Home 24 | The same information shown twice, too many colours, borders and section labels, a quick-create card cut off at its edges, the Tasks panel open by default, and a Home page full of onboarding copy |
| Glyphs and native controls | 56 items: 16 Unicode symbols, 16 native controls, 12 system-UI elements, 2 emoji, 2 font issues, 8 others | Command and arrow characters as key caps, symbol characters as icons, native `select`, date, time, checkbox and `datalist` controls, and native `title` tooltips |

### What changed because of them

- **Security:** every interpolated value is escaped; one validator module (`shared/sanitize.js`) checks every record wherever it enters; every page has a strict CSP, which meant moving the theme bootstrap into `shared/boot.js` and Home's inline code into `home.js`; the static server was rewritten to refuse dotfiles, short names, NTFS streams, malformed encoding and protocol-relative redirects, and sends security headers; a Host allowlist plus a loopback-connection check stops DNS rebinding and other devices. GitHub Pages remains a shared origin: the README says so and recommends the local version for real data.
- **Integration:** each confirmed bug went to the owner of its file together with its fix. The fixes in shared code have regression tests: DST-safe event layout, repeating tasks (including ones without a date), tasks whose list was deleted, the old `someday` flag, blocked storage and sync merges. The palette now searches tasks, events and notes from any app; modals trap focus and make the page behind them inert; undo history is cleared whenever data is replaced; and the store falls back to memory when storage is blocked.
- **Design:** the critiques set the direction for the rebuild: quieter screens with one accent colour, fewer borders and no repeated information. The quick-create card now fits its popover, and the Tasks panel starts closed unless you left it open. Home became a dashboard of live tiles (iCloud.com's airy light, proton.me's deep violet glow) with no marketing copy.
- **Glyphs:** custom components replace the native controls and symbol characters: keycaps drawn with SVG key glyphs (`keys('mod K')`), `data-tip` tooltips with key hints, select, time, date, checkbox and switch fields, an autocomplete popover, a focus-ring system and custom drag chips. The apps no longer use a native `select`, date, time or checkbox input, a `datalist` or a `title` tooltip.

### Notes: from research to decisions

Four reports fed one product spec: Apple Notes and Samsung Notes; editor-first and knowledge apps (Bear, Craft, UpNote, Notion, Obsidian); capture and organisation apps (Google Keep, OneNote, Evernote, Simplenote, Standard Notes and Proton, Joplin, Drafts) and why people abandon notes apps; and how to build a secure rich-text editor in vanilla JS.

| Decision | Why |
| --- | --- |
| Keep Apple Notes' instant capture, first line as the title, and its checklists | They are what people love about it |
| Add what Apple and Samsung users ask for: backlinks, version history, nested coloured folders whose counts add up, a tag browser that stays visible, Markdown export of every note in one click | The top complaints in the reviews and forums (Apple Notes could only export PDF until iOS 26 added Markdown) |
| Store notes as **blocks JSON**; Markdown only for exchange (export, import, copy, MCP); HTML only on the clipboard | Stable block ids make task links, `#/b/<id>` deep links and AI block edits possible; it renders without parsing HTML, so it is safe from XSS by construction; it validates without dependencies in the browser and in Node. Lock-in is avoided because every note exports to Markdown. (The editor report won this over two reports that preferred storing Markdown) |
| One `contenteditable` host rendered from the blocks model; plain typing is left to the browser and read back, structure changes go through `beforeinput` | Keeps IME, autocorrect and dictation working. One host per block breaks selection across blocks, and EditContext isn't available in every browser |
| Markdown shortcuts as you type, Backspace to undo a conversion, and a switch to turn them off | Fast for keyboard users, and it fixes Apple's "can't turn off automatic lists" |
| Settled conflicts: `[[` and `>>` open one link picker; `>` is a quote; `[]`, `[ ]`, `- [ ]` and `[x]` all make checklist items; `~~` strikes through and `==` highlights; checked items turn grey rather than struck through; Cmd/Ctrl+K links when text is selected, otherwise it opens the palette; block styles on Mod+Alt+digit everywhere, plus Apple's shortcuts on a Mac and Google Docs' on Windows | Where the reports disagreed |
| Folders (one per note) plus tags; no archive; a fixed 30-day Recently Deleted | Simple organisation without the overhead of filing |
| Version history in IndexedDB | It must not eat into the ~5 MB of localStorage that the notes themselves need |
| Daily notes with a live day header, meeting notes from calendar events, two-way Send to Tasks | The ecosys difference, and cheap because every app shares one store |
| No built-in AI: the user's own assistant connects over MCP. Every AI edit is labelled, can be reviewed and undone in one step, and notes or folders can be hidden from AI | No API keys live in the app; Samsung's Copy / Replace / Add pattern maps to create versus update plus Undo |
| Left out on purpose: databases, plugins, handwriting, collaboration, graph view, covers | The bloat lessons of Notion, Obsidian and Craft |
| Later: note locking (Web Crypto), images and attachments, collapsible headings, section links, smart folders, templates, tables, math, callouts | Each needs more care than a first version allows |

The spec also planned to give each note its own localStorage key. For now notes live in one collection like the rest of the data; sync already sends only the note that changed.

### AI over MCP: from research to decisions

Three reports covered the MCP specification as of November 2026, how each assistant connects (Claude Desktop, Claude Code, claude.ai, ChatGPT, Grok and the xAI API, tunnels), and tool design lessons from existing servers (Todoist, Google Calendar, Microsoft, TickTick, Apple Reminders).

| Decision | Why |
| --- | --- |
| A **dual-era** server: the stateless 2026-07-28 revision (`server/discover`, `_meta` on every request, `resultType`, `ttlMs` and `cacheScope`, the `Mcp-Method` and `Mcp-Name` headers) and the older `initialize` handshake (2025-11-25 back to 2024-11-05) on the same endpoint | Clients are mid-migration: newer ones probe the modern revision and fall back, others still send `initialize` |
| Streamable HTTP with plain JSON responses only, never a stream, plus a stdio bridge | Simple, and works through tunnels; Claude Desktop, Claude Code and Grok CLI can launch a local command instead |
| A static key per assistant (`Authorization: Bearer`), plus a secret URL `/s/<key>/mcp` | No OAuth server needed; ChatGPT and the Grok app can't send custom headers |
| The tool list depends on the key: a read-only key sees only read tools | The spec lets `tools/list` vary by authorization |
| 17 task and calendar tools and 9 notes tools: snake_case names, batch tools that take arrays, dates and repeats in plain words, a compact text answer plus `structuredContent`, errors that say how to fix the call and include today's date and time zone | What assistants use most: an overview, search, create, complete, free time |
| Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint: false`) | Clients use them to decide when to ask the user first |
| Every write is one transaction with an undo record, an activity entry and a live update in open apps; an `undo_change` tool; `schedule_tasks` plans first (`dry_run`) | The safety net that makes AI writes acceptable |
| Notes tools speak Markdown, `notes_update` needs the note's `rev`, no notes tool deletes permanently, and the user's pre-AI copy is kept for one-step undo | An assistant can never silently overwrite an edit it hasn't seen |
| The server instructions, and the descriptions of the notes tools that carry note text, say that user data is never instructions; `notes_read` fences note content | Prompt injection through notes, titles or locations |
| Tunnels can reach only the MCP endpoint, and only for host names in `ECOSYS_ALLOWED_HOSTS` | Cloud assistants can connect without exposing the apps or the data API, and DNS rebinding stays blocked |
| A connect animation in every open app when an assistant connects, and a toast with Undo when it changes something | The owner asked for it, and it makes AI activity visible |

How it is built: [architecture.md](architecture.md#mcp-ai-assistants). How to connect each assistant: [ai-setup.md](ai-setup.md). How the notes features work: [notes.md](notes.md).
