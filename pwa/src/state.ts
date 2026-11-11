// The app's live state: the connection, every terminal, and each machine's spaces document.
import { useSyncExternalStore } from 'preact/compat';
import { Hc, HcError, type ConnState } from './hc.ts';
import {
  addSpace, addTab, applyEvent, asDoc, machineOf, newId, newTab, panes, qualify, removeSpace, removeTerminal, seenToWrite,
  type Doc, type HcEvent, type Space, type Terminals,
} from '../shared/model.ts';

export type Machine = { name: string; state: string; host?: string; why?: string | null };
export type Repo = { top: string; main: string; name: string; linked: boolean; branch: string | null };
export const repoKey = (machine: string, folder: string) => `${machine}\n${folder}`;
export type State = {
  repos: Record<string, Repo | null>; // by repoKey; null: not in git; missing: not looked at yet
  conn: ConnState;
  terminals: Terminals;
  docs: Record<string, { version: number; doc: Doc }>; // by machine; '' is this one
  machines: Machine[];
};

let state: State = { conn: 'closed', terminals: {}, docs: {}, machines: [], repos: {} };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };
export const getState = () => state;
export function useApp<T>(select: (s: State) => T): T {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => select(state));
}

const DOC = 'herdr-app';
export let hc: Hc;
export let token = '';
let seq = 0;

export function connect(t: string) {
  hc?.dispose();
  token = t;
  hc = new Hc(t, (conn) => { set({ conn }); if (conn === 'open') void sync(); });
  hc.connect();
}

async function sync() {
  try {
    // Subscribe before reading: documents changed while away are not replayed.
    const snap = await hc.subscribe(onMessage);
    seq = snap.seq;
    set({ terminals: Object.fromEntries(snap.terminals.map((t) => [t.address, t])) });
    await refresh();
  } catch (e) { console.warn('sync', e); }
}

async function refresh() {
  const { machines } = await hc.call<{ machines: Machine[] }>('machine.list');
  set({ machines });
  await Promise.all(['', ...machines.filter((m) => m.state === 'connected').map((m) => m.name)].map(fetchDoc));
}

async function fetchDoc(machine: string) {
  try {
    const r = await hc.call('doc.get', { name: DOC, ...(machine ? { on: machine } : {}) });
    set({ docs: { ...state.docs, [machine]: { version: r.version, doc: asDoc(r.value) } } });
    void loadRepos();
  } catch (e) { console.warn('doc', machine, e); }
}

function onMessage(m: { method: string; params: any }) {
  if (m.method === 'missed') {
    seq = m.params.seq;
    set({ terminals: Object.fromEntries(m.params.terminals.map((t: any) => [t.address, t])) });
    void refresh();
  } else if (m.method === 'event') {
    const ev = m.params as HcEvent;
    if (ev.seq <= seq) return;
    seq = ev.seq;
    if (ev.type === 'doc') { if (ev.data?.name === DOC) void fetchDoc(ev.machine ?? ''); return; }
    set({ terminals: applyEvent(state.terminals, ev) });
  }
}

/** The bridge's git helper (server/git.ts). Throws what git said. */
export async function git<T = any>(op: string, machine: string, folder: string, more: object = {}): Promise<T> {
  const res = await fetch('/api/git', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ op, machine, folder, ...more }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `git ${op} failed (${res.status})`);
  return body;
}

const asked = new Set<string>();
/** Finds the repo of every space's folder: worktree spaces nest under their repo's space. */
async function loadRepos() {
  for (const [machine, d] of Object.entries(state.docs)) for (const space of d.doc.spaces) {
    const key = repoKey(machine, space.folder);
    if (!space.folder || asked.has(key)) continue;
    asked.add(key);
    git<{ repo: Repo | null }>('repo', machine, space.folder)
      .then((r) => set({ repos: { ...state.repos, [key]: r.repo } }))
      .catch(() => asked.delete(key)); // try again with the next change
  }
}

/** Change a machine's spaces document. Retries when another client wrote first. */
export async function editDoc(machine: string, change: (doc: Doc) => Doc): Promise<void> {
  const on = machine ? { on: machine } : {};
  for (let attempt = 0; ; attempt++) {
    const got = await hc.call('doc.get', { name: DOC, ...on });
    const doc = change(asDoc(got.value));
    try {
      const r = await hc.call('doc.set', { name: DOC, ...on, version: got.version, value: doc });
      set({ docs: { ...state.docs, [machine]: { version: r.version ?? got.version + 1, doc } } });
      void loadRepos();
      return;
    } catch (e) {
      if (!(e instanceof HcError && e.kind === 'conflict') || attempt >= 4) throw e;
    }
  }
}

// The desktop app's remote launch (herdr-app src/remote_shell.rs): the program in that machine's
// own login shell, which stays when the program exits.
const POSIX = '"$@"; exec "$0" -li', FISH = 'command $argv[2..]; exec $argv[1] -li', OTHER = '"$@"; exec "${SHELL:-sh}" -i';
const q = (s: string) => s.replace(/'/g, `'\\''`);
const LAUNCH = `shell=\${SHELL:-/bin/sh}
case "\${shell##*/}" in
  fish) exec "$shell" -lic '${q(FISH)}' "$shell" "$@" ;;
  sh|bash|zsh|dash|ksh) exec "$shell" -lic '${q(POSIX)}' "$shell" "$@" ;;
  *) exec sh -c '${q(OTHER)}' sh "$@" ;;
esac`;
export const PROGRAMS: Record<string, { name: string; run: string[] }> = {
  shell: { name: 'Shell', run: [] },
  claude: { name: 'Claude Code', run: ['claude'] },
};

async function run(machine: string, cwd: string, program: string, space: Space, tabId: string, tabName: string): Promise<string> {
  const cmd = PROGRAMS[program].run;
  const r = await hc.call('terminal.run', {
    argv: cmd.length ? ['sh', '-c', LAUNCH, 'sh', ...cmd] : [],
    cwd, keep: true, ...(machine ? { on: machine } : {}),
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'herdr' },
    labels: { 'herdr.space': space.id, 'herdr.tab': tabId, 'herdr.seen': '0', where: `${space.name} / ${tabName || 'tab'}` },
    size: { cols: 80, rows: 24 },
  });
  return r.address as string;
}

/** A new tab with one terminal. Returns the terminal's address. */
export async function createTab(machine: string, space: Space, program: string, name = ''): Promise<string> {
  const tab = newId('tb'), pane = newId('p');
  const address = await run(machine, space.folder, program, space, tab, name);
  // The document holds addresses as the machine itself knows them.
  const local = machineOf(address) === machine && machine ? address.slice(machine.length + 1) : address;
  await editDoc(machine, (doc) => addTab(doc, space.id, newTab(tab, name, pane, local)));
  return qualify(local, machine);
}

/** A new space on a folder, with a first tab. Returns that tab's terminal address. */
export async function createSpace(machine: string, name: string, folder: string, program: string): Promise<string> {
  const space: Space = { id: newId('sp'), name, folder, tabs: [] };
  await editDoc(machine, (doc) => addSpace(doc, space));
  return createTab(machine, space, program);
}

/** Ends a terminal (when it still runs) and takes its pane out of the document. */
export async function closeTerminal(machine: string, local: string) {
  const address = qualify(local, machine);
  const t = state.terminals[address];
  if (t?.state === 'live') await hc.call('terminal.kill', { terminal: address }).catch(() => {});
  await editDoc(machine, (doc) => removeTerminal(doc, local));
  if (state.terminals[address]) await hc.call('terminal.rm', { terminal: address }).catch(() => {});
}

export async function deleteSpace(machine: string, space: Space) {
  for (const tab of space.tabs) for (const pane of panes(tab.root)) {
    await hc.call('terminal.kill', { terminal: qualify(pane.terminal, machine) }).catch(() => {});
    await hc.call('terminal.rm', { terminal: qualify(pane.terminal, machine) }).catch(() => {});
  }
  await editDoc(machine, (doc) => removeSpace(doc, space.id));
}

/** A checkout of `branch` in its own space, as the desktop app makes them. Returns the first terminal's address. */
export async function createWorktree(machine: string, space: Space, branch: string, program: string): Promise<string> {
  const { path } = await git<{ path: string }>('worktree-add', machine, space.folder, { branch });
  // Unnamed, so it is shown by its folder and nests under the repo's space.
  return createSpace(machine, '', path, program);
}

/** Closes a worktree's space and removes the checkout. `force`: lose its uncommitted work. */
export async function removeWorktree(machine: string, space: Space, force: boolean) {
  await deleteSpace(machine, space); // terminals first: a shell sitting in the folder keeps it busy
  await git('worktree-remove', machine, space.folder, { force });
  asked.delete(repoKey(machine, space.folder));
}

/** A person is looking at this terminal: tell the other herdr clients (docs/labels.md). */
export function markSeen(address: string) {
  const t = state.terminals[address];
  if (!t || t.state !== 'live' || document.visibilityState !== 'visible') return;
  const seen = seenToWrite(t);
  if (seen !== null) void hc.call('terminal.label', { terminal: address, labels: { 'herdr.seen': seen } }).catch(() => {});
}
