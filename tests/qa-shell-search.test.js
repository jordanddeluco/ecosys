// QA regressions for shared/shell.js that run without a browser (the module is imported with small DOM shims):
//   - the palette's search: score() and scoreLower() agree, the query's words are split once, and searchText()
//     keeps a record's lower-case text until one of the fields it was built from changes (Ctrl+K lowercased
//     about 8 MB of task, event and note text on every keystroke with a large library)
//   - Quick note from another app tells Notes where it was opened from (?back=), so Done brings you back
//   - the time zone is reported once the page is in sync with ecosys, never before, and only when it changed
//   - Today's glyph is the drawn calendar with the now-dot, with no font-drawn date
// The palette, Settings and the backup round trip in the browser are in tests/e2e/qa-shell-fixes.test.mjs.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const S = await import('../shared/shell.js');
const { settings } = await import('../shared/store.js');

test('score(): every word must match; a word the text starts with scores 3, one that starts a word 2, one inside a word 1', () => {
  assert.equal(S.score('Buy milk', ''), 1, 'an empty query matches everything');
  assert.equal(S.score('Buy milk', '   '), 0, 'a query of spaces has no words');
  assert.equal(S.score('Buy milk', 'buy'), 3);
  assert.equal(S.score('Buy milk', 'MILK'), 2, 'case does not matter');
  assert.equal(S.score('Buy milk', 'ilk'), 1);
  assert.equal(S.score('Buy milk', 'buy bread'), 0, 'every word must match');
  assert.equal(S.score('Buy milk', 'buy milk'), 5);
  assert.equal(S.score(null, 'x'), 0);
});

test('scoreLower() scores lower-case text exactly as score() scores the original', () => {
  const texts = ['Quarterly Budget review', 'Team standup — Zoom', 'Recipes: lasagne, Pho', 'ÉCOLE rentrée', 'a  b   c'];
  const queries = ['budget', 'BUD rev', 'standup zoom', 'pho', 'école', 'b c', 'x', ''];
  for (const t of texts) for (const q of queries) assert.equal(S.scoreLower(t.toLowerCase(), q), S.score(t, q), `${t} / ${q}`);
  // The terms are cached per query; a new query must not reuse the old one's.
  assert.equal(S.scoreLower('alpha beta', 'alpha'), 3);
  assert.equal(S.scoreLower('alpha beta', 'beta'), 2);
  assert.equal(S.scoreLower('alpha beta', 'alpha'), 3);
});

test('searchText() builds a record’s text once and keeps it while its fields stay the same', () => {
  const task = { id: 't1', title: 'Quarterly Budget', notes: 'Draft FIRST' };
  let built = 0;
  const text = (t, list) => S.searchText(t, [t.title, t.notes, list], () => {
    built++;
    return `${t.title} ${t.notes} ${list}`;
  });
  assert.equal(text(task, 'Work'), 'quarterly budget draft first work', 'lower case');
  assert.equal(text(task, 'Work'), 'quarterly budget draft first work');
  assert.equal(built, 1, 'built once for the same record and fields');
  assert.equal(text(task, 'Projects'), 'quarterly budget draft first projects', 'a renamed list builds it again');
  assert.equal(built, 2);
  task.title = 'Annual budget'; // changed in place
  assert.equal(text(task, 'Projects'), 'annual budget draft first projects', 'a field changed in place builds it again');
  const edited = { ...task, notes: 'Final' }; // the store gives an edited record a new object
  assert.equal(text(edited, 'Projects'), 'annual budget final projects');
  assert.equal(built, 4);
  assert.equal(S.searchText(null, [], () => 'No Record'), 'no record', 'no record: built every time, never cached');
});

test('taskSearchText() and eventSearchText(): the text the palette searches, one cached copy per record', () => {
  const t = { id: 't1', title: 'Pay Rent', notes: 'Before the 5th', tags: ['Home', 'Bills'], listId: 'l1' };
  assert.equal(S.taskSearchText(t, 'Errands'), 'pay rent before the 5th home bills errands');
  assert.equal(S.taskSearchText(t, 'Errands'), S.taskSearchText(t, 'Errands'));
  assert.equal(S.taskSearchText(t, 'Chores'), 'pay rent before the 5th home bills chores', 'a renamed list');
  assert.equal(S.taskSearchText({ id: 't2', title: 'Only a title' }), 'only a title   ', 'missing fields are empty, never "undefined"');
  assert.equal(S.scoreLower(S.taskSearchText(t, 'Chores'), 'bills'), S.score('Pay Rent Before the 5th Home Bills Chores', 'bills'));
  const e = { id: 'e1', title: 'Standup', location: 'Zoom Room', notes: null };
  assert.equal(S.eventSearchText(e), 'standup zoom room ');
  assert.equal(S.eventSearchText({ ...e, notes: 'Agenda' }), 'standup zoom room agenda', 'an edited event (a new object)');
  assert.equal(S.taskSearchText(null, 'x'), '   x', 'no record: no throw');
});

test('searching a large library is fast once its text is cached (the palette scores every record on each key)', () => {
  const words = ['budget', 'standup', 'recipes', 'invoice', 'yoga', 'laundry', 'contract', 'agenda'];
  const notes = 'Read agenda pick training schedule contract invoice slides party yoga plan notes laundry. '.repeat(40);
  const tasks = Array.from({ length: 5000 }, (_, i) => ({ id: `t${i}`, title: `Task ${i} ${words[i % words.length]}`, notes }));
  const hay = (t) => S.searchText(t, [t.title, t.notes], () => `${t.title} ${t.notes}`);
  for (const t of tasks) hay(t); // the first keystroke builds it
  const t0 = performance.now();
  let hits = 0;
  for (const q of ['b', 'bu', 'bud', 'budg', 'budge', 'budget']) for (const t of tasks) if (S.scoreLower(hay(t), q)) hits++;
  const perKey = (performance.now() - t0) / 6;
  assert.ok(hits > 0);
  assert.ok(perKey < 40, `5,000 tasks with long notes take ${perKey.toFixed(1)} ms per key (cached), under a frame or two`);
});

test('Quick note from another app passes its own address to Notes, so Done can bring you back', () => {
  const was = globalThis.location;
  try {
    const from = 'http://127.0.0.1:4321/tasks/#/task/abc123?x=1&y=2';
    globalThis.location = { href: from };
    S.openQuickNote();
    const to = globalThis.location.href;
    const m = /^(.*)notes\/#\/quick\?back=(.*)$/.exec(to);
    assert.ok(m, `opens Notes' Quick Note (${to})`);
    assert.equal(m[1], S.BASE, 'under the site root, wherever it is hosted');
    assert.equal(decodeURIComponent(m[2]), from, 'the whole address, encoded, so its own # and ? survive');
    assert.equal(new URLSearchParams(to.split('?')[1]).get('back'), from, 'as Notes reads it (URLSearchParams)');
  } finally {
    globalThis.location = was;
  }
});

test('the time zone is reported once the page is in sync, and only when it changed', () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.ok(zone, 'this Node knows its time zone');
  settings.set({ uiTimeZone: 'Pacific/Galapagos' === zone ? 'Europe/Oslo' : 'Pacific/Galapagos' });
  const before = settings.get().uiTimeZone;
  delete window.ecosysSync;
  S.reportTimeZone();
  assert.equal(settings.get().uiTimeZone, before, 'not before sync (a new browser’s first sync is left alone)');
  window.ecosysSync = { online: false, status: 'offline' };
  S.reportTimeZone();
  assert.equal(settings.get().uiTimeZone, before, 'not while ecosys is away');
  window.ecosysSync = { online: true, status: 'online' };
  S.reportTimeZone();
  assert.equal(settings.get().uiTimeZone, zone, 'in sync: this computer’s zone');
  let writes = 0;
  const off = S.db.on(({ names }) => names.has('settings') && writes++);
  S.reportTimeZone();
  off?.();
  assert.equal(writes, 0, 'the same zone again writes nothing');
  delete window.ecosysSync;
});

test("Today's glyph is the drawn calendar with the now-dot, sized as asked, decorative, with no date number", () => {
  const g = S.todayGlyph(18);
  assert.match(g, /^<span class="today-glyph" style="width:18px;height:18px" aria-hidden="true"><svg /);
  assert.equal(g.includes(S.icon('today', { size: 18 })), true, 'the today line icon');
  assert.match(g, /<circle cx="12" cy="15\.4" r="2\.2" fill="currentColor" stroke="none"\/>/, 'the now-dot');
  assert.doesNotMatch(g, /<b>|<text/, 'no font-drawn date');
  assert.equal(S.todayGlyph(18), g, 'the same every day');
});
