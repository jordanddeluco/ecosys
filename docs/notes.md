# Notes: user guide

ecosys Notes is for ideas, lists, daily notes and meeting notes. It works like Apple Notes: open it and type. The first line becomes the title, and saving is automatic. It also adds what Apple and Samsung Notes users ask for: backlinks, version history, nested coloured folders whose counts include their subfolders, a tag list that stays in view, Markdown export of every note at once, and checklist items that become tasks.

Open it at http://127.0.0.1:4300/notes/ (or from the app switcher in any ecosys app).

- [Getting around](#getting-around)
- [Writing](#writing)
- [Organising notes](#organising-notes)
- [Formatting](#formatting)
- [Markdown as you type](#markdown-as-you-type)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Checklists](#checklists)
- [Links, chips and backlinks](#links-chips-and-backlinks)
- [Daily notes](#daily-notes)
- [Meeting notes](#meeting-notes)
- [Send to Tasks](#send-to-tasks)
- [Search](#search)
- [Quick Note](#quick-note)
- [Recently Deleted](#recently-deleted)
- [Version history](#version-history)
- [Export, import and print](#export-import-and-print)
- [Notes and AI assistants](#notes-and-ai-assistants)
- [Notes settings](#notes-settings)
- [Storage and limits](#storage-and-limits)

In this guide, **Ctrl** means Ctrl on Windows and Linux, and the keys for a Mac are given separately.

## Getting around

The layout follows the width of the window:

- **Wide (1100 px and more):** three columns: sidebar, note list, note.
- **Medium (700 to 1099 px):** the list and the note; the sidebar opens as a drawer (menu button, or `Ctrl+\` / `Cmd+\`).
- **Phone (under 700 px):** one screen at a time, iPhone style: Folders, then the list, then the note, with Back buttons and a bottom bar.

The sidebar, top to bottom:

| Item | What it shows |
| --- | --- |
| **All Notes** | Every note, pinned notes first |
| **Today** | Your daily notes, newest day first, starting with today's |
| **Recent AI edits** | Notes an AI assistant changed that you haven't reviewed yet (only shown when there are some) |
| **Folders** | **Notes** (the default folder) and your own folders, each with a count that includes its subfolders |
| **Tags** | Every `#tag` in your notes, always visible |
| **Recently Deleted** | Deleted notes, kept for 30 days |

**Focus mode** (`Ctrl+Shift+\` / `Shift+Cmd+\`) hides everything but the note. **Info** (I, or the note's menu) shows an outline of the note's headings (click one to jump to it), word and character counts, checklist progress, size, dates, who edited it last, its folder and tags, the event and tasks it is linked to, the Hide from AI switch and version history.

## Writing

- **New note:** N, Ctrl+Alt+N (Option+Cmd+N on a Mac), or the compose button. A note started inside a folder goes into that folder, and one started while viewing a tag gets that tag.
- **The first line is the title.** By default a new note starts with a Title line; Notes settings can make it a Heading or plain Body instead.
- **Saving is automatic,** a moment after you stop typing, and whenever you switch notes or leave the page. A note you leave empty is simply discarded.
- **Editing in two places at once is safe.** If the note changes in another tab, another browser or through an AI assistant while you are typing, the two versions are merged block by block, and the other version is also saved in [version history](#version-history).
- **Line break inside a block:** Shift+Enter. Enter starts a new block (and continues a list).
- **Find in the note:** Ctrl+F / Cmd+F. Enter or F3 goes to the next match, Shift+Enter to the previous one, Esc closes.

## Organising notes

**Folders**

- Create one with the **+** next to "Folders" in the sidebar, or with **New folder** in the command palette (Ctrl+K / Cmd+K).
- Right-click a folder (long-press on a phone) for New subfolder, Rename, Colour, Sort & view, Hide from AI and Delete folder. Folders nest up to 3 levels deep.
- Drag notes onto a folder to move them, or press M (or use **Move...** in a note's menu). Drag folders to reorder or nest them.
- Deleting a folder moves its notes, including those in subfolders, to Recently Deleted.

**Pinning:** P, the note's menu, or a right swipe on a phone. Pinned notes stay at the top.

**Tags**

- Type `#` and a word anywhere in a note: `#work`, `#recipes`. An autocomplete offers the tags you already use.
- Nest tags with a slash: `#work/clients` also shows up under `#work`.
- Tags are not case-sensitive. A tag needs at least one letter, and tags inside code or links don't count.
- Click a tag in the sidebar to see its notes. Shift-click or Ctrl-click (Cmd-click on a Mac) more tags to combine them, then choose **All** (notes with every tag) or **Any** (notes with at least one).
- Right-click a tag to rename or delete it in every note at once.

**Sorting and views:** the list's menu sorts by Date Edited, Date Created or Title, can group by date (Today, Yesterday, Previous 7 Days, Previous 30 Days, then the months of this year, then earlier years), and switches between **List** and **Gallery** (V). Each folder can keep its own choice under **Sort & view**; Notes settings set the default.

**Selecting several notes:** Ctrl-click (Cmd-click) or Shift-click in the list, or Ctrl+A / Cmd+A with the list focused. On a phone, tap **Select**. Then pin, move, tag or delete them together (the right-click menu can also hide them from AI).

**On a touch screen,** swipe a note to the right to pin it, or to the left for Move and Delete. A long swipe to the left deletes.

## Formatting

Select text to get the formatting toolbar, or use the **Aa** button. Type `/` at the start of a line (or after a space) for the slash menu.

| Block style | What it is |
| --- | --- |
| Title, Heading, Subheading | Three heading sizes |
| Body | Normal text |
| Checklist | Round check circles |
| Bulleted, Dashed, Numbered list | Three list styles; Tab and Shift+Tab indent |
| Quote | An indented quote |
| Code block | Monospaced text; Tab inserts a tab, and Ctrl+Enter (Cmd+Enter) continues below it |
| Divider | A horizontal line |

Inside text: **bold**, *italic*, underline, ~~strikethrough~~, `inline code`, web links, and highlights in five colours (purple, pink, orange, mint and blue).

The slash menu also offers **Link to note, task or event**, **Date** and **Send to Tasks**.

**Pasting** keeps headings, lists, checklists, links and basic formatting from web pages, Google Docs and Word, and turns pasted Markdown into formatting. Anything else (scripts, styles, layout) is dropped; images and files aren't supported yet. Several lines pasted into a checklist become several items. A web address pasted over selected text turns that text into a link. To paste plain text, use Ctrl+Shift+V (Option+Shift+Cmd+V on a Mac). Copying puts formatted text on the clipboard for other apps, and Markdown as the plain-text version.

## Markdown as you type

Type these at the start of a line (in a Body line, or in a list item to switch list type):

| Type | You get |
| --- | --- |
| `# ` / `## ` / `### ` | Title / Heading / Subheading |
| `* ` or `• ` | Bulleted list |
| `- ` | Dashed list |
| `1. ` or `1) ` | Numbered list (start at any number) |
| `[] `, `[ ] `, `- [ ] ` | Checklist item (`[x] ` makes it checked) |
| `> ` | Quote |
| ```` ``` ```` then Space or Enter | Code block (add a language: ```` ```js ````) |
| `---`, `***` or `___` then Space or Enter | Divider |

And around words:

| Type | You get |
| --- | --- |
| `**bold**` | bold |
| `*italic*` or `_italic_` | italic |
| `~~strike~~` | strikethrough |
| `` `code` `` | inline code |
| `==highlight==` | highlight (in the colour you used last) |

Changed your mind? Press **Backspace** right after a conversion to get the characters back. To turn these shortcuts off, use Notes settings → Markdown shortcuts.

## Keyboard shortcuts

Press `?` in Notes for the most-used shortcuts; the tables below list them all.

**In the app**

| Action | Windows and Linux | Mac |
| --- | --- | --- |
| New note | N, or Ctrl+Alt+N | N, or Option+Cmd+N |
| Today's note | T | T |
| Search notes | `/` or Ctrl+Shift+F | `/` or Option+Cmd+F |
| Next / previous note | J / K (or Down / Up) | J / K (or Down / Up) |
| Edit the note | Enter | Enter |
| Back to the list | Esc | Esc |
| Pin | P | P |
| Move to a folder | M | M |
| List or gallery | V | V |
| Info | I | I |
| Delete | Delete | Cmd+Backspace |
| Select all in the list | Ctrl+A | Cmd+A |
| Sidebar | `Ctrl+\` | `Cmd+\` |
| Focus mode | `Ctrl+Shift+\` | `Shift+Cmd+\` |
| Back / forward | Alt+Left / Alt+Right | `Option+Cmd+[` / `Option+Cmd+]` |
| Search everything, run commands | Ctrl+K | Cmd+K |
| Settings | `,` | `,` |
| Keyboard shortcuts sheet | `?` | `?` |

**While writing**

| Action | Windows and Linux | Mac |
| --- | --- | --- |
| Bold, italic, underline | Ctrl+B, Ctrl+I, Ctrl+U | Cmd+B, Cmd+I, Cmd+U |
| Strikethrough | Ctrl+Shift+X | Shift+Cmd+X |
| Inline code | Ctrl+E | Cmd+E |
| Highlight | Ctrl+Shift+H | Shift+Cmd+H |
| Link (with text selected, or the caret in a link) | Ctrl+K | Cmd+K |
| Title, Heading, Subheading | Ctrl+Alt+1, 2, 3 | Option+Cmd+1, 2, 3 |
| Body | Ctrl+Alt+0 | Option+Cmd+0 or Shift+Cmd+B |
| Checklist | Ctrl+Alt+4 or Ctrl+Shift+9 | Option+Cmd+4 or Shift+Cmd+L |
| Bulleted list | Ctrl+Alt+5 or Ctrl+Shift+8 | Option+Cmd+5 or Shift+Cmd+7 |
| Numbered list | Ctrl+Alt+6 or Ctrl+Shift+7 | Option+Cmd+6 or Shift+Cmd+9 |
| Dashed list | Ctrl+Alt+7 | Option+Cmd+7 or Shift+Cmd+8 |
| Code block | Ctrl+Alt+8 | Option+Cmd+8 or Shift+Cmd+M |
| Quote | Ctrl+Alt+9 | Option+Cmd+9 or Cmd+' |
| Check or uncheck | Ctrl+Enter | Cmd+Enter or Shift+Cmd+U |
| Indent / outdent | Tab / Shift+Tab (lists), or `Ctrl+]` / `Ctrl+[` | Tab / Shift+Tab (lists), or `Cmd+]` / `Cmd+[` |
| Move the item up / down | Alt+Shift+Up / Down | Option+Shift+Up / Down, or Ctrl+Cmd+Up / Down |
| Line break inside a block | Shift+Enter | Shift+Enter |
| Undo / redo | Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) | Cmd+Z / Shift+Cmd+Z |
| Paste as plain text | Ctrl+Shift+V | Option+Shift+Cmd+V |
| Find in the note | Ctrl+F | Cmd+F |
| Go to the formatting toolbar (text selected) | Alt+F10 | Option+F10 |
| Leave the editor | Esc | Esc |

Ctrl+K (Cmd+K) with nothing selected opens the command palette instead of the link field.

## Checklists

- Start one with `[] `, the Checklist button or the Checklist style. Click or tap a circle to check it, or press Ctrl+Enter (Cmd+Enter). Ctrl-click (Cmd-click) a circle to check or uncheck the whole list.
- Checked items move to the bottom of their list by themselves. Prefer to keep them in place? Notes settings → Sort checked items → Manually.
- Tab and Shift+Tab indent and outdent; on a touch screen, swipe an item right or left.
- To reorder, drag the handle that appears when you point at an item, or press and hold its circle on a touch screen and then drag. Alt+Shift+Up / Down (Option+Shift on a Mac) moves the item with the keyboard.
- Right-click a circle (or press and hold it without moving) for **Check All**, **Uncheck All**, **Move Checked to Bottom** (when sorting manually), **Delete Checked**, **Send to Tasks** and **Send unchecked to Tasks**.

## Links, chips and backlinks

- **Link to a note, task, event or day:** type `[[` or `>>` and start typing a name. The picker lists notes, tasks, events and dates ("fri", "dec 3"); choose one to insert a chip. If no note has that name, **New note** creates it and links to it.
- **Already typed the words?** Select them and type `[` twice. A typed `[[Title]]` can be linked with Ctrl-click (Cmd-click), which also creates the note if it doesn't exist yet.
- **Dates:** type `@` and a day ("@tomorrow", "@fri") for a date chip that opens that day's note.
- **Web links:** paste a web address, or select text and press Ctrl+K (Cmd+K).
- **Chips stay current.** A note chip shows the note's latest title. A task chip shows a check circle you can tick right there. Clicking a chip shows a small card; Ctrl-click (Cmd-click) opens the note, the task in Tasks, the event in Schedule, or the daily note straight away. Links in text open the same way, with Ctrl-click (Cmd-click), so a plain click still places the caret.
- **Backlinks:** at the bottom of a note, **Linked from N notes** lists every note that links to it.
- **Copy link** (in the Share menu, or a note's right-click menu in the list) copies a link that opens the note directly.

## Daily notes

Every day can have its own note.

- Press **T**, or click **Today** in the sidebar. The note for today is created as soon as you type in it.
- At the top, the **day header** shows that day's plan, live: events from Schedule and tasks from Tasks (overdue ones too, on today). Tick tasks off right there; click an event or a task to open it.
- Use the arrows to step to the previous or next day, or the calendar button to pick any day (days with a note are marked).
- Other ways in: Home's Notes tile ("Today's note", or "Start today's note" before it exists), the note icon Schedule shows on days that have a note, or the command palette: type "today", "tomorrow", "fri" or a date.
- Daily notes are listed under **Today** and are exported to a "Daily Notes" folder, named by date.

## Meeting notes

Any calendar event can have meeting notes.

- In Schedule, open an event and choose **Meeting notes**. Notes creates a note for that occurrence of the event, with sections for Notes and Action items. Next time the button says **Open meeting notes**.
- The note's header shows the event's title, time and place, linked back to Schedule. If the event is deleted, the notes stay.
- Notes settings → **Meeting notes go to** chooses their folder.

## Send to Tasks

Turn checklist items into real tasks, linked both ways.

1. Choose what to send:
   - right-click (or press and hold) a checklist circle and choose **Send to Tasks** or **Send unchecked to Tasks**; or
   - select the lines (or put the caret on one) and choose **+** → **Send to Tasks** in the note's toolbar; or
   - type `/` on the line and choose **Send to Tasks**.
2. Pick a list (Inbox by default) and choose **Send**. Dates and repeats in the text are understood: "Call Sam tomorrow 9am", "Water plants every friday".
3. Each line becomes a task and a checklist item linked to it. Checking the item completes the task, and completing the task in Tasks checks the item; renaming the task renames the item. (Notes catches up with changes made in Tasks whenever it is open.)

In Tasks, a task made this way shows **From note** with a link back to the exact line.

## Search

Press `/` or click the search field. Results are ranked by where the words appear (titles first) and the matches are highlighted. Accents don't matter: "cafe" finds "café".

| Type | Finds notes |
| --- | --- |
| `pasta sauce` | containing both words |
| `"pasta sauce"` | containing that exact phrase |
| `-meat`, `-"red meat"` | without the word or phrase |
| `#recipes`, `tag:recipes` | with that tag (nested tags included); `-#tag` excludes it |
| `in:Work`, `in:"Work/Clients"` | in that folder or its subfolders; `in:notes` is the default Notes folder |
| `is:pinned`, `is:daily`, `is:meeting`, `is:checklist` | that are pinned, daily notes, meeting notes, or have a checklist |
| `is:ai`, `is:hidden` | edited by an AI assistant; hidden from AI |
| `has:todo`, `has:done` | with unchecked or checked items |
| `has:link`, `has:task` | with links (to the web, or to notes, tasks, events or days); with links to tasks |
| `edited:today`, `edited:yesterday`, `edited:7d` | edited today, yesterday, in the last 7 days (also `2w`, `3m`, `1y`) |
| `edited:2026-11-20`, `created:30d` | edited on that day; created in the last 30 days |

`-is:` and `-has:` exclude, for example `-is:daily`. Combine anything: `#work has:todo edited:7d`.

- The chips under the search field add common filters with one click.
- While a folder is open, choose whether to search **All Notes** or just that folder.
- **Enter** in the search field opens the note with that exact title, or creates a new note with the words you typed.

Ctrl+K (Cmd+K) in any ecosys app also searches your notes, tasks and events together.

## Quick Note

A small sheet for jotting something down without leaving what you were doing.

- Open it from the command palette in Notes (**Quick note**), from the **Quick note** shortcut of the installed app (right-click its taskbar or dock icon), or with the address `notes/#/quick`.
- Choose **New note** or **Add to Today** (appends to today's daily note), type, then **Done**. **Open in Notes** takes you to the note.
- On Home, the Notes tile has the same idea: press **N**, type, then Enter saves a new note, Alt+Enter (Option+Enter on a Mac) adds it to today's note, and Shift+Enter starts a new line.

## Recently Deleted

- Deleting a note moves it to **Recently Deleted**, with an Undo toast. Notes are erased for good 30 days later (the list shows the days left).
- A deleted note opens read-only. **Recover** puts it back in its folder (or in Notes if that folder is gone).
- **Delete Now** erases one note, and **Delete All** empties the list. These can't be undone.

## Version history

Notes keeps earlier versions of each note in this browser, automatically:

- before the first change after five idle minutes;
- before a single change that removes a large part of the note (30%, or 2,000 characters);
- when you leave a note you edited, or switch away from the tab;
- when a change from another tab or an assistant arrives while you are editing;
- when you undo an AI edit (the AI's version is kept), and when an unreviewed AI edit is kept after 7 days (your earlier version is kept);
- before you restore an older version.

Everything from the last 24 hours is kept, then one version per day for 30 days, one per week up to 180 days and one per month after that, up to 100 versions per note.

Open it from the note's menu (**Version history**) or the Info panel. Choose a version to preview it; changed blocks are tinted. Then **Restore** (with Undo), **Restore as copy** (a new note) or **Copy as Markdown**.

Version history lives in this browser's IndexedDB. It is not part of backups and is not synced to other browsers.

## Export, import and print

Nothing is locked in.

- **One note:** the Share menu has **Download as Markdown** (`.md`), **Copy as Markdown** and **Print...**. A list row's right-click menu has **Export as Markdown**.
- **All notes:** command palette or Notes settings → **Export all notes (.zip)**. You get `ecosys-notes-<date>.zip` with one Markdown file per note (everything except Recently Deleted), in folders that match yours. Daily notes go into "Daily Notes", named `YYYY-MM-DD.md`. Each file starts with front matter: title, created, updated, tags, folder, pinned and day.
- Files are named after note titles, and links between notes are written as `[[Title]]` (and `[[YYYY-MM-DD]]` for daily notes), so they keep working in Obsidian and other Markdown apps.
- **Import:** command palette or Notes settings → **Import Markdown...**, or drag `.md` and `.txt` files onto the note list. Up to 500 files at a time; a file over 2 MB is cut short. Imported notes go into the folder you are viewing. Front matter `title`, `tags`, `pinned`, `created` and `updated` are used; `[[Title]]` links to notes you already have become links.
- **Backups:** the ecosys backup (Settings → Your data → Export backup) includes every note and folder.

How Markdown maps to notes: `#` headings, `*`, `-` and `1.` lists, `- [ ]` and `- [x]` checklists, `>` quotes, code fences, `---` dividers, `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, `==highlight==`, `<u>underline</u>` (the only HTML that is understood; any other HTML stays as plain text) and `[text](https://...)` links. Indented list items use 4 spaces per level.

## Notes and AI assistants

If you connect an AI assistant to ecosys (see [Connect an AI assistant](ai-setup.md)), it can work with your notes through 9 tools: list, search, read, see the folder and tag structure, create, append, update, move to Recently Deleted, and send checklist items to Tasks. None of them deletes a note permanently. Undo works differently: undoing the change that created a note (with Undo in Connect AI or in the toast, or by the assistant itself) removes the note outright if it hasn't changed since, while Undo on the note's "Edited by" banner moves it to Recently Deleted.

You stay in control:

- **Notes settings → AI assistants can:** Read & edit (default), Read, or Off. This applies on top of the AI access switch in Connect AI.
- **Hide from AI:** in a note's menu, the Info panel, or a folder's menu. The notes tools leave out hidden notes and everything in a hidden folder: an assistant can't find, read or change them with those tools. Notes in Recently Deleted are left out too.
- **What these two don't cover yet:** any assistant can still list the recent AI changes, whose summaries name the notes they changed, and one that may make changes can undo them. That holds even for a note you hid afterwards, and while notes access is Read or Off. Turning AI access off in Connect AI stops both.
- **Every AI edit is labelled.** An edited note shows a banner, "Edited by Claude" (or ChatGPT, Grok...), with:
  - **Review:** tints the blocks that changed;
  - **Undo:** returns to your own version from before the AI's first edit (a note the AI created goes to Recently Deleted);
  - **Keep:** accepts the changes.
- **Recent AI edits** in the sidebar lists the notes waiting for review, and search can find them with `is:ai`. An edit you don't review within 7 days is kept, and your earlier version stays in version history.
- To change what a note already says, an assistant has to name the version it read. If you edited the note since, the change is refused and it has to read the note again. (Adding to the end of a note doesn't need this.)
- Note text is passed to assistants as data, and they are told never to follow instructions found in it. Still, take care with notes you pasted from untrusted sources.

## Notes settings

Open them from the command palette (**Notes settings**).

| Setting | Choices |
| --- | --- |
| New notes start with | Title (default), Heading or Body |
| Markdown shortcuts | On (default) or off |
| Sort checked items | Automatically (default) or Manually |
| Text size | S, M (default) or L |
| Sort notes by | Date Edited (default), Date Created or Title |
| Group by date | On (default) or off |
| Show notes as | List (default) or Gallery |
| Meeting notes go to | Notes, or one of your folders |
| AI assistants can | Read & edit (default), Read or Off |

The same dialog shows how much storage your notes use, and has **Export all notes (.zip)**, **Import Markdown...** and **Empty Recently Deleted**. Appearance (theme, accent colour, reduce motion) is in the shared Settings (press `,`).

## Storage and limits

- Notes are saved in your browser, which keeps about 5 MB for all of ecosys. When the local ecosys server is running, they are also saved on your computer in `.ecosys/data.json` and synced live to every open ecosys tab and browser.
- A banner warns when storage is 80% full; export your notes or empty Recently Deleted to make room. If saving fails, your edits stay in memory and Notes keeps retrying.
- One note can hold up to 256 KB (the Info panel warns from 128 KB), 5,000 blocks and 20,000 characters per block.
- Version history uses up to 50 MB of IndexedDB in total; the oldest versions are thinned out first.
