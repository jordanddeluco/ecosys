// QA fix (model, completeness finding): there were no reminders or event alerts anywhere, which the apps
// the owner named as the bar treat as core (Microsoft To Do's "Remind me", Todoist reminders, Apple and
// Google Calendar alerts). The model now has them: task.reminder ('YYYY-MM-DDTHH:MM') and event.alerts
// (minutes before the start), their choices and labels, a repeating task's reminder moving with it, and
// dueReminders, which a page asks what came due since it last looked. Run with: npm test
process.env.TZ = 'America/Denver'; // the clocks go forward on 2027-03-14 at 2:00
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });

const { db } = await import('../shared/store.js');
const M = await import('../shared/model.js');
const { extendSchema, schemaFields, isDateTime, validateItem } = await import('../shared/sanitize.js');
const { setHour12, todayYmd, addDaysYmd, fmtDT } = await import('../shared/dates.js');

// The store keeps the two fields once shared/sanitize.js has them (cross request to the data owner);
// until then this test registers the same validators, so the model is tested through the real store.
if (!schemaFields('tasks').includes('reminder')) extendSchema('tasks', { reminder: (v) => (isDateTime(v) ? v : undefined) });
if (!schemaFields('events').includes('alerts')) {
  extendSchema('events', {
    alerts: (v) => {
      const a = M.cleanAlerts(v);
      return a.length ? a : undefined;
    },
  });
}
setHour12(false); // labels in 24-hour time, whatever this machine's locale

const at = (s) => new Date(s).getTime(); // 'YYYY-MM-DDTHH:MM' is local time
const cal = db.insert('calendars', { name: 'QA', color: 'blue', visible: true, order: 0 });
const ev = (e) => db.insert('events', { title: 'E', calendarId: cal.id, allDay: false, location: '', notes: '', repeat: null, exdates: [], until: null, ...e });
const keys = (list) => list.map((r) => `${r.kind}:${r.title}@${fmtDT(r.at)}`);
const clear = () => db.batch(() => ['tasks', 'events'].forEach((c) => db.all(c).forEach((x) => db.remove(c, x.id))));

test('alerts are kept as whole minutes, each once, at most five, the earliest first', () => {
  // The first five in range (-540 is 9:00 on an all-day event's day), rounded and read from numeric
  // strings as the store's validators read numbers, earliest first.
  assert.deepEqual(M.cleanAlerts([10, 0, 10, 1440, -540, 30.5, '15', null, 40321, -1440, 60, 120, 5]), [1440, 31, 10, 0, -540]);
  assert.deepEqual(M.cleanAlerts([null, '15', 40321, -1440, 'soon', 120, ' 60 ', true, {}]), [120, 60, 15]);
  assert.deepEqual(M.cleanAlerts([0, -540, 40320, -1439]), [40320, 0, -540, -1439]);
  assert.deepEqual(M.cleanAlerts('10'), []);
  assert.deepEqual(M.cleanAlerts(undefined), []);
});

test("alerts read in Apple Calendar's words; an all-day event's come at 9:00", () => {
  const timed = M.ALERT_CHOICES.timed.map((m) => M.alertLabel(m));
  assert.deepEqual(timed, ['At time of event', '5 minutes before', '10 minutes before', '15 minutes before', '30 minutes before', '1 hour before', '2 hours before', '1 day before', '2 days before', '1 week before']);
  const allDay = M.ALERT_CHOICES.allDay.map((m) => M.alertLabel(m, { allDay: true }));
  assert.deepEqual(allDay, ['On the day at 09:00', '1 day before at 09:00', '2 days before at 09:00', '1 week before at 09:00']);
  assert.equal(M.alertLabel(90), '1 hour 30 minutes before');
  assert.equal(M.alertLabel(-15), '15 minutes after');
  assert.equal(M.alertLabel(1), '1 minute before');
  assert.equal(M.alertLabel(0, { allDay: true }), 'On the day at 00:00');
  assert.equal(M.alertLabel('x'), '');
});

test('"Remind me" offers Later today, Tomorrow and Next week, and At its time for a timed task', () => {
  const wed = new Date(2026, 10, 25, 13, 20); // a Wednesday
  assert.deepEqual(M.reminderChoices(null, wed), [
    { id: 'later', label: 'Later today', value: '2026-11-25T17:00' },
    { id: 'tomorrow', label: 'Tomorrow', value: '2026-11-26T09:00' },
    { id: 'nextweek', label: 'Next week', value: '2026-11-30T09:00' },
  ]);
  assert.equal(M.reminderChoices(null, new Date(2026, 10, 25, 13, 0))[0].value, '2026-11-25T16:00', 'on the hour: three hours on');
  assert.ok(!M.reminderChoices(null, new Date(2026, 10, 25, 21, 30)).some((c) => c.id === 'later'), 'not once later today is tomorrow');
  const sunday = M.reminderChoices(null, new Date(2026, 10, 29, 10, 0));
  assert.deepEqual(sunday.map((c) => c.id), ['later', 'tomorrow'], 'on a Sunday Next week is tomorrow: one choice for it');
  const timed = M.reminderChoices({ date: '2026-11-27', time: '15:00' }, wed);
  assert.deepEqual(timed[0], { id: 'attime', label: 'At its time', value: '2026-11-27T15:00' });
  assert.ok(!M.reminderChoices({ date: '2026-11-25', time: '08:00' }, wed).some((c) => c.id === 'attime'), 'not for a time already past');
  assert.equal(M.reminderLabel(`${todayYmd()}T16:00`), 'Today at 16:00');
  assert.equal(M.reminderLabel(`${addDaysYmd(todayYmd(), 1)}T09:00`), 'Tomorrow at 09:00');
  assert.equal(M.reminderLabel('soon'), '');
  // With 12-hour time, as the apps write times: '9am', '4:30pm'.
  setHour12(true);
  try {
    assert.equal(M.reminderLabel(`${todayYmd()}T16:30`), 'Today at 4:30pm');
    assert.equal(M.alertLabel(-540, { allDay: true }), 'On the day at 9am');
    assert.equal(M.alertLabel(900, { allDay: true }), '1 day before at 9am');
  } finally {
    setHour12(false);
  }
});

test('createTask keeps a reminder and createEvent its alerts; a bad value is left out', () => {
  const t = M.createTask({ title: 'Call mom', reminder: '2027-01-05T18:00' });
  assert.equal(db.get('tasks', t.id).reminder, '2027-01-05T18:00');
  assert.equal('reminder' in M.createTask({ title: 'No reminder', reminder: 'tomorrow' }), false);
  const e = M.createEvent({ title: 'Standup', date: '2027-01-05', time: '09:30', duration: 15, calendarId: cal.id, alerts: [10, 0, 10] });
  assert.deepEqual(db.get('events', e.id).alerts, [10, 0]);
  assert.equal('alerts' in M.createEvent({ title: 'Plain', date: '2027-01-05', time: '10:00', calendarId: cal.id }), false, 'none: the field is left out');
  // A record without them validates exactly as before, so nothing already stored changes.
  const plain = db.all('tasks').find((x) => x.title === 'No reminder');
  assert.deepEqual(validateItem('tasks', structuredClone(plain)), plain);
  clear();
});

test('dueReminders: an open task reminds once, at its time; done or moved, it does not', () => {
  const t = M.createTask({ title: 'Call mom', reminder: '2027-01-05T18:00' });
  assert.deepEqual(keys(M.dueReminders(at('2027-01-05T17:59'), at('2027-01-05T18:00'))), ['task:Call mom@2027-01-05T18:00'], 'due at its minute');
  assert.deepEqual(M.dueReminders(at('2027-01-05T18:00'), at('2027-01-05T18:05')), [], 'not again once that moment has passed');
  assert.deepEqual(M.dueReminders(at('2027-01-05T17:00'), at('2027-01-05T17:59')), [], 'not early');
  const [r] = M.dueReminders(at('2027-01-05T17:00'), at('2027-01-05T19:00'));
  assert.equal(r.key, `task:${t.id}@2027-01-05T18:00`);
  assert.deepEqual(M.describeReminder(r), { title: 'Call mom', body: 'Reminder', text: 'Reminder: Call mom' });
  assert.equal(M.reminderPath(r), `tasks/#/task/${t.id}`);
  db.update('tasks', t.id, { done: true, completedAt: Date.now() });
  assert.deepEqual(M.dueReminders(at('2027-01-05T17:00'), at('2027-01-05T19:00')), [], 'a completed task does not remind');
  db.update('tasks', t.id, { done: false, completedAt: null, reminder: null });
  assert.equal('reminder' in db.get('tasks', t.id), false, 'cleared: the field goes');
  assert.deepEqual(M.dueReminders(at('2027-01-05T17:00'), at('2027-01-05T19:00')), []);
  clear();
});

test('dueReminders: each alert of each occurrence, any calendar, but not for an event already over', () => {
  ev({ title: 'Review', start: '2027-01-05T10:00', end: '2027-01-05T11:00', alerts: [10, 0], location: 'Room 4' });
  assert.deepEqual(keys(M.dueReminders(at('2027-01-05T09:45'), at('2027-01-05T09:55'))), ['event:Review@2027-01-05T09:50']);
  assert.deepEqual(keys(M.dueReminders(at('2027-01-05T09:45'), at('2027-01-05T10:00'))), ['event:Review@2027-01-05T09:50', 'event:Review@2027-01-05T10:00']);
  const [soon] = M.dueReminders(at('2027-01-05T09:45'), at('2027-01-05T09:55'));
  assert.deepEqual(M.describeReminder(soon, new Date(at('2027-01-05T09:50'))), { title: 'Review', body: 'In 10 minutes · Room 4', text: 'Review · In 10 minutes · Room 4' });
  assert.equal(M.describeReminder(soon, new Date(at('2027-01-05T10:00'))).body, 'Now · Room 4');
  assert.equal(M.reminderPath(soon), `schedule/#/day/2027-01-05/event/${soon.id}`);
  // Hiding the calendar takes it off the grid; it doesn't mute it.
  db.update('calendars', cal.id, { visible: false });
  assert.equal(M.dueReminders(at('2027-01-05T09:45'), at('2027-01-05T09:55')).length, 1);
  db.update('calendars', cal.id, { visible: true });
  // After a long pause (a sleeping laptop) an alert for an event that is over by now is left out.
  assert.deepEqual(M.dueReminders(at('2027-01-05T09:00'), at('2027-01-05T11:00')), []);
  assert.equal(M.dueReminders(at('2027-01-05T09:00'), at('2027-01-05T10:59')).length, 2, 'still under way: both');
  clear();
});

test('dueReminders: a repeating event alerts on every occurrence except those taken out', () => {
  const e = ev({ title: 'Standup', start: '2027-01-04T09:30', end: '2027-01-04T09:45', repeat: { freq: 'day', interval: 1 }, exdates: ['2027-01-06'], alerts: [5] });
  const days = ['2027-01-04', '2027-01-05', '2027-01-06', '2027-01-07'];
  assert.deepEqual(days.flatMap((d) => keys(M.dueReminders(at(`${d}T09:00`), at(`${d}T09:30`)))), ['event:Standup@2027-01-04T09:25', 'event:Standup@2027-01-05T09:25', 'event:Standup@2027-01-07T09:25']);
  // Looking back over the days from 9:40 on the 7th: the earlier ones are over, only the 7th's is still on.
  assert.deepEqual(keys(M.dueReminders(at('2027-01-04T00:00'), at('2027-01-07T09:40'))), ['event:Standup@2027-01-07T09:25']);
  const r = M.dueReminders(at('2027-01-05T09:00'), at('2027-01-05T09:30'));
  assert.equal(r[0].key, `event:${e.id}@2027-01-05T09:30~5`);
  // Moved to 10:00, it is a new moment with a new key.
  db.update('events', e.id, { start: '2027-01-04T10:00', end: '2027-01-04T10:15' });
  assert.equal(M.dueReminders(at('2027-01-05T09:00'), at('2027-01-05T10:00'))[0].key, `event:${e.id}@2027-01-05T10:00~5`);
  clear();
});

test("dueReminders: an all-day event's alerts come at 9:00 on the day or the day before", () => {
  ev({ title: 'Mom birthday', allDay: true, start: '2027-02-10', end: '2027-02-10', alerts: [-540, 900] });
  assert.deepEqual(keys(M.dueReminders(at('2027-02-09T00:00'), at('2027-02-10T12:00'))), ['event:Mom birthday@2027-02-09T09:00', 'event:Mom birthday@2027-02-10T09:00']);
  const [dayBefore] = M.dueReminders(at('2027-02-09T08:00'), at('2027-02-09T10:00'));
  assert.equal(dayBefore.allDay, true);
  assert.match(M.describeReminder(dayBefore).body, /, all day$/);
  // A two-day offsite is under way on its second day: its alert still counts then.
  ev({ title: 'Offsite', allDay: true, start: '2027-02-15', end: '2027-02-16', alerts: [-540] });
  assert.deepEqual(keys(M.dueReminders(at('2027-02-15T08:00'), at('2027-02-16T23:00'))), ['event:Offsite@2027-02-15T09:00']);
  clear();
});

test('dueReminders: alerts are on the clock across a clock change; a long pause counts the last week', () => {
  // A day before 9:00 on the 15th is 9:00 on the 14th, the day the clocks go forward (not 8:00 or 10:00).
  ev({ title: 'Dentist', start: '2027-03-15T09:00', end: '2027-03-15T09:45', alerts: [1440, 60] });
  assert.deepEqual(keys(M.dueReminders(at('2027-03-13T00:00'), at('2027-03-15T08:30'))), ['event:Dentist@2027-03-14T09:00', 'event:Dentist@2027-03-15T08:00']);
  clear();
  M.createTask({ title: 'Old', reminder: '2027-03-01T09:00' });
  M.createTask({ title: 'Recent', reminder: '2027-03-20T09:00' });
  assert.deepEqual(keys(M.dueReminders(at('2027-02-01T00:00'), at('2027-03-25T00:00'))), ['task:Recent@2027-03-20T09:00'], 'a span longer than a week counts as the last week');
  assert.deepEqual(M.dueReminders(at('2027-03-25T00:00'), at('2027-03-24T00:00')), [], 'an empty span');
  assert.deepEqual(M.dueReminders(NaN, at('2027-03-24T00:00')), []);
  clear();
});

test('completing a repeating task moves its reminder to the next one, the same time before it; Undo moves it back', () => {
  const t = M.createTask({ title: 'Water the fern', date: '2027-01-04', repeat: { freq: 'week', interval: 1, days: [1] }, reminder: '2027-01-03T20:00' }); // the evening before, a Monday task
  const undo = M.toggleTask(t.id);
  const next = db.get('tasks', t.id);
  assert.ok(next.date > '2027-01-04' && !next.done, 'moved on to its next Monday');
  const shift = Math.round((at(`${next.date}T00:00`) - at('2027-01-04T00:00')) / 86400000);
  assert.equal(next.reminder, `${addDaysYmd('2027-01-03', shift)}T20:00`, 'still the evening before');
  const logged = db.all('tasks').find((x) => x.repeatOf === t.id);
  assert.equal(logged.done, true);
  assert.deepEqual(M.dueReminders(at(`${logged.reminder}`) - 60000, at(`${logged.reminder}`)).map((r) => r.id), [], 'the logged copy is done: it does not remind');
  undo();
  assert.deepEqual([db.get('tasks', t.id).date, db.get('tasks', t.id).reminder], ['2027-01-04', '2027-01-03T20:00']);
  // A task without a date keeps its reminder's distance from today's date.
  const daily = M.createTask({ title: 'Stretch', repeat: { freq: 'day', interval: 1 }, reminder: `${todayYmd()}T07:30` });
  M.toggleTask(daily.id);
  const d = db.get('tasks', daily.id);
  assert.equal(d.reminder, `${d.date}T07:30`, 'on its new day at the same time');
  clear();
});
