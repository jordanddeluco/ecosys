# ecosys — research notes

Condensed from research into the best task apps, calendar apps, and the design languages of x.com, proton.me and Apple iOS (Nov 2026). Each item lists what was taken and where it lives in ecosys.

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
| Single-key shortcuts + ⌘K command menu + `?` cheat sheet | Linear, Todoist, Things | everywhere |
| Undo everywhere, instant local-first writes | Linear, Todoist | toasts with Undo, ⌘Z |
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
