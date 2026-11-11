// Against real git through the real hc (machine.exec), in a throwaway repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitError, addWorktree, changes, checkouts, dirty, removeWorktree, repoOf, slug } from './git.ts';

test('repo, worktrees and changes', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-')));
  const repo = path.join(dir, 'proj');
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, stdio: 'pipe' }).toString();
  let made = '';
  try {
    fs.mkdirSync(repo);
    assert.equal(await repoOf(repo), null);
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git('add', '.'); git('commit', '-qm', 'first');
    assert.deepEqual(await repoOf(repo), { top: repo, main: repo, name: 'proj', linked: false, branch: 'main' });

    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    fs.writeFileSync(path.join(repo, 'new file.txt'), 'fresh\n');
    const c = await changes(repo, 'head');
    assert.match(c.patch, /-one\n\+two/);
    assert.match(c.patch, /new file\.txt[\s\S]*\+fresh/); // untracked files are shown too
    assert.equal(await dirty(repo), true);

    await assert.rejects(addWorktree(repo, '--force'), GitError);
    await assert.rejects(addWorktree(repo, '  '), GitError);
    assert.equal(slug('feat/x y'), 'feat-x-y');
    made = await addWorktree(repo, 'feat/x');
    assert.equal(made, path.join(os.homedir(), '.herdr/worktrees/proj/feat-x'));
    const wt = await repoOf(made);
    assert.deepEqual([wt!.main, wt!.linked, wt!.branch], [repo, true, 'feat/x']);
    assert.deepEqual((await checkouts(wt!)).map((x) => [x.branch, x.main]), [['main', true], ['feat/x', false]]);

    fs.writeFileSync(path.join(made, 'b.txt'), 'b\n');
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: made });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'second'], { cwd: made });
    const b = await changes(made, 'branch');
    assert.equal(b.base, 'since main');
    assert.match(b.patch, /b\.txt[\s\S]*\+b/);
    assert.equal((await changes(made, 'head')).patch, '');

    await assert.rejects(removeWorktree(repo, false), /main checkout/);
    fs.writeFileSync(path.join(made, 'c.txt'), 'c\n');
    await assert.rejects(removeWorktree(made, false), GitError); // git refuses to lose work
    await removeWorktree(made, true);
    assert.equal(fs.existsSync(made), false);
    made = '';
  } finally {
    if (made) fs.rmSync(made, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    try { fs.rmdirSync(path.join(os.homedir(), '.herdr/worktrees/proj')); } catch {}
  }
});
