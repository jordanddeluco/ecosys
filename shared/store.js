// ecosys shared data store.
// Every app is served from the same origin, so they all read and write the same localStorage.
// Changes made in one app (or tab) are pushed to the others through the `storage` event,
// so tasks and schedule stay in sync live.

const PREFIX = 'ecosys:v1:';
const COLLECTIONS = ['tasks', 'lists', 'events', 'calendars'];

function detectWeekStart() {
  try {
    const loc = new Intl.Locale(navigator.language || 'en-US');
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info?.firstDay) return info.firstDay % 7;
  } catch {}
  return 0;
}

export const DEFAULT_SETTINGS = {
  theme: 'system', // 'system' | 'light' | 'dim' | 'dark'
  accent: 'iris', // see ACCENTS in shell.js
  weekStart: detectWeekStart(),
  timeFormat: 'auto', // 'auto' | '12h' | '24h'
  defaultEventMinutes: 60,
  defaultTaskMinutes: 30,
  dayStartHour: 8,
  showTasksInSchedule: true,
  hiddenTaskLists: [], // list ids whose tasks are hidden in schedule
  scheduleView: 'week',
  scheduleDays: 3, // for the N-day view
  showWeekends: true,
  showEventsInToday: true,
  reduceMotion: false,
};

export const uid = () =>
  (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`).replace(/-/g, '').slice(0, 16);

const cache = {};
let settingsCache = null;
const listeners = new Set();
let pending = null;
let batchDepth = 0;
const dirty = new Set();

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch (err) {
    console.error('ecosys: could not save', key, err);
    window.dispatchEvent(new CustomEvent('ecosys:save-error', { detail: err }));
  }
}

function load(name) {
  cache[name] = read(name, []);
  if (!Array.isArray(cache[name])) cache[name] = [];
}

function emit(names, remote = false) {
  if (!pending) {
    pending = { names: new Set(), remote: false };
    queueMicrotask(() => {
      const evt = pending;
      pending = null;
      for (const fn of listeners) {
        try {
          fn(evt);
        } catch (err) {
          console.error(err);
        }
      }
    });
  }
  for (const n of names) pending.names.add(n);
  pending.remote = pending.remote || remote;
}

function commit(name) {
  if (batchDepth > 0) {
    dirty.add(name);
    return;
  }
  if (name === 'settings') write('settings', settingsCache);
  else write(name, cache[name]);
  emit([name]);
}

const now = () => Date.now();

export const db = {
  all(name) {
    return cache[name];
  },
  get(name, id) {
    return cache[name].find((x) => x.id === id) || null;
  },
  where(name, fn) {
    return cache[name].filter(fn);
  },
  insert(name, obj) {
    const item = { id: uid(), createdAt: now(), ...obj, updatedAt: now() };
    cache[name].push(item);
    commit(name);
    return item;
  },
  /** Insert or fully replace an item by id (used for undo). */
  put(name, obj) {
    const i = cache[name].findIndex((x) => x.id === obj.id);
    if (i >= 0) cache[name][i] = obj;
    else cache[name].push(obj);
    commit(name);
    return obj;
  },
  update(name, id, patch) {
    const i = cache[name].findIndex((x) => x.id === id);
    if (i < 0) return null;
    const prev = cache[name][i];
    const next = { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch), updatedAt: now() };
    cache[name][i] = next;
    commit(name);
    return next;
  },
  remove(name, id) {
    const i = cache[name].findIndex((x) => x.id === id);
    if (i < 0) return null;
    const [item] = cache[name].splice(i, 1);
    commit(name);
    return item;
  },
  /** Group several writes into one save + one change notification. */
  batch(fn) {
    batchDepth++;
    try {
      return fn();
    } finally {
      batchDepth--;
      if (batchDepth === 0 && dirty.size) {
        const names = [...dirty];
        dirty.clear();
        for (const n of names) {
          if (n === 'settings') write('settings', settingsCache);
          else write(n, cache[n]);
        }
        emit(names);
      }
    }
  },
  /** Subscribe to changes. fn({names:Set<string>, remote:boolean}). Returns an unsubscribe function. */
  on(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export const settings = {
  get() {
    return settingsCache;
  },
  set(patch) {
    settingsCache = { ...settingsCache, ...patch };
    commit('settings');
    return settingsCache;
  },
};

// ---------- backup / restore ----------

export function exportData() {
  return {
    app: 'ecosys',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: settingsCache,
    ...Object.fromEntries(COLLECTIONS.map((n) => [n, cache[n]])),
  };
}

export function importData(data) {
  if (!data || data.app !== 'ecosys') throw new Error('This file is not an ecosys backup.');
  db.batch(() => {
    for (const n of COLLECTIONS) {
      if (Array.isArray(data[n])) {
        cache[n] = data[n];
        dirty.add(n);
      }
    }
    if (data.settings) {
      settingsCache = { ...DEFAULT_SETTINGS, ...data.settings };
      dirty.add('settings');
    }
  });
}

export function resetData({ withSamples = false } = {}) {
  db.batch(() => {
    for (const n of COLLECTIONS) {
      cache[n] = [];
      dirty.add(n);
    }
  });
  localStorage.removeItem(PREFIX + 'seeded');
  if (withSamples) seedIfEmpty(true);
  else ensureDefaults();
}

// ---------- first run ----------

let seeder = null;
/** Apps register the sample-data builder (kept in seed.js so the store stays small). */
export function registerSeeder(fn) {
  seeder = fn;
}

function ensureDefaults() {
  db.batch(() => {
    if (!cache.calendars.length) {
      db.insert('calendars', { name: 'Personal', color: 'iris', visible: true, order: 0 });
      db.insert('calendars', { name: 'Work', color: 'blue', visible: true, order: 1 });
    }
    if (!cache.lists.length) {
      db.insert('lists', { name: 'Personal', color: 'iris', icon: '', order: 0 });
      db.insert('lists', { name: 'Work', color: 'blue', icon: '', order: 1 });
    }
  });
  localStorage.setItem(PREFIX + 'seeded', '1');
}

export function seedIfEmpty(force = false) {
  const seeded = localStorage.getItem(PREFIX + 'seeded');
  if (seeded && !force) return;
  const empty = COLLECTIONS.every((n) => !cache[n].length);
  if (!empty && !force) {
    localStorage.setItem(PREFIX + 'seeded', '1');
    return;
  }
  if (seeder) db.batch(() => seeder(db));
  ensureDefaults();
}

// ---------- init ----------

for (const n of COLLECTIONS) load(n);
settingsCache = { ...DEFAULT_SETTINGS, ...read('settings', {}) };

window.addEventListener('storage', (e) => {
  if (e.storageArea !== localStorage) return;
  if (e.key === null) {
    for (const n of COLLECTIONS) load(n);
    settingsCache = { ...DEFAULT_SETTINGS, ...read('settings', {}) };
    emit([...COLLECTIONS, 'settings'], true);
    return;
  }
  if (!e.key.startsWith(PREFIX)) return;
  const name = e.key.slice(PREFIX.length);
  if (COLLECTIONS.includes(name)) {
    load(name);
    emit([name], true);
  } else if (name === 'settings') {
    settingsCache = { ...DEFAULT_SETTINGS, ...read('settings', {}) };
    emit(['settings'], true);
  }
});
