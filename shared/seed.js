// First-run sample data: a short guided tour, Things-style, plus a believable week on the calendar.
import { todayYmd, addDaysYmd, parseYmd } from './dates.js';
import { uid } from './store.js';

export function seed(db) {
  const today = todayYmd();
  const d = (n) => addDaysYmd(today, n);
  const wd = (n) => parseYmd(d(n)).getDay();

  const personal = db.insert('lists', { name: 'Personal', color: 'iris', icon: '', order: 0 });
  const work = db.insert('lists', { name: 'Work', color: 'blue', icon: '', order: 1 });
  const errands = db.insert('lists', { name: 'Errands', color: 'orange', icon: '', order: 2 });

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
      evening: false,
      someday: false,
      repeat: null,
      checklist: [],
      done: false,
      completedAt: null,
      order: order++,
      ...t,
    });
  const check = (...items) => items.map((title) => ({ id: uid(), title, done: false }));

  // Inbox — the tour
  task({
    title: 'Welcome to tasks — tap the circle to complete me',
    notes: 'Completed tasks move to the Logbook. Press ⌘Z (Ctrl+Z) or use the toast to undo.',
  });
  task({
    title: 'Try quick add: press N and type “Call mom tomorrow 6pm #Personal !!”',
    notes: 'Dates, times, durations (“for 30m”), repeats (“every weekday”), #lists, @tags and !priority are understood as you type. Click a highlighted chip to keep that word in the title.',
  });
  task({
    title: 'Drag me onto the calendar in schedule',
    notes: 'Open schedule from the app switcher (top left). Undated tasks wait in the Tasks panel; drop one on the grid to block time for it.',
    listId: personal.id,
    duration: 45,
  });

  // Today
  task({ title: 'Plan the week', listId: work.id, date: today, time: '09:00', duration: 30, priority: 2, tags: ['planning'] });
  task({
    title: 'Pick up groceries',
    listId: errands.id,
    date: today,
    checklist: check('Oat milk', 'Eggs', 'Coffee beans', 'Basil'),
  });
  task({ title: 'Reply to Jordan about the venue', listId: personal.id, date: today, priority: 1, tags: ['email'] });
  task({ title: 'Read 20 pages', listId: personal.id, date: today, evening: true, repeat: { freq: 'day', interval: 1, from: 'due' } });

  // Upcoming
  task({ title: 'Submit expense report', listId: work.id, date: d(2), deadline: d(4), priority: 2 });
  task({ title: 'Water the plants', listId: personal.id, date: d(3), repeat: { freq: 'week', interval: 1, days: [wd(3)], from: 'done' } });
  task({ title: 'Prepare quarterly review slides', listId: work.id, date: d(5), time: '14:00', duration: 90, tags: ['planning'] });
  task({ title: 'Return library books', listId: errands.id, date: d(8) });

  // Anytime / Someday
  task({ title: 'Learn the keyboard shortcuts — press ?', listId: personal.id });
  task({ title: 'Clean up the shared drive', listId: work.id, tags: ['cleanup'] });
  task({ title: 'Plan a weekend trip', listId: personal.id, someday: true });
  task({ title: 'Learn to make sourdough', listId: personal.id, someday: true });

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
  ev({ title: "Mom's birthday", calendarId: calFamily.id, allDay: true, start: d(4), end: d(4), repeat: { freq: 'year', interval: 1, monthDay: parseYmd(d(4)).getDate() } });
  ev({ title: 'Offsite', calendarId: calWork.id, allDay: true, start: d(9), end: d(10), location: 'Lakeside Lodge' });
  ev({ title: 'Dentist', calendarId: calPersonal.id, start: `${d(6)}T10:00`, end: `${d(6)}T10:45`, location: 'Smile Studio' });
}
