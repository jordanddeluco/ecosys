// ecosys bootstrap. A classic (non-module) script loaded from <head> on every page, so it runs before
// first paint and before any app module, without any inline script (the Content-Security-Policy
// forbids those). Three jobs:
//  1. Pairing: the link ecosys prints where it runs, http://127.0.0.1:PORT/#pair=<secret>, connects
//     this browser to it. The secret is taken out of the address bar before any app router reads the
//     hash (keeping a route after it: "#pair=…&/today" → "#/today"), and kept for every page of this
//     origin under ecosys:v1:pair. shared/pair.js reads it from there (and handles a link opened in a
//     page that is already showing; the two follow the same rules).
//  2. Framing: under the local server, headers forbid any page framing ecosys. A static copy (GitHub
//     Pages) can't send them, so a page that finds itself framed by another site hides itself (hidden
//     content can't be clicked through) and tries to take the whole window instead.
//  3. Theme: the cached settings' theme applies before first paint; shell.js's applyTheme() takes
//     over once the app loads.
(function () {
  var root = document.documentElement;

  try {
    var hash = window.location.hash || '';
    var m = /(^#|&)pair=([A-Za-z0-9_-]{20,200})(?=$|[&\/#?])/.exec(hash);
    if (m) {
      try {
        window.localStorage.setItem('ecosys:v1:pair', m[2]);
      } catch (e) {} // storage blocked: this browser can't stay connected, but the link still leaves the address bar
      var rest = hash.slice(0, m.index) + (m[1] === '&' ? '' : '#') + hash.slice(m.index + m[0].length);
      rest = rest.replace(/^#&+/, '#').replace(/&&+/g, '&').replace(/&$/, '');
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + (rest === '#' ? '' : rest));
    }
  } catch (e) {}

  var framed = false;
  try {
    framed = window.top !== window.self && window.top.location.origin !== window.location.origin;
  } catch (e) {
    framed = true; // reading another origin's location throws
  }
  if (framed) {
    root.style.visibility = 'hidden';
    try {
      window.top.location.href = window.location.href;
    } catch (e) {} // browsers may refuse a framed page that navigation; it stays hidden then
  }

  var s = null;
  try {
    s = JSON.parse(window.localStorage.getItem('ecosys:v1:settings') || 'null');
  } catch (e) {
    s = null;
  }
  if (!s || typeof s !== 'object') s = {};
  var pick = function (value, allowed, fallback) {
    return typeof value === 'string' && allowed.indexOf(value) >= 0 ? value : fallback;
  };
  var theme = pick(s.theme, ['system', 'light', 'dim', 'dark'], 'system');
  if (theme === 'system') {
    try {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) {
      theme = 'light';
    }
  }
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-accent', pick(s.accent, ['iris', 'blue', 'violet', 'pink', 'orange', 'green', 'yellow'], 'iris'));
  root.setAttribute('data-reduce-motion', s.reduceMotion === true ? 'true' : 'false');
})();
