// QA guard (notes-core, FUZZ_SEED=977 of the notes-core fuzz): a piece split off a block by a tag
// rewrite never takes another block's id, and the blocks that were there keep theirs (task.source
// and note links point at them). Fixed in notes/core/schema.js before this round (rewriteTags gives
// new pieces ids no block has); this pins it, as the late-integration request asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../notes/core/schema.js';

test('renaming a tag that splits a long block never reuses another block id', () => {
  const long = 'x '.repeat(9994) + '#a'; // 19,990 characters: the longer tag name pushes it past 20,000
  const blocks = S.validateBlocks([{ id: 'b10', t: 'p', c: [[long]] }, { id: 'b10-1', t: 'p', c: [['Another block']] }]);
  const { blocks: out } = S.renameTagInBlocks(blocks, 'a', 'abcdefghijklmnopqrstuvwxyz');
  const ids = out.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length, ids.join());
  assert.deepEqual([ids[0], ids.at(-1)], ['b10', 'b10-1'], 'existing blocks keep their ids');
  assert.equal(JSON.stringify(S.validateBlocks(out)), JSON.stringify(out));
  assert.equal(S.blockText(out.at(-1)), 'Another block');
  assert.ok(S.blockText(out.at(-2)).endsWith('#abcdefghijklmnopqrstuvwxyz'), 'the renamed tag is in the last piece');
});
