// Line icons (24×24 grid, 1.8 stroke, round caps and joins), drawn in the ecosys logo family: the solid dot means
// "now" or "you", and the app glyphs echo their logos (done = Tasks, note = Notes, today = Schedule, ai = AI, ecosys = Home).
const P = {
  inbox: '<path d="M21 12.5h-5.2l-1.7 2.7H9.9l-1.7-2.7H3"/><path d="M5.9 5.3 3 12.5v5.4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5.4l-2.9-7.2A2 2 0 0 0 16.2 4H7.8a2 2 0 0 0-1.9 1.3z"/>',
  star: '<path d="M10.58 5.03A1.6 1.6 0 0 1 13.42 5.03L15 8.03A0.8 0.8 0 0 0 15.57 8.44L18.9 9.02A1.6 1.6 0 0 1 19.78 11.71L17.42 14.14A0.8 0.8 0 0 0 17.2 14.81L17.68 18.16A1.6 1.6 0 0 1 15.39 19.83L12.35 18.33A0.8 0.8 0 0 0 11.65 18.33L8.61 19.83A1.6 1.6 0 0 1 6.32 18.16L6.8 14.81A0.8 0.8 0 0 0 6.58 14.14L4.22 11.71A1.6 1.6 0 0 1 5.1 9.02L8.43 8.44A0.8 0.8 0 0 0 9 8.03Z"/>',
  'star-fill': '<path d="M10.58 5.03A1.6 1.6 0 0 1 13.42 5.03L15 8.03A0.8 0.8 0 0 0 15.57 8.44L18.9 9.02A1.6 1.6 0 0 1 19.78 11.71L17.42 14.14A0.8 0.8 0 0 0 17.2 14.81L17.68 18.16A1.6 1.6 0 0 1 15.39 19.83L12.35 18.33A0.8 0.8 0 0 0 11.65 18.33L8.61 19.83A1.6 1.6 0 0 1 6.32 18.16L6.8 14.81A0.8 0.8 0 0 0 6.58 14.14L4.22 11.71A1.6 1.6 0 0 1 5.1 9.02L8.43 8.44A0.8 0.8 0 0 0 9 8.03Z" fill="currentColor"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="3.5"/><path d="M16 2.8v3.6M8 2.8v3.6M3 9.8h18"/>',
  'calendar-plus': '<rect x="3" y="4.5" width="18" height="16.5" rx="3.5"/><path d="M16 2.8v3.6M8 2.8v3.6M3 9.8h18M12 12.8v5M9.5 15.3h5"/>',
  layers: '<path d="m12 3 9 4.75-9 4.75-9-4.75z"/><path d="m3 12 9 4.75L21 12"/><path d="m3 16.25 9 4.75 9-4.75"/>',
  archive: '<rect x="2.8" y="3.5" width="18.4" height="5" rx="1.6"/><path d="M4.6 8.5v10a2 2 0 0 0 2 2h10.8a2 2 0 0 0 2-2v-10M10 12.5h4"/>',
  'check-circle': '<circle cx="12" cy="12" r="9.2"/><path d="m8 12.4 2.7 2.7 5.4-5.6"/>',
  done: '<path d="M3.5 13 9.7 19.1 20.5 6.1"/><circle cx="9.2" cy="5.9" r="2.3" fill="currentColor" stroke="none"/>',
  circle: '<circle cx="12" cy="12" r="9.2"/>',
  check: '<path d="M20 6.5 9.5 17 4.5 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.8"/><path d="m20.2 20.2-4.4-4.4"/>',
  gear: '<path d="M9.76 5.47L10.17 2.98A9.2 9.2 0 0 1 13.83 2.98L14.24 5.47A6.9 6.9 0 0 1 16.54 6.8L18.89 5.91A9.2 9.2 0 0 1 20.72 9.07L18.77 10.67A6.9 6.9 0 0 1 18.77 13.33L20.72 14.93A9.2 9.2 0 0 1 18.89 18.09L16.54 17.2A6.9 6.9 0 0 1 14.24 18.53L13.83 21.02A9.2 9.2 0 0 1 10.17 21.02L9.76 18.53A6.9 6.9 0 0 1 7.46 17.2L5.11 18.09A9.2 9.2 0 0 1 3.28 14.93L5.23 13.33A6.9 6.9 0 0 1 5.23 10.67L3.28 9.07A9.2 9.2 0 0 1 5.11 5.91L7.46 6.8A6.9 6.9 0 0 1 9.76 5.47Z"/><circle cx="12" cy="12" r="2.7"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-up': '<path d="m18 15-6-6-6 6"/>',
  more: '<circle cx="5.5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  trash: '<path d="M3.5 6.2h17M8.5 6.2V4.6A1.6 1.6 0 0 1 10.1 3h3.8a1.6 1.6 0 0 1 1.6 1.6v1.6M18.5 6.2l-.8 12.9a2 2 0 0 1-2 1.9H8.3a2 2 0 0 1-2-1.9L5.5 6.2M10 10.8v5.6M14 10.8v5.6"/>',
  flag: '<path d="M5.5 21.2V3.6"/><path d="M5.5 4.4H17.05A1 1 0 0 1 17.91 5.91L15.9 9.3L17.91 12.69A1 1 0 0 1 17.05 14.2H5.5"/>',
  tag: '<path d="M12.53 3.9A1.76 1.76 0 0 0 11.3 3.38H5.14A1.76 1.76 0 0 0 3.38 5.14V11.3A1.76 1.76 0 0 0 3.9 12.53L11.47 20.1A2.11 2.11 0 0 0 14.46 20.1L20.1 14.46A2.11 2.11 0 0 0 20.1 11.47Z"/><circle cx="8.13" cy="8.13" r="1.4" fill="currentColor" stroke="none"/>',
  clock: '<circle cx="12" cy="12" r="9.2"/><path d="M12 7v5.2l3.4 2"/>',
  repeat: '<path d="m17 2.5 3.5 3.5L17 9.5"/><path d="M3.5 11.5V10a4 4 0 0 1 4-4h13"/><path d="m7 21.5-3.5-3.5L7 14.5"/><path d="M20.5 12.5V14a4 4 0 0 1-4 4h-13"/>',
  list: '<path d="M9 6h11.5M9 12h11.5M9 18h11.5"/><circle cx="4.6" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="4.6" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="4.6" cy="18" r="1.5" fill="currentColor" stroke="none"/>',
  'text-lines': '<path d="M4 5.5h16M4 10h16M4 14.5h16M4 19h9.5"/>',
  checklist: '<path d="m3.5 6.5 1.6 1.6 3.1-3.2M3.5 14l1.6 1.6 3.1-3.2M11.5 6.6h9M11.5 14.1h9M11.5 20h9"/>',
  moon: '<path d="M20.4 14.6A8.6 8.6 0 1 1 9.4 3.6a6.8 6.8 0 0 0 11 11z"/>',
  tomorrow: '<rect x="3" y="4.5" width="18" height="16.5" rx="3.5"/><path d="M16 2.8v3.6M8 2.8v3.6M3 9.8h18"/><circle cx="8.9" cy="15.4" r="1.9" fill="currentColor" stroke="none"/><path d="m13.9 12.9 2.5 2.5-2.5 2.5"/>',
  contrast: '<circle cx="12" cy="12" r="9.2"/><path d="M12 6.2v11.6a5.8 5.8 0 0 0 0-11.6z" fill="currentColor" stroke="none"/>',
  apps: '<g fill="currentColor" stroke="none"><rect x="3.5" y="3.5" width="3.8" height="3.8" rx="1.2"/><rect x="10.1" y="3.5" width="3.8" height="3.8" rx="1.2"/><rect x="16.7" y="3.5" width="3.8" height="3.8" rx="1.2"/><rect x="3.5" y="10.1" width="3.8" height="3.8" rx="1.2"/><rect x="10.1" y="10.1" width="3.8" height="3.8" rx="1.2"/><rect x="16.7" y="10.1" width="3.8" height="3.8" rx="1.2"/><rect x="3.5" y="16.7" width="3.8" height="3.8" rx="1.2"/><rect x="10.1" y="16.7" width="3.8" height="3.8" rx="1.2"/><rect x="16.7" y="16.7" width="3.8" height="3.8" rx="1.2"/></g>',
  sidebar: '<rect x="3" y="3.8" width="18" height="16.4" rx="3.2"/><path d="M9.2 3.8v16.4"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  note: '<path d="M14.5 2.8H7.1A2.6 2.6 0 0 0 4.5 5.4V18.6A2.6 2.6 0 0 0 7.1 21.2H16.9A2.6 2.6 0 0 0 19.5 18.6V7.8Z"/><path d="M14.5 2.8V6.2A1.6 1.6 0 0 0 16.1 7.8H19.5"/><path d="M7.4 15.2c.7-1.62 1.49-1.62 2.19 0s1.49 1.62 2.19 0"/><circle cx="15.6" cy="15.2" r="1.7" fill="currentColor" stroke="none"/>',
  pin: '<path d="M19.2 10c0 5-7.2 11.2-7.2 11.2S4.8 15 4.8 10a7.2 7.2 0 0 1 14.4 0z"/><circle cx="12" cy="10" r="2.4" fill="currentColor" stroke="none"/>',
  edit: '<path d="M12.5 20.5h8"/><path d="M16.4 3.6a2.1 2.1 0 0 1 3 3L7.3 18.7l-4 1 1-4z"/>',
  download: '<path d="M12 3.5v11.5M7.2 10.5l4.8 4.8 4.8-4.8M4 20.5h16"/>',
  upload: '<path d="M12 15.5V4M7.2 8.8 12 4l4.8 4.8M4 20.5h16"/>',
  home: '<path d="M3.5 10.4 12 3.5l8.5 6.9v9.1a1.5 1.5 0 0 1-1.5 1.5h-4.6v-6.2H9.6V21H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  ecosys: '<path d="M3.9 12H20.1A8.1 8.1 0 1 0 12 20.1"/><circle cx="17.73" cy="17.73" r="2.1" fill="currentColor" stroke="none"/>',
  keyboard: '<rect x="2.2" y="5.2" width="19.6" height="13.6" rx="2.6"/><path d="M6 9.2h.01M10 9.2h.01M14 9.2h.01M18 9.2h.01M6 12.8h.01M10 12.8h.01M14 12.8h.01M18 12.8h.01M7.5 16h9"/>',
  undo: '<path d="M9 14.5 4 9.5l5-5"/><path d="M4 9.5h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  'arrow-up-right': '<path d="M7 17 17 7M8.5 7H17v8.5"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
  copy: '<rect x="8.5" y="8.5" width="12.5" height="12.5" rx="2.6"/><path d="M15.5 8.5V5.6A2.6 2.6 0 0 0 12.9 3H5.6A2.6 2.6 0 0 0 3 5.6v7.3a2.6 2.6 0 0 0 2.6 2.6h2.9"/>',
  shield: '<path d="M12 21.6s7.8-3.4 7.8-9.8V5.2L12 2.4 4.2 5.2v6.6c0 6.4 7.8 9.8 7.8 9.8z"/><path d="m8.8 12 2.2 2.2 4.4-4.4"/>',
  grip: '<circle cx="9" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.5" fill="currentColor" stroke="none"/>',
  'quick-note': '<path d="M4 8.8c1.5-4.2 3.1-4.2 4.6 0s3.1 4.2 4.6 0"/><path d="M4 18.6h16"/><circle cx="18" cy="8.8" r="2.5" fill="currentColor" stroke="none"/>',
  ai: '<path d="M8.2 5.6H9.51A1.1 1.1 0 0 1 10.61 6.74A6.4 6.4 0 0 0 17.26 13.39A1.1 1.1 0 0 1 18.4 14.49V15.8A4.2 4.2 0 0 1 14.2 20H8.2A4.2 4.2 0 0 1 4 15.8V9.8A4.2 4.2 0 0 1 8.2 5.6Z"/><circle cx="17" cy="7" r="3"/>',
  'ai-off': '<path d="M8.2 5.6H9.51A1.1 1.1 0 0 1 10.61 6.74A6.4 6.4 0 0 0 17.26 13.39A1.1 1.1 0 0 1 18.4 14.49V15.8A4.2 4.2 0 0 1 14.2 20H8.2A4.2 4.2 0 0 1 4 15.8V9.8A4.2 4.2 0 0 1 8.2 5.6Z"/><circle cx="17" cy="7" r="3"/><path d="M3.5 3.5 20.5 20.5"/>',
  eye: '<path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z"/><circle cx="12" cy="12" r="2.8"/>',
  'eye-off': '<path d="M10.6 5.1A9.6 9.6 0 0 1 12 5c6 0 9.5 7 9.5 7a16 16 0 0 1-2.2 3.1M6.6 6.6C3.9 8.4 2.5 12 2.5 12s3.5 7 9.5 7a9.4 9.4 0 0 0 5.4-1.6M3 3l18 18M9.9 9.9a2.8 2.8 0 0 0 4.2 4.2"/>',
  'arrow-left-right': '<path d="M8 3.5 4 7.5l4 4M4 7.5h16M16 12.5l4 4-4 4M20 16.5H4"/>',
  today: '<rect x="3" y="4.5" width="18" height="16.5" rx="3.5"/><path d="M16 2.8v3.6M8 2.8v3.6M3 9.8h18"/><circle cx="12" cy="15.4" r="2.2" fill="currentColor" stroke="none"/>',
  upcoming: '<rect x="3" y="4.5" width="18" height="16.5" rx="3.5"/><path d="M16 2.8v3.6M8 2.8v3.6M3 9.8h18"/><path d="M7.4 15.4H17"/><circle cx="7.4" cy="15.4" r="2" fill="currentColor" stroke="none"/>',
  duration: '<circle cx="12" cy="12" r="9.2"/><path d="M12 6.6V12h5.4A5.4 5.4 0 0 0 12 6.6z" fill="currentColor"/>',
  info: '<circle cx="12" cy="12" r="9.2"/><path d="M12 11v5.5M12 7.6h.01"/>',
  alert: '<circle cx="12" cy="12" r="9.2"/><path d="M12 7.2v5.8M12 16.6h.01"/>',
  bulb: '<path d="M9.2 18.2h5.6M10.2 21.2h3.6"/><path d="M12 2.8a6.6 6.6 0 0 0-3.9 11.9c.6.5.9 1.1.9 1.9v.6h6v-.6c0-.8.3-1.4.9-1.9A6.6 6.6 0 0 0 12 2.8z"/><path d="M9 9.4a3 3 0 0 1 3-3"/>',
  sort: '<path d="M7 4v16M3.5 7.5 7 4l3.5 3.5M17 20V4M13.5 16.5 17 20l3.5-3.5"/>',
  'circle-plus': '<circle cx="12" cy="12" r="9.2"/><path d="M12 8v8M8 12h8"/>',
  'flag-fill': '<path d="M5.5 21.2V3.6"/><path d="M5.5 4.4H17.05A1 1 0 0 1 17.91 5.91L15.9 9.3L17.91 12.69A1 1 0 0 1 17.05 14.2H5.5Z" fill="currentColor"/>',
  'more-v': '<circle cx="12" cy="5.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.4" fill="currentColor" stroke="none"/>',
  hash: '<path d="M9.5 3.5 7.5 20.5M16.5 3.5l-2 17M4 8.5h17M3 15.5h17"/>',
  bell: '<path d="M6 9.5a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15.5 6 9.5z"/><path d="M10.2 20.5a2 2 0 0 0 3.6 0"/>',
  'panel-right': '<rect x="3" y="3.8" width="18" height="16.4" rx="3.2"/><path d="M14.8 3.8v16.4"/>',
  'external': '<path d="M14 3.5h6.5V10M20.5 3.5 11 13M18 14v4.5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2H10"/>',

  // keycap glyphs (rendered inside <kbd> by keys() in shell.js — never use the Unicode symbols)
  'key-command': '<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3z"/>',
  'key-option': '<path d="M3.5 6.5h5.2l6.6 11h5.2M14.5 6.5h6"/>',
  'key-shift': '<path d="M9 20v-6.6H4.6L12 4.6l7.4 8.8H15V20z"/>',
  'key-return': '<path d="M20 4.5v7a3.5 3.5 0 0 1-3.5 3.5H4.5"/><path d="m9 10.5-4.5 4.5L9 19.5"/>',
  'key-delete-left': '<path d="M9.3 5.5h10.2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9.3a2 2 0 0 1-1.5-.68L2.8 12l5-5.82a2 2 0 0 1 1.5-.68z"/><path d="m12.5 9.5 5 5M17.5 9.5l-5 5"/>',
  'arrow-up': '<path d="M12 19.5v-15M5.5 11 12 4.5l6.5 6.5"/>',
  'arrow-down': '<path d="M12 4.5v15M5.5 13l6.5 6.5 6.5-6.5"/>',
  'arrow-left': '<path d="M19.5 12h-15M11 5.5 4.5 12l6.5 6.5"/>',

  // dates & fields
  dot: '<circle cx="12" cy="12" r="3.6" fill="currentColor" stroke="none"/>',
  'calendar-week': '<rect x="3" y="4.5" width="18" height="16.5" rx="3.5"/><path d="M16 2.8v3.6M8 2.8v3.6M3 9.8h18"/><rect x="6.5" y="14" width="11" height="2.8" rx="1.2" fill="currentColor" stroke="none"/>',
  'calendar-next': '<path d="M21 12V8a3.5 3.5 0 0 0-3.5-3.5h-11A3.5 3.5 0 0 0 3 8v9.5A3.5 3.5 0 0 0 6.5 21H12M16 2.8v3.6M8 2.8v3.6M3 9.8h18"/><path d="M15 17.5h6M18.5 15l2.5 2.5-2.5 2.5"/>',
  'calendar-month': '<rect x="3" y="4.5" width="18" height="16.5" rx="3.5"/><path d="M16 2.8v3.6M8 2.8v3.6M3 9.8h18"/><path d="M7.5 13.5h.01M12 13.5h.01M16.5 13.5h.01M7.5 17h.01M12 17h.01M16.5 17h.01" stroke-width="2.4"/>',
  weekend: '<rect x="3" y="4.5" width="18" height="16.5" rx="3.5"/><path d="M16 2.8v3.6M8 2.8v3.6M3 9.8h18"/><rect x="12.4" y="13.5" width="5.4" height="3.8" rx="1.3" fill="currentColor" stroke="none"/>',
  'no-date': '<rect x="3" y="4.5" width="18" height="16.5" rx="3.5"/><path d="M16 2.8v3.6M8 2.8v3.6M3 9.8h18"/><path d="M4 4.2 20.5 20.7"/>',
  deadline: '<path d="M5.4 12H20M20 6.6v10.8"/><circle cx="5.4" cy="12" r="2.3" fill="currentColor" stroke="none"/>',
  'chevron-up-down': '<path d="m8 9.5 4-4 4 4M8 14.5l4 4 4-4"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 4v4.5H8M12 7.5V12l3 2"/>',

  // notes & formatting
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.7l2 2.2h7.3A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
  'folder-plus': '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.7l2 2.2h7.3A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M12 10.8v6M9 13.8h6"/>',
  pushpin: '<path d="M12 16.5v5M8.5 3.5h7M9.5 3.5v6l-3 3.3v2.2h11v-2.2l-3-3.3v-6"/>',
  bold: '<path d="M7 4.5h6a3.75 3.75 0 0 1 0 7.5H7zM7 12h7a3.75 3.75 0 0 1 0 7.5H7z"/>',
  italic: '<path d="M18.5 4.5h-8M13.5 19.5h-8M14.5 4.5l-5 15"/>',
  underline: '<path d="M7 4v7a5 5 0 0 0 10 0V4M5 20.5h14"/>',
  strikethrough: '<path d="M16.5 6.8A4.5 4.5 0 0 0 12.2 4.5c-2.6 0-4.3 1.5-4.3 3.4 0 1.4.8 2.4 2.4 3.1M4 12h16M7.6 16.6c.7 1.8 2.3 2.9 4.6 2.9 2.7 0 4.4-1.5 4.4-3.5a3 3 0 0 0-.7-2"/>',
  heading: '<path d="M6 4.5v15M18 4.5v15M6 12h12"/>',
  'text-style': '<path d="M3.4 19 8.6 5.4l5.2 13.6M5.4 14.2h6.4"/><circle cx="18.25" cy="16.1" r="2.75"/><path d="M21 13.35V19"/>',
  'list-ordered': '<path d="M10.5 6h10M10.5 12h10M10.5 18h10M4 4.5h1.5V9M3.8 9h3.4M4 14.4a1.5 1.5 0 0 1 2.9.6c0 1.1-3 1.9-3 3.5h3.1"/>',
  quote: '<path d="M20.5 6h-11M20.5 12h-11M20.5 18h-11M4 5.5v13"/>',
  code: '<path d="m8.5 7.5-5 4.5 5 4.5M15.5 7.5l5 4.5-5 4.5"/>',
  link: '<path d="M10 13.5a4 4 0 0 0 5.7.4l2.7-2.7a4 4 0 0 0-5.7-5.7l-1.5 1.5"/><path d="M14 10.5a4 4 0 0 0-5.7-.4l-2.7 2.7a4 4 0 0 0 5.7 5.7l1.5-1.5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="9.5" r="1.8"/><path d="m21 15.5-4.6-4.6a1.5 1.5 0 0 0-2.1 0L5 20"/>',

  // sync & AI
  cloud: '<path d="M7 18.5a4.6 4.6 0 0 1-.6-9.15 6.1 6.1 0 0 1 11.7 1.6A3.8 3.8 0 0 1 17.4 18.5z"/>',
  'cloud-off': '<path d="M9.2 5.2a6.1 6.1 0 0 1 8.9 5.75 3.8 3.8 0 0 1 2.2 5.65M16.6 18.5H7a4.6 4.6 0 0 1-1.6-8.9M3 3l18 18"/>',
  refresh: '<path d="M20.5 11.5A8.5 8.5 0 0 0 5.4 6.6M3.5 12.5a8.5 8.5 0 0 0 15.1 4.9"/><path d="M4.5 3v4.2h4.2M19.5 21v-4.2h-4.2"/>',
  // Photos
  heart: '<path d="M12 20.2S3.5 15.3 3.5 9.3A4.6 4.6 0 0 1 12 6.8a4.6 4.6 0 0 1 8.5 2.5c0 6-8.5 10.9-8.5 10.9z"/>',
  'heart-fill': '<path d="M12 20.2S3.5 15.3 3.5 9.3A4.6 4.6 0 0 1 12 6.8a4.6 4.6 0 0 1 8.5 2.5c0 6-8.5 10.9-8.5 10.9z" fill="currentColor"/>',
  photos: '<rect x="3" y="3" width="7.6" height="7.6" rx="2"/><rect x="13.4" y="3" width="7.6" height="7.6" rx="2"/><rect x="3" y="13.4" width="7.6" height="7.6" rx="2"/><rect x="13.4" y="13.4" width="7.6" height="7.6" rx="2"/>',
  albums: '<rect x="3" y="7" width="14" height="14" rx="3"/><path d="M7 3.5h10.5A3.5 3.5 0 0 1 21 7v10.5"/><path d="m3.5 18 4-4a1.5 1.5 0 0 1 2.1 0L17 21"/>',
  video: '<rect x="2.8" y="5.5" width="13.4" height="13" rx="3"/><path d="m16.2 10.4 4.1-2.5a.6.6 0 0 1 .9.5v7.2a.6.6 0 0 1-.9.5l-4.1-2.5"/>',
  play: '<path d="M7.5 4.9v14.2a1 1 0 0 0 1.5.86l11.6-7.1a1 1 0 0 0 0-1.72L9 4.04a1 1 0 0 0-1.5.86z" fill="currentColor"/>',
  'cloud-up': '<path d="M7 18.5a4.6 4.6 0 0 1-.6-9.15 6.1 6.1 0 0 1 11.7 1.6A3.8 3.8 0 0 1 17.4 18.5"/><path d="M12 19.5v-7M9.2 15l2.8-2.8 2.8 2.8"/>',
  'cloud-check': '<path d="M7 18.5a4.6 4.6 0 0 1-.6-9.15 6.1 6.1 0 0 1 11.7 1.6A3.8 3.8 0 0 1 17.4 18.5z"/><path d="m9.3 13.6 2 2 3.5-3.7"/>',
  memories: '<path d="M12 3.2v2.6M12 18.2v2.6M3.2 12h2.6M18.2 12h2.6M5.8 5.8l1.8 1.8M16.4 16.4l1.8 1.8M5.8 18.2l1.8-1.8M16.4 7.6l1.8-1.8"/><circle cx="12" cy="12" r="3.2"/>',
  'select-all': '<circle cx="12" cy="12" r="9.2"/><path d="m8 12.4 2.7 2.7 5.4-5.6"/>',
  zoom: '<circle cx="11" cy="11" r="6.8"/><path d="m20.2 20.2-4.4-4.4M11 8v6M8 11h6"/>',
  rotate: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9"/><path d="M4.5 4.5V9H9"/>',
  slideshow: '<rect x="3" y="4.5" width="18" height="12.5" rx="2.5"/><path d="m10.4 8.4 4.3 2.4-4.3 2.4z" fill="currentColor"/><path d="M8 20.5h8"/>',
  plug: '<path d="M9 2.8v4.7M15 2.8v4.7M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0zM12 16.5v4.7"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10.5" rx="3"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.75" r="1.6" fill="currentColor" stroke="none"/>',
  key: '<circle cx="8.05" cy="15.95" r="4.3"/><path d="m11.15 12.85 9.1-9.1M16.65 7.35l2.6 2.6M14.15 9.85l2 2"/>',
  power: '<path d="M12 3v8.5"/><path d="M17.4 6.3a8 8 0 1 1-10.8 0"/>',
};

// Old names of glyphs that were redrawn under a new name. A call site that still uses one draws the new glyph,
// so nothing shows the old art while call sites move over (sparkle was the AI sparkle, sun a sun for Tomorrow,
// target a bullseye for deadlines, hourglass, circle-slash a no-entry sign, bolt a lightning bolt for Quick note).
const RENAMED = { sparkle: 'ai', sun: 'tomorrow', target: 'deadline', hourglass: 'duration', 'circle-slash': 'no-date', bolt: 'quick-note' };
for (const [old, now] of Object.entries(RENAMED)) P[old] = P[now];

const has = (name) => Object.prototype.hasOwnProperty.call(P, name);

/**
 * A line icon as SVG markup, `size` px square. The line has an optical size, as in the notes editor's svgIcon():
 * 1.8 from 17px up, 2 at 15–16px and 2.2 at 14px and below, so a small glyph keeps the weight of a large one.
 * `stroke` overrides it (keycaps draw theirs at 2.2). An unknown name draws the circle.
 */
export function icon(name, { size = 20, cls = '', stroke } = {}) {
  const s = Number(size) || 20;
  const w = Number(stroke) || (s <= 14 ? 2.2 : s <= 16 ? 2 : 1.8);
  const c = String(cls).replace(/[^\w -]/g, '');
  return `<svg class="i ${c}" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${has(name) ? P[name] : P.circle}</svg>`;
}

export const hasIcon = (name) => has(name);
