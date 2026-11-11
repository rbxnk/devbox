import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePatch } from '../shared/patch.ts';

test('a patch splits into files with counts', () => {
  const files = parsePatch([
    'diff --git a/src/a b.ts b/src/a b.ts', 'index 1..2 100644', '--- a/src/a b.ts', '+++ b/src/a b.ts',
    '@@ -1,2 +1,2 @@ fn', ' same', '-old', '+new', '\\ No newline at end of file',
    'diff --git a/new.txt b/new.txt', 'new file mode 100644', '--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1 @@', '+++ not a header',
    'diff --git a/gone.txt b/gone.txt', 'deleted file mode 100644', '--- a/gone.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye',
    'diff --git a/pic.png b/pic.png', 'Binary files a/pic.png and b/pic.png differ', '',
  ].join('\n'));
  assert.deepEqual(files.map((f) => [f.path, f.added, f.removed, f.binary]), [
    ['src/a b.ts', 1, 1, false], ['new.txt', 1, 0, false], ['gone.txt', 0, 1, false], ['pic.png', 0, 0, true],
  ]);
  assert.deepEqual(files[0].lines.map((l) => l.kind), ['hunk', 'ctx', 'del', 'add', 'meta']);
  assert.equal(files[1].lines[1].text, '++ not a header');
  assert.deepEqual(parsePatch(''), []);
});
