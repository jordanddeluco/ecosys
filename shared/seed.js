// First-run sample data: a short guided tour, Things-style, a believable week on the calendar and a
// few notes (notes/core/seed.js: blocks, folders, today's note, links and tags).
//
// store.js runs this on a browser's first run (seedIfEmpty: once, as one batch that is not synced) and
// for Settings > Start over with sample data (resetData). Every record goes in untouched (createdAt ===
// updatedAt, moments after the seed time), which is how sync.js tells first-run samples from the
// person's own data: a server that already has data never receives them, and they give way to its
// data on the first sync; a new server starts with them.
import { todayYmd, addDaysYmd, parseYmd } from './dates.js';
import { uid } from './store.js';
import { sampleNotesAndFolders } from '../notes/core/seed.js';

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent || '');

/**
 * A sample record as db.insert should get it: its own id, but no createdAt / updatedAt, so the store
 * stamps both with the same "now" and the record reads as an untouched sample.
 */
const untouched = ({ createdAt: _c, updatedAt: _u, ...rest }) => rest;
const records = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)).map(untouched) : []);

/**
 * The sample notes and folders, with today's note listing `task` as a checklist item. Built before
 * anything is inserted, so if they can't be built the rest of the samples still go in, without notes.
 */
function notesSamples(today, task) {
  try {
    const s = sampleNotesAndFolders(today, { task });
    return { folders: records(s?.folders), notes: records(s?.notes) };
  } catch (err) {
    console.warn('ecosys: the sample notes could not be built', err);
    return { folders: [], notes: [] };
  }
}

export function seed(db) {
  const today = todayYmd();
  const d = (n) => addDaysYmd(today, n);
  const wd = (n) => parseYmd(d(n)).getDay();
  const undoKeys = isMac() ? 'Cmd+Z' : 'Ctrl+Z';

  // One object, two views: today's note has this task as a checklist item (checking either one
  // completes both), and the task links back to that item ("From note" in Tasks).
  const reply = { id: uid(), title: 'Reply to Taylor about the venue', done: false };
  const samples = notesSamples(today, reply);
  const dayNote = samples.notes.find((n) => n?.day === today);
  const replyItem = Array.isArray(dayNote?.blocks) ? dayNote.blocks.find((b) => b?.task === reply.id) : null;
  const replySource = replyItem ? { source: { app: 'notes', noteId: dayNote.id, blockId: replyItem.id } } : {};

  const personal = db.insert('lists', { name: 'Personal', color: 'iris', order: 0 });
  const work = db.insert('lists', { name: 'Work', color: 'blue', order: 1 });
  const errands = db.insert('lists', { name: 'Errands', color: 'orange', order: 2 });

  const calPersonal = db.insert('calendars', { name: 'Personal', color: 'iris', visible: true, order: 0 });
  const calWork = db.insert('calendars', { name: 'Work', color: 'blue', visible: true, order: 1 });
  const calFamily = db.insert('calendars', { name: 'Family', color: 'green', visible: true, order: 2 });

  let order = 1;
  const task = (t) =>
    db.insert('tasks', {
      notes: '',
      listId: null,
      tags: [],
      priority: 0,
      date: null,
      time: null,
      duration: null,
      deadline: null,
      repeat: null,
      checklist: [],
      done: false,
      completedAt: null,
      order: order++,
      ...t,
    });
  const check = (...items) => items.map((title) => ({ id: uid(), title, done: false }));

  // Inbox — a short tour
  task({
    title: 'Welcome to tasks — tap the circle to complete me',
    notes: `Finished tasks tuck into "Completed" at the bottom of each list. Undo with ${undoKeys}.`,
  });
  task({
    title: 'Add a task: press Q and type "Call mom tomorrow 6pm p1 #Personal"',
    notes: 'Dates, times, lengths ("for 30m"), repeats ("every weekday"), deadlines ("by fri"), #lists, @labels and p1–p4 are understood as you type.',
  });
  task({ title: 'Star me to mark me important', notes: 'Starred tasks (priority 1) collect in Important.' });

  // Today (and one overdue, to show Reschedule)
  task({ title: 'Renew car registration', listId: errands.id, date: d(-1), priority: 2 });
  task({ title: 'Plan the week', listId: work.id, date: today, time: '09:00', duration: 30, priority: 2, tags: ['planning'] });
  task({ title: 'Pick up groceries', listId: errands.id, date: today, checklist: check('Oat milk', 'Eggs', 'Coffee beans', 'Basil') });
  task({ id: reply.id, title: reply.title, listId: personal.id, date: today, priority: 3, tags: ['email'], notes: 'Saturday works best; ask about parking.', ...replySource });
  task({ title: 'Read 20 pages', listId: personal.id, date: today, repeat: { freq: 'day', interval: 1, from: 'due' } });
  task({ title: 'Set up ecosys', listId: personal.id, date: today, done: true, completedAt: Date.now() - 3600000 });

  // Upcoming
  task({ title: 'Submit expense report', listId: work.id, date: d(2), deadline: d(4), priority: 2 });
  task({ title: 'Water the plants', listId: personal.id, date: d(3), repeat: { freq: 'week', interval: 1, days: [wd(3)], from: 'done' } });
  task({ title: 'Prepare quarterly review slides', listId: work.id, date: d(5), time: '14:00', duration: 90, tags: ['planning'] });
  task({ title: 'Return library books', listId: errands.id, date: d(8) });

  // No date yet
  task({
    title: 'Drag me onto the calendar in schedule',
    notes: 'In schedule, open the Tasks panel and drop me on the grid to block time.',
    listId: personal.id,
    duration: 45,
  });
  task({ title: 'Learn the keyboard shortcuts — press ?', listId: personal.id });
  task({ title: 'Clean up the shared drive', listId: work.id, tags: ['cleanup'] });
  task({ title: 'Plan a weekend trip', listId: personal.id });

  // Events
  const ev = (e) => db.insert('events', { location: '', notes: '', repeat: null, exdates: [], until: null, allDay: false, ...e });
  const startOfSeries = d(-((wd(0) + 6) % 7)); // this week's Monday
  ev({
    title: 'Team standup',
    calendarId: calWork.id,
    start: `${startOfSeries}T09:30`,
    end: `${startOfSeries}T09:45`,
    repeat: { freq: 'week', interval: 1, days: [1, 2, 3, 4, 5] },
    location: 'Zoom',
  });
  ev({ title: 'Lunch with Sam', calendarId: calPersonal.id, start: `${today}T12:30`, end: `${today}T13:30`, location: 'Cafe Luna' });
  ev({ title: 'Design review', calendarId: calWork.id, start: `${d(1)}T15:00`, end: `${d(1)}T16:00`, notes: 'Bring the new onboarding flow.' });
  ev({ title: '1:1 with Alex', calendarId: calWork.id, start: `${d(1)}T15:30`, end: `${d(1)}T16:00` });
  ev({
    title: 'Gym',
    calendarId: calPersonal.id,
    start: `${d(1)}T18:00`,
    end: `${d(1)}T19:15`,
    repeat: { freq: 'week', interval: 1, days: [wd(1), wd(3)] },
  });
  ev({ title: 'Dinner with Sam & Priya', calendarId: calFamily.id, start: `${d(2)}T19:00`, end: `${d(2)}T21:00`, location: 'Osteria Nove' });
  ev({ title: "Mom's birthday", calendarId: calFamily.id, allDay: true, start: d(4), end: d(4), repeat: { freq: 'year', interval: 1, monthDay: parseYmd(d(4)).getDate(), month: parseYmd(d(4)).getMonth() + 1 } });
  ev({ title: 'Offsite', calendarId: calWork.id, allDay: true, start: d(9), end: d(10), location: 'Lakeside Lodge' });
  ev({ title: 'Dentist', calendarId: calPersonal.id, start: `${d(6)}T10:00`, end: `${d(6)}T10:45`, location: 'Smile Studio' });

  // Notes: blocks JSON (notes-spec section 4). The records carry their ids, so the links between them
  // work; createdAt / updatedAt are left to db.insert. Folders first (Meetings nests in Work).
  for (const f of samples.folders) db.insert('folders', f);
  for (const n of samples.notes) db.insert('notes', n);
}
