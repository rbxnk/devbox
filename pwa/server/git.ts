// Git for spaces: which repo a folder is in, its worktrees, and its changes. Commands and paths
// follow the desktop app (herdr-app defaults/mods/worktree and changes), so both make the same checkouts.
// Every argv here is fixed; only folder, branch and path values come from the caller, never as options.
import { exec, type Ran } from './core.ts';

const READ = ['--no-optional-locks', '-c', 'core.fsmonitor=false'];
const MAX_PATCH = 3 << 20;

export class GitError extends Error {}
const must = (r: Ran, what: string) => { if (!r.ok) throw new GitError(r.err.trim() || r.out.trim() || `${what} failed.`); return r.out.trim(); };

export type Repo = { top: string; main: string; name: string; linked: boolean; branch: string | null };

/** The repo a folder belongs to: its main checkout and name, and whether the folder is a linked worktree. Null outside git. */
export async function repoOf(folder: string, on?: string): Promise<Repo | null> {
  const git = (args: string[]) => exec(['git', ...READ, ...args], { cwd: folder, on });
  const [top, common, branch] = await Promise.all([
    git(['rev-parse', '--show-toplevel']), git(['rev-parse', '--path-format=absolute', '--git-common-dir']), git(['symbolic-ref', '--short', '-q', 'HEAD']),
  ]);
  if (!top.ok || !common.ok) return null;
  const c = common.out.trim(), t = top.out.trim();
  const main = c.endsWith('/.git') ? c.slice(0, -5) : c;
  return { top: t, main, name: main.split('/').pop() || 'repo', linked: main !== t, branch: branch.ok ? branch.out.trim() : null };
}

export type Checkout = { path: string; branch: string | null; main: boolean };

/** Every checkout of the repo, the main one first. */
export async function checkouts(repo: Repo, on?: string): Promise<Checkout[]> {
  const list = must(await exec(['git', ...READ, 'worktree', 'list', '--porcelain'], { cwd: repo.main, on }), 'git worktree list');
  const out: Checkout[] = [];
  for (const block of list.split(/\n\n+/)) {
    const lines = block.split('\n');
    const path = lines.find((l) => l.startsWith('worktree '))?.slice(9);
    if (!path || lines.some((l) => l === 'bare' || l.startsWith('prunable'))) continue;
    out.push({ path, branch: lines.find((l) => l.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') ?? null, main: out.length === 0 });
  }
  return out;
}

export const slug = (branch: string) => branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

async function home(on?: string): Promise<string> {
  const r = await exec(['sh', '-c', 'printf %s "$HOME"'], { on });
  if (!r.ok || !r.out.trim()) throw new GitError('Could not find the home folder.');
  return r.out.trim();
}

/** A checkout of `branch` (made from HEAD when new) at ~/.herdr/worktrees/<repo>/<branch>. Returns its path. */
export async function addWorktree(folder: string, branch: string, on?: string): Promise<string> {
  branch = branch.trim();
  // A leading dash would be read as an option; git rejects the rest of what makes a bad name.
  if (!branch || branch.startsWith('-') || !slug(branch)) throw new GitError('Type a branch name.');
  const repo = await repoOf(folder, on);
  if (!repo) throw new GitError('This folder is not in a git repository.');
  const path = `${await home(on)}/.herdr/worktrees/${repo.name}/${slug(branch)}`;
  const exists = (await exec(['git', 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo.main, on })).ok;
  const add = exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, 'HEAD'];
  must(await exec(['git', ...add], { cwd: repo.top, on, timeout: 600 }), 'git worktree add');
  return path;
}

/** Whether a linked worktree has uncommitted work that removing it would lose. */
export async function dirty(folder: string, on?: string): Promise<boolean> {
  return must(await exec(['git', ...READ, 'status', '--porcelain'], { cwd: folder, on }), 'git status') !== '';
}

/** Removes a linked worktree; `force` when it has uncommitted work the person agreed to lose. */
export async function removeWorktree(folder: string, force: boolean, on?: string): Promise<void> {
  const repo = await repoOf(folder, on);
  if (!repo) throw new GitError('This folder is not in a git repository.');
  if (!repo.linked) throw new GitError("This is the repository's main checkout, not a worktree.");
  must(await exec(['git', 'worktree', 'remove', ...(force ? ['--force'] : []), repo.top], { cwd: repo.main, on, timeout: 600 }), 'git worktree remove');
}

export type Changes = { base: string; patch: string; truncated: boolean };

/**
 * A folder's changes as one patch. `head`: everything not committed, new files included.
 * `branch`: everything on this branch since it left the repository's default branch.
 */
export async function changes(folder: string, mode: 'head' | 'branch', on?: string): Promise<Changes> {
  const repo = await repoOf(folder, on);
  if (!repo) throw new GitError('This folder is not in a git repository.');
  const git = (args: string[]) => exec(['git', ...READ, ...args], { cwd: repo.top, on });
  const DIFF = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];
  let base: string, patch: string;
  if (mode === 'branch') {
    const remote = await git(['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']);
    const candidates = [...(remote.ok ? [remote.out.trim()] : []), 'origin/main', 'origin/master', 'main', 'master'];
    let trunk = '';
    for (const c of candidates) if ((await git(['rev-parse', '--verify', '--quiet', `${c}^{commit}`])).ok) { trunk = c; break; }
    if (!trunk) throw new GitError('No default branch (main or master) to compare with.');
    const fork = must(await git(['merge-base', 'HEAD', trunk]), 'git merge-base');
    base = `since ${trunk}`;
    patch = must(await git(['diff', ...DIFF, fork, 'HEAD']), 'git diff');
  } else {
    const head = (await git(['rev-parse', '--verify', '--quiet', 'HEAD'])).ok;
    base = 'not committed';
    patch = must(await git(['diff', ...DIFF, ...(head ? ['HEAD'] : ['--cached'])]), 'git diff');
    // New files are not in a diff against HEAD: show each as an addition.
    const status = must(await git(['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all']), 'git status');
    const fresh = status.split('\0').filter((e) => e.startsWith('?? ')).map((e) => e.slice(3)).slice(0, 100);
    for (const file of fresh) {
      if (patch.length > MAX_PATCH) break;
      const r = await git(['diff', ...DIFF, '--no-index', '--', '/dev/null', file]); // exits 1 when they differ, which they do
      if (r.out) patch += (patch && !patch.endsWith('\n') ? '\n' : '') + r.out;
    }
  }
  const truncated = patch.length > MAX_PATCH;
  return { base, patch: truncated ? patch.slice(0, MAX_PATCH) : patch, truncated };
}
