// QA fix round (schedule, completeness): links in an event's description and place, and in a task's notes,
// are clickable in Schedule's cards (schedule/links.js linkify), as in Google and Apple Calendar: a Zoom link,
// an e-mail address, Notes' "Copy link" (a same-origin URL) or a path to an app. Every href passes the shared
// allowlist (shared/sanitize.js cleanHref); the text is escaped; other sites open in a new tab with
// rel="noopener noreferrer"; nothing pasted can make it slow. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { linkify } = await import('../schedule/links.js');

const O = { base: '/', origin: 'http://127.0.0.1:4300' };
const ext = (href, text = href) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
const own = (href, text = href) => `<a href="${href}">${text}</a>`;

test('web and e-mail addresses become links; the rest is escaped text', () => {
  assert.equal(linkify('Join: https://zoom.us/j/123456 and see you there', O), `Join: ${ext('https://zoom.us/j/123456')} and see you there`);
  assert.equal(linkify('Join:https://zoom.us/j/1', O), `Join:${ext('https://zoom.us/j/1')}`, 'a link right after a colon');
  assert.equal(linkify('www.example.com/agenda', O), ext('https://www.example.com/agenda', 'www.example.com/agenda'), '"www." is read as https');
  assert.equal(linkify('mail jane.doe+cal@example.co.uk today', O), `mail <a href="mailto:jane.doe+cal@example.co.uk">jane.doe+cal@example.co.uk</a> today`, 'e-mail addresses open the mail app, in place');
  assert.equal(linkify('mailto:team@example.com', O), '<a href="mailto:team@example.com">mailto:team@example.com</a>');
  assert.equal(linkify('Plain words, no links: 3 < 4 & "quotes"', O), 'Plain words, no links: 3 &lt; 4 &amp; &quot;quotes&quot;');
  assert.equal(linkify('', O), '');
  assert.equal(linkify(null, O), '');
  assert.equal(linkify('line one\nhttps://a.example/x\n\tend', O), `line one\n${ext('https://a.example/x')}\n\tend`, 'line breaks and tabs are kept (the card shows them)');
});

test('punctuation around a link stays outside it; a bracket it opened stays inside', () => {
  assert.equal(linkify('See https://example.com/a.', O), `See ${ext('https://example.com/a')}.`);
  assert.equal(linkify('(https://example.com/a)', O), `(${ext('https://example.com/a')})`);
  assert.equal(linkify('https://en.wikipedia.org/wiki/Ecosys_(app)', O), ext('https://en.wikipedia.org/wiki/Ecosys_(app)'));
  assert.equal(linkify('“https://example.com/q?a=1&b=2”,', O), `“${ext('https://example.com/q?a=1&amp;b=2')}”,`);
  assert.equal(linkify('<https://example.com>', O), `&lt;${ext('https://example.com')}&gt;`);
});

test('links to ecosys (Notes’ Copy link, app paths) open in place; app paths follow the apps’ root', () => {
  const copy = 'http://127.0.0.1:4300/notes/#/n/n_abc123';
  assert.equal(linkify(`Notes: ${copy}`, O), `Notes: ${own(copy)}`, 'the same origin is another ecosys app: no new tab');
  assert.equal(linkify('/notes/#/n/n_abc123', O), own('/notes/#/n/n_abc123'));
  assert.equal(linkify('../tasks/#/task/t1', O), own('/tasks/#/task/t1', '../tasks/#/task/t1'));
  assert.equal(linkify('/schedule/#/day/2026-11-24', { base: '/ecosys/', origin: 'https://me.github.io' }), own('/ecosys/schedule/#/day/2026-11-24', '/schedule/#/day/2026-11-24'), 'GitHub Pages serves the apps under a path');
  assert.equal(linkify('/etc/passwd /notes/x /home/#/', O), '/etc/passwd /notes/x /home/#/', 'other paths are only text');
});

test('only allowed schemes become links, and an href can never break out of its attribute', () => {
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'file:///c:/x', 'ftp://example.com', 'https://', 'http:///nohost', 'mailto:']) {
    const html = linkify(`x ${bad} y`, O);
    assert.doesNotMatch(html, /<a /, `${bad} stays text: ${html}`);
    assert.doesNotMatch(html, /<script/i);
  }
  const html = linkify('https://example.com/"onmouseover="alert(1) https://example.com/a\'b', O);
  assert.doesNotMatch(html, /"onmouseover=/, 'a quote in a link is escaped: it can never close the attribute');
  for (const m of html.matchAll(/href="([^"]*)"/g)) assert.doesNotMatch(m[1], /["<>]/);
  assert.equal(linkify(`https://example.com/${'a'.repeat(3000)}`, O).includes('<a '), false, 'a link longer than the allowlist takes stays text');
});

test('linear time: a long paste without spaces, or with many look-alikes, links in a blink', () => {
  const nasty = [
    'a'.repeat(200000), // one 200k "word"
    'a.'.repeat(100000), // dots: an e-mail look-alike that never gets its @
    `${'a@b.'.repeat(50000)}c`,
    `${'('.repeat(1000)}https://example.com/${')'.repeat(1000)}`,
    'www.'.repeat(50000),
    'x https://e.com/ '.repeat(20000),
  ];
  for (const s of nasty) {
    const t = Date.now();
    linkify(s, O);
    const ms = Date.now() - t;
    assert.ok(ms < 1500, `${s.slice(0, 12)}… (${s.length} chars) took ${ms} ms`);
  }
});
