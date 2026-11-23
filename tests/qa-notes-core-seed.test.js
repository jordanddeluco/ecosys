// QA fix (notes-core, second pass): the sample Welcome note, the first note a new user sees, contradicted
// the app. Its checked item came first although "Move checked items to the bottom" is on by default
// (the app moves it down as soon as the note is touched), and it said "Share > Download .md", a menu
// item that doesn't exist, written with ">" as a breadcrumb.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleNotesAndFolders } from '../notes/core/seed.js';
import { blockText } from '../notes/core/schema.js';

const welcome = () => sampleNotesAndFolders('2026-11-23').notes.find((n) => n.title === 'Welcome to Notes');

test('the Welcome checklist already has its checked item at the bottom, as the app keeps it', () => {
  const checks = welcome().blocks.filter((b) => b.t === 'check');
  assert.ok(checks.length >= 3);
  const firstDone = checks.findIndex((b) => b.ck);
  assert.ok(firstDone > 0, 'an unchecked item comes first');
  assert.ok(checks.slice(firstDone).every((b) => b.ck), `checked items last: ${checks.map((b) => `${b.ck ? 'x' : ' '} ${blockText(b)}`).join(' | ')}`);
});

test('the Welcome note names the export as the Share menu names it, in plain words', () => {
  const text = welcome().blocks.map(blockText).join('\n');
  assert.match(text, /Download as Markdown/);
  assert.match(text, /Share menu/);
  assert.doesNotMatch(text, / > |Download \.md/);
});
