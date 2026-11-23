// ecosys notes: sample notes and folders for a first run (wired into shared/seed.js by integration).
// Pure: returns plain records with ids so links between them work. createdAt/updatedAt are left to the
// store (db.insert sets both to "now", which is how sync recognises untouched samples); editedAt is
// staggered so the list shows Today, Yesterday and Previous 7 Days.
import { newNote, newRecordId, dailyNoteBlocks, isEmptyBlocks } from './schema.js';

const H = 3600000;

/**
 * → {folders, notes}: a pinned welcome note (checklist, marks, highlights, a note chip, a tag), a
 * Groceries checklist, today's daily note, meeting notes (not linked to any event) in a nested folder
 * and a trip-ideas list. Insert folders first, then notes (db.insert keeps the ids given here).
 * Pass `task: {id, title, done}` (a sample task due today) and today's note links a checklist item to
 * it, so checking either one completes both.
 */
export function sampleNotesAndFolders(todayYmd, { now = Date.now(), locale, task = null } = {}) {
  const folder = (name, color, parentId, order) => ({ id: newRecordId(), name, parentId, color, order, sort: null, sortDir: null, groupByDate: null, view: null, aiHidden: false });
  const work = folder('Work', 'blue', null, 0);
  const meetings = folder('Meetings', 'teal', work.id, 0);
  const personal = folder('Personal', 'orange', null, 1);

  const ids = { welcome: newRecordId(), groceries: newRecordId(), daily: newRecordId(), kickoff: newRecordId(), trip: newRecordId() };
  const B = (t, c, extra = {}) => ({ t, c: typeof c === 'string' ? (c ? [[c]] : []) : c, ...extra });
  const chip = (id, label) => [label, '', { ref: `note:${id}`, atom: 1 }];

  const note = (id, fields, ageMs) => {
    const n = { ...newNote({ ...fields, now: now - ageMs }), id };
    delete n.createdAt;
    delete n.updatedAt;
    return n;
  };

  const notes = [
    note(
      ids.welcome,
      {
        pinned: true,
        blocks: [
          B('h1', 'Welcome to Notes'),
          B('p', 'Notes saves as you type and lives right next to your tasks and calendar. A few things to try:'),
          // The checked item comes last: "Move checked items to the bottom" is on by default.
          B('check', 'Type [] and a space to start a checklist like this one', { in: 0 }),
          B('check', [['Make a word '], ['bold', 'b'], [', '], ['italic', 'i'], [' or '], ['highlighted', '', { hl: 'mint' }]], { in: 0 }),
          B('check', [['Type [[ to link another note, like '], chip(ids.groceries, 'Groceries')], { in: 0 }),
          B('check', 'Add tags like #ideas anywhere to group notes by topic', { in: 0 }),
          B('check', 'Open this note', { in: 0, ck: true }),
          B('h3', 'Good to know'),
          B('bullet', 'Every note stays on this device. To save one as a Markdown file, choose Download as Markdown in the Share menu.', { in: 0 }),
          B('bullet', [['Press '], ['/', 'c'], [' on an empty line for the block menu, or '], ['T', 'c'], [' for today\u{2019}s note.']], { in: 0 }),
          B('bullet', 'Connect Claude, ChatGPT or Grok and they can read and write your notes. Every AI edit is marked and can be undone in one step.', { in: 0 }),
          B('p', '#ecosys'),
        ],
      },
      2 * 60000,
    ),
    note(
      ids.groceries,
      {
        folderId: personal.id,
        blocks: [
          B('h1', 'Groceries'),
          B('check', 'Oat milk', { in: 0 }),
          B('check', 'Sourdough bread', { in: 0 }),
          B('check', 'From the bakery on the corner', { in: 1 }),
          B('check', 'Basil and lemons', { in: 0 }),
          B('check', 'Coffee beans', { in: 0, ck: true }),
          B('p', '#home/shopping'),
        ],
      },
      3 * H,
    ),
    note(
      ids.daily,
      {
        day: todayYmd,
        blocks: [
          dailyNoteBlocks(todayYmd, { locale })[0],
          B('p', 'What would make today a good day?'),
          task?.id ? B('check', String(task.title || 'Task'), { in: 0, task: task.id, ck: task.done === true }) : B('check', 'Reply to Taylor about the venue', { in: 0 }),
          B('check', 'Ten minutes of stretching', { in: 0, ck: true }),
          B('p', [['Shopping list: '], chip(ids.groceries, 'Groceries')]),
        ],
      },
      20 * 60000,
    ),
    note(
      ids.kickoff,
      {
        folderId: meetings.id,
        blocks: [
          B('h1', 'Project kickoff'),
          B('h3', 'Notes'),
          B('bullet', 'Goal: a public beta by the end of the quarter', { in: 0 }),
          B('bullet', [['Owners: '], ['Sam', 'b'], [' (design) and '], ['Priya', 'b'], [' (engineering)']], { in: 0 }),
          B('quote', 'Ship small, ship often.'),
          B('h3', 'Action items'),
          B('check', 'Draft the timeline', { in: 0 }),
          B('check', 'Share the design brief', { in: 0 }),
          B('p', '#work/projects'),
        ],
      },
      26 * H,
    ),
    note(
      ids.trip,
      {
        folderId: personal.id,
        blocks: [
          B('h1', 'Weekend trip ideas'),
          B('bullet', 'Lakeside cabin, two hours north', { in: 0 }),
          B('bullet', 'City break: museums and a food market', { in: 0 }),
          B('bullet', 'Coastal hike with a picnic', { in: 0 }),
          B('quote', [['Book by '], ['Thursday', 'b'], [' to get the good rates.']]),
          B('p', '#travel'),
        ],
      },
      4 * 24 * H,
    ),
  ].filter((n) => !isEmptyBlocks(n.blocks));

  return { folders: [work, meetings, personal], notes };
}
