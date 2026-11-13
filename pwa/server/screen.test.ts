import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeInput, claudeSuggestion } from '../shared/screen.ts';

const R = '─'.repeat(40);
test('the suggested prompt is read from the input box only', () => {
  assert.equal(claudeSuggestion(`● Done.\n${R}\n❯ run it\n${R}\n  ? for shortcuts`), 'run it');
  assert.equal(claudeSuggestion(`${R}\n❯ commit this and\n  push it\n${R}\n`), 'commit this and push it');
  assert.equal(claudeSuggestion(`${R}\n❯ \n${R}\n`), null); // empty box
  assert.equal(claudeSuggestion(`❯ earlier prompt in the scrollback\n\n● answer\n${R}\n❯ \n${R}`), null);
  assert.equal(claudeSuggestion(` Do you want to proceed?\n ❯ 1. Yes\n   2. No\n`), null); // a dialog, not the box
  assert.equal(claudeSuggestion(`${R}\n❯\u00a0run it\n${R}`), 'run it'); // what Claude Code really writes
  assert.equal(claudeSuggestion(`${R}\n❯ old\n${R}\n● x\n${R}\n❯\n${R}`), null); // the box is empty: don't reach back
  assert.equal(claudeSuggestion(''), null);
});

test('a picker or dialog in place of the input box reads as no box', () => {
  assert.equal(claudeInput(`${R}\n❯ \n${R}\n  ⏵⏵ auto mode on`), ''); // an empty box is still a box
  // /resume's picker, as Claude Code 2.1 draws it.
  assert.equal(claudeInput(`● answer\n${'▔'.repeat(40)}\n   Resume session\n   ╭────\n   │ ⌕ Search…\n   ╰────\n     devbox\n   ❯ PWA iterative redeploy setup\n     8 seconds ago · main\n     Esc to cancel`), null);
  assert.equal(claudeInput(` Do you want to proceed?\n ❯ 1. Yes\n   2. No\n`), null);
});
