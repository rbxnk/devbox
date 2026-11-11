import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { panes, placed, qualify, shown, type Shown, type Space, type Tab, type Terminal } from '../shared/model.ts';
import { PROGRAMS, closeTerminal, connect, createSpace, createTab, createWorktree, deleteSpace, git, hc, markSeen, removeWorktree, repoKey, useApp, type Repo } from './state.ts';
import { TerminalView } from './terminal.tsx';
import { ChatView } from './chat.tsx';
import { ChangesView } from './changes.tsx';
import { FileSheet } from './file.tsx';
import { PushToggle } from './push.tsx';

const TOKEN = 'herdr-pwa-token';
const stored = () => { try { return localStorage.getItem(TOKEN) ?? ''; } catch { return ''; } };

// The route is the terminal on screen: #/t/<address>.
const readRoute = () => (location.hash.startsWith('#/t/') ? decodeURIComponent(location.hash.slice(4)) : null);
export const go = (address: string | null) => { location.hash = address ? `#/t/${encodeURIComponent(address)}` : '#/'; };

function useRoute() {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const on = () => setRoute(readRoute());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
}

const WORDS: Record<Shown, string> = {
  blocked: 'Needs you', error: 'Error', working: 'Working', done: 'Done', idle: 'Idle', ended: 'Ended', none: '',
};

export function Dot({ t }: { t: Terminal | undefined }) {
  const s = shown(t);
  return <span class={`dot dot-${s}`} role="img" aria-label={WORDS[s] || 'Terminal'} />;
}

/** A space's name; unnamed ones (worktrees) go by their folder. */
export const spaceName = (s: Space) => s.name || s.folder.split('/').filter(Boolean).pop() || '~';

export const titleOf = (t: Terminal | undefined, tab?: Tab) =>
  tab?.name || t?.title || t?.foreground?.name || t?.address || 'terminal';

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} class="sheet" onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}

/** Runs an action, showing its failure instead of losing it. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  };
  return { busy, error, run };
}

function TokenGate({ denied }: { denied: boolean }) {
  const [value, setValue] = useState('');
  return (
    <form class="gate" onSubmit={(e) => {
      e.preventDefault();
      const t = value.trim();
      if (!t) return;
      try { localStorage.setItem(TOKEN, t); } catch {}
      connect(t);
    }}>
      <h1>herdr</h1>
      <label for="token">Bridge token</label>
      <input id="token" type="password" autocomplete="current-password" value={value} onInput={(e) => setValue(e.currentTarget.value)} />
      {denied && <p class="error" role="alert">That token was not accepted.</p>}
      <p class="hint">On the box: <code>cat ~/.config/herdr-pwa/token</code></p>
      <button class="primary" type="submit">Connect</button>
    </form>
  );
}

function NewSpace({ machine, onClose }: { machine: string; onClose: () => void }) {
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [program, setProgram] = useState('shell');
  const a = useAction();
  return (
    <Sheet title="New space" onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        const f = folder.trim();
        if (await a.run(async () => go(await createSpace(machine, name.trim() || f.split('/').filter(Boolean).pop() || '~', f, program)))) onClose();
      }}>
        <label for="ns-folder">Folder</label>
        <input id="ns-folder" required placeholder="/home/dev/code/project" autocapitalize="off" autocorrect="off" value={folder} onInput={(e) => setFolder(e.currentTarget.value)} />
        <label for="ns-name">Name</label>
        <input id="ns-name" placeholder="the folder's name" value={name} onInput={(e) => setName(e.currentTarget.value)} />
        <ProgramPick value={program} onChange={setProgram} />
        {a.error && <p class="error" role="alert">{a.error}</p>}
        <button class="primary" type="submit" disabled={a.busy}>Create</button>
      </form>
    </Sheet>
  );
}

function ProgramPick({ value, onChange }: { value: string; onChange: (p: string) => void }) {
  return (
    <fieldset class="pick">
      <legend>Start with</legend>
      {Object.entries(PROGRAMS).map(([id, p]) => (
        <label key={id}><input type="radio" name="program" checked={value === id} onChange={() => onChange(id)} /> {p.name}</label>
      ))}
    </fieldset>
  );
}

function SpaceMenu({ machine, space, repo, onClose }: { machine: string; space: Space; repo: Repo | null | undefined; onClose: () => void }) {
  const a = useAction();
  const [confirm, setConfirm] = useState<'space' | 'worktree' | 'dirty' | null>(null);
  const [branching, setBranching] = useState(false);
  const [branch, setBranch] = useState('');
  const [program, setProgram] = useState('claude');
  const open = (p: string) => a.run(async () => { go(await createTab(machine, space, p)); onClose(); });
  const tabs = `${space.tabs.length} tab${space.tabs.length === 1 ? '' : 's'}`;
  const remove = (force: boolean) => a.run(async () => {
    if (!force && (await git<{ dirty: boolean }>('dirty', machine, space.folder)).dirty) { setConfirm('dirty'); return; }
    await removeWorktree(machine, space, force);
    go(null); onClose();
  });
  return (
    <Sheet title={spaceName(space)} onClose={onClose}>
      <p class="hint">{space.folder}{repo?.branch ? ` · ${repo.branch}` : ''}</p>
      {branching ? (
        <form onSubmit={async (e) => {
          e.preventDefault();
          if (await a.run(async () => go(await createWorktree(machine, space, branch, program)))) onClose();
        }}>
          <label for="wt-branch">Branch for the new worktree</label>
          <input id="wt-branch" required autocapitalize="off" autocorrect="off" spellcheck={false} placeholder="feature/name" value={branch} onInput={(e) => setBranch(e.currentTarget.value)} />
          <p class="hint">An existing branch is checked out; a new one starts from here. It goes in ~/.herdr/worktrees/{repo?.name}.</p>
          <ProgramPick value={program} onChange={setProgram} />
          <button class="primary" type="submit" disabled={a.busy}>{a.busy ? 'Creating…' : 'Create worktree'}</button>
        </form>
      ) : (
        <>
          {Object.entries(PROGRAMS).map(([id, p]) => (
            <button key={id} class="row-button" disabled={a.busy} onClick={() => open(id)}>New {p.name} tab</button>
          ))}
          {/* Only a folder in a git repository can have worktrees. */}
          {repo && <button class="row-button" disabled={a.busy} onClick={() => setBranching(true)}>New worktree…</button>}
          {repo?.linked && (confirm === 'dirty'
            ? <button class="row-button danger" disabled={a.busy} onClick={() => remove(true)}>It has uncommitted changes. Remove it and lose them</button>
            : confirm === 'worktree'
              ? <button class="row-button danger" disabled={a.busy} onClick={() => remove(false)}>Really close {tabs} and delete this checkout</button>
              : <button class="row-button danger" onClick={() => setConfirm('worktree')}>Remove worktree…</button>)}
          {!repo?.linked && (confirm === 'space'
            ? <button class="row-button danger" disabled={a.busy} onClick={async () => { if (await a.run(() => deleteSpace(machine, space))) { go(null); onClose(); } }}>
                Really close {tabs} and remove the space
              </button>
            : <button class="row-button danger" onClick={() => setConfirm('space')}>Remove space…</button>)}
        </>
      )}
      {a.error && <p class="error" role="alert">{a.error}</p>}
    </Sheet>
  );
}

/** Spaces in order, each worktree's space moved under its repo's space (the nesting comes from git, nothing is stored). */
export function nest(spaces: Space[], repoOf: (s: Space) => Repo | null | undefined): { space: Space; nested: boolean }[] {
  const parent = (s: Space) => {
    const r = repoOf(s);
    return r?.linked ? spaces.find((p) => p !== s && repoOf(p)?.top === r.main) : undefined;
  };
  return spaces.filter((s) => !parent(s)).flatMap((s) => [
    { space: s, nested: false },
    ...spaces.filter((c) => parent(c) === s).map((c) => ({ space: c, nested: true })),
  ]);
}

function Sidebar({ current }: { current: string | null }) {
  const { docs, terminals, machines, conn, repos } = useApp((s) => s);
  const [menu, setMenu] = useState<{ machine: string; space: Space } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const names = ['', ...machines.map((m) => m.name)];
  const inDocs = new Set(Object.entries(docs).flatMap(([m, d]) => [...placed(d.doc)].map((t) => qualify(t, m))));
  const loose = Object.values(terminals).filter((t) => t.state === 'live' && !inDocs.has(t.address));

  const row = (address: string, tab?: Tab) => {
    const t = terminals[address];
    return (
      <li key={address}>
        <a class="item" href={`#/t/${encodeURIComponent(address)}`} aria-current={current === address ? 'page' : undefined}>
          <Dot t={t} />
          <span class="item-text">
            <span class="item-title">{titleOf(t, tab)}</span>
            <span class="item-sub">{t?.status?.msg || WORDS[shown(t)] || t?.foreground?.name || ''}</span>
          </span>
        </a>
      </li>
    );
  };

  return (
    <aside class="side">
      <header class="side-head">
        <h1>herdr</h1>
        {conn !== 'open' && <span class="conn" role="status">{conn === 'connecting' ? 'Connecting…' : 'Offline'}</span>}
      </header>
      <nav aria-label="Spaces">
        {names.map((machine) => {
          const doc = docs[machine]?.doc;
          const m = machines.find((x) => x.name === machine);
          return (
            <section key={machine}>
              {(machine || machines.length > 0) && (
                <h2 class="machine">{machine || 'This machine'}{m && m.state !== 'connected' && <span class="conn"> {m.state.replace('_', ' ')}</span>}</h2>
              )}
              {nest(doc?.spaces ?? [], (s) => repos[repoKey(machine, s.folder)]).map(({ space, nested }) => (
                <div class={`space${nested ? ' nested' : ''}`} key={space.id}>
                  <div class="space-head">
                    <h3>{spaceName(space)}</h3>
                    <button class="icon" aria-label={`${spaceName(space)}: new tab and more`} onClick={() => setMenu({ machine, space })}>+</button>
                  </div>
                  <ul>
                    {space.tabs.flatMap((tab) => panes(tab.root).map((p) => row(qualify(p.terminal, machine), tab)))}
                    {space.tabs.every((tab) => panes(tab.root).length === 0) && <li class="empty">No terminals</li>}
                  </ul>
                </div>
              ))}
              {(!m || m.state === 'connected') && <button class="add-space" onClick={() => setAdding(machine)}>+ New space</button>}
            </section>
          );
        })}
        {loose.length > 0 && (
          <section>
            <h2 class="machine">Other terminals</h2>
            <ul>{loose.map((t) => row(t.address))}</ul>
          </section>
        )}
      </nav>
      <footer class="side-foot"><PushToggle /></footer>
      {menu && <SpaceMenu {...menu} repo={repos[repoKey(menu.machine, menu.space.folder)]} onClose={() => setMenu(null)} />}
      {adding !== null && <NewSpace machine={adding} onClose={() => setAdding(null)} />}
    </aside>
  );
}

function Session({ address }: { address: string }) {
  const t = useApp((s) => s.terminals[address]);
  const docs = useApp((s) => s.docs);
  const [menu, setMenu] = useState(false);
  const a = useAction();
  // Chat is for agents whose transcripts we can read: Claude Code on this machine, for now.
  const agent = !address.includes('/') && (t?.status?.app === 'claude-code' || t?.foreground?.name === 'claude');
  const [picked, setPicked] = useState<'chat' | 'terminal' | 'changes' | null>(null);
  const [file, setFile] = useState<{ path: string; cwd?: string } | null>(null);
  const machine = address.includes('/') ? address.slice(0, address.indexOf('/')) : '';
  const local = machine ? address.slice(machine.length + 1) : address;
  let space: Space | undefined, tab: Tab | undefined;
  for (const s of docs[machine]?.doc.spaces ?? []) for (const x of s.tabs) if (panes(x.root).some((p) => p.terminal === local)) { space = s; tab = x; }
  const repo = useApp((s) => (space ? s.repos[repoKey(machine, space.folder)] : null));
  const view = picked === 'changes' && repo ? 'changes' : agent ? (picked === 'terminal' ? 'terminal' : 'chat') : 'terminal';
  const cwd = t?.foreground?.cwd ?? t?.cwd;

  // Looking at it clears "done" on every herdr client.
  useEffect(() => {
    markSeen(address);
    const on = () => markSeen(address);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, [address, t?.turn]);

  return (
    <main class="main">
      <header class="main-head">
        <button class="icon back" aria-label="All spaces" onClick={() => go(null)}>‹</button>
        <div class="main-title">
          <span class="item-title"><Dot t={t} /> {titleOf(t, tab)}</span>
          <span class="item-sub">{space ? `${spaceName(space)} · ` : ''}{t?.foreground?.cwd ?? t?.cwd ?? ''}</span>
        </div>
        {(agent || repo) && (
          <div class="views" role="group" aria-label="View">
            {agent && <button aria-pressed={view === 'chat'} onClick={() => setPicked('chat')}>Chat</button>}
            <button aria-pressed={view === 'terminal'} onClick={() => setPicked('terminal')}>{agent ? 'Term' : 'Terminal'}</button>
            {repo && <button aria-pressed={view === 'changes'} onClick={() => setPicked('changes')}>Changes</button>}
          </div>
        )}
        <button class="icon" aria-label="Terminal actions" onClick={() => setMenu(true)}>⋯</button>
      </header>
      {!t ? <p class="empty pad">This terminal is gone.</p>
        : view === 'changes' && repo ? <ChangesView machine={machine} folder={repo.top} onFile={(path) => setFile({ path, cwd: repo.top })} />
        : view === 'chat' ? <ChatView key={address} address={address} t={t} onTerminal={() => setPicked('terminal')} onFile={(path) => setFile({ path, cwd })} />
        : <TerminalView key={address} address={address} />}
      {file && <FileSheet machine={machine} {...file} onClose={() => setFile(null)} />}
      {menu && (
        <Sheet title={titleOf(t, tab)} onClose={() => setMenu(false)}>
          <button class="row-button danger" disabled={a.busy} onClick={async () => {
            if (await a.run(() => (space ? closeTerminal(machine, local) : hc.call('terminal.kill', { terminal: address })))) { setMenu(false); go(null); }
          }}>{t?.state === 'live' ? 'End and close' : 'Close'}</button>
          {a.error && <p class="error" role="alert">{a.error}</p>}
        </Sheet>
      )}
    </main>
  );
}

export function App() {
  const conn = useApp((s) => s.conn);
  const route = useRoute();
  const [token] = useState(stored);
  useEffect(() => {
    if (token) connect(token);
    // A phone drops the socket in the background: come back at once.
    const wake = () => { if (document.visibilityState === 'visible') hc?.wake(); };
    document.addEventListener('visibilitychange', wake);
    addEventListener('online', wake);
    // A tapped notification, while the app was already open (public/sw.js).
    navigator.serviceWorker?.addEventListener('message', (e) => { if (typeof e.data?.go === 'string') location.hash = new URL(e.data.go).hash; });
    return () => { document.removeEventListener('visibilitychange', wake); removeEventListener('online', wake); };
  }, []);

  if (conn === 'denied' || (!stored() && conn === 'closed')) return <TokenGate denied={conn === 'denied'} />;
  return (
    <div class="app" data-view={route ? 'session' : 'list'}>
      <Sidebar current={route} />
      {route ? <Session address={route} /> : <main class="main placeholder"><p class="empty">Pick a terminal.</p></main>}
    </div>
  );
}
