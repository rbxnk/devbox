// Terminals as hc reports them, and the herdr apps' shared `herdr-app` document.
// Formats: herdr-core schema/README.md, herdr-app src/mirror.rs and docs/labels.md.
// Everything here is pure; unknown fields are carried through untouched.

export type Status = { state: string; app?: string; msg?: string; kind?: string | null; title?: string };
export type Foreground = { pid: number; name: string; argv: string[]; cwd: string };
export type Terminal = {
  address: string; state: 'live' | 'finished'; cwd: string; labels: Record<string, string>;
  status?: Status | null; turn?: number; title?: string; name?: string | null;
  foreground?: Foreground | null; cols: number; rows: number;
  reason?: string | null; exit_code?: number | null; pid?: number | null;
  [more: string]: unknown;
};
export type Terminals = Record<string, Terminal>;

export type Node = {
  id: string; type: 'block' | 'row' | 'column' | 'stack';
  children?: Node[]; content?: { terminal?: string; mod?: string };
  floating?: { id: string; content?: { terminal?: string } }[];
  [more: string]: unknown;
};
export type Tab = { id: string; name: string; root: Node; [more: string]: unknown };
export type Space = { id: string; name: string; folder: string; tabs: Tab[]; [more: string]: unknown };
export type Doc = { spaces: Space[]; [more: string]: unknown };

export type HcEvent = { seq: number; type: string; terminal?: string; machine?: string; data: any };

/** One event applied to a snapshot, as the README's table says. */
export function applyEvent(terms: Terminals, ev: HcEvent): Terminals {
  const a = ev.terminal;
  if (!a) return terms;
  const d = ev.data ?? {};
  const cur = terms[a];
  const put = (t: Terminal) => ({ ...terms, [a]: t });
  switch (ev.type) {
    case 'created': case 'restarted': return put(d);
    case 'removed': { const { [a]: _gone, ...rest } = terms; return rest; }
    case 'labels': return d.record ? put(d.record) : cur ? put({ ...cur, labels: d.labels }) : terms;
  }
  if (!cur) return terms;
  switch (ev.type) {
    case 'lost': return put({ ...cur, ...d, pid: null, foreground: null });
    case 'finished': return put({ ...cur, ...d, state: 'finished', foreground: null });
    case 'keep': return put({ ...cur, keep: d.keep });
    case 'status': return put({ ...cur, status: d.status, records: d.records, reported: d.reported });
    case 'turn': return put({ ...cur, turn: d.turn });
    case 'title': return put({ ...cur, title: d.title });
    case 'size': return put({ ...cur, cols: d.cols, rows: d.rows });
    case 'foreground': return put({ ...cur, foreground: ev.data });
    default: return terms;
  }
}

export type Shown = 'blocked' | 'error' | 'working' | 'done' | 'idle' | 'ended' | 'none';

/** What to show for a terminal (docs/labels.md): done means finished a turn nobody has looked at. */
export function shown(t: Terminal | undefined): Shown {
  if (!t || t.state === 'finished') return 'ended';
  const s = t.status?.state;
  if (!s) return 'none';
  if (s === 'blocked' || s === 'error' || s === 'working') return s;
  const seen = t.labels['herdr.seen'];
  return seen !== undefined && (t.turn ?? 0) > Number(seen) ? 'done' : 'idle';
}

/** The `herdr.seen` value to write when a person looks at `t`, or null when there is nothing to raise. */
export function seenToWrite(t: Terminal): string | null {
  const turn = t.turn ?? 0, seen = t.labels['herdr.seen'];
  return seen === undefined || Number(seen) < turn ? String(turn) : null;
}

export const qualify = (id: string, machine: string) => (machine ? `${machine}/${id}` : id);
export const machineOf = (address: string) => (address.includes('/') ? address.slice(0, address.indexOf('/')) : '');

export type Pane = { id: string; terminal: string };

/** A tab's terminal panes in layout order, floating ones last. */
export function panes(node: Node): Pane[] {
  const out: Pane[] = [];
  if (node.type === 'block' && node.content?.terminal) out.push({ id: node.id, terminal: node.content.terminal });
  for (const c of node.children ?? []) out.push(...panes(c));
  for (const f of node.floating ?? []) if (f.content?.terminal) out.push({ id: f.id, terminal: f.content.terminal });
  return out;
}

export const asDoc = (value: unknown): Doc => {
  const v = value as Doc | null;
  return v && Array.isArray(v.spaces) ? v : { ...(v ?? {}), spaces: [] };
};

export function newId(prefix: string): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return prefix + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** A tab with one terminal pane, shaped as the desktop app makes them. */
export const newTab = (id: string, name: string, pane: string, terminal: string): Tab =>
  ({ id, name, root: { id, type: 'row', children: [{ id: pane, type: 'block', content: { terminal } }] } });

export function addSpace(doc: Doc, space: Space): Doc {
  return { ...doc, spaces: [...doc.spaces, space] };
}

export function addTab(doc: Doc, spaceId: string, tab: Tab): Doc {
  return { ...doc, spaces: doc.spaces.map((s) => (s.id === spaceId ? { ...s, tabs: [...s.tabs, tab] } : s)) };
}

function without(node: Node, terminal: string): Node | null {
  if (node.type === 'block') return node.content?.terminal === terminal ? null : node;
  const children = (node.children ?? []).map((c) => without(c, terminal)).filter((c): c is Node => c !== null);
  const floating = node.floating?.filter((f) => f.content?.terminal !== terminal);
  return { ...node, children, ...(floating ? { floating } : {}) };
}

/** Drops a terminal's pane; a tab left with no panes at all goes too. Spaces stay. */
export function removeTerminal(doc: Doc, terminal: string): Doc {
  return {
    ...doc,
    spaces: doc.spaces.map((s) => ({
      ...s,
      tabs: s.tabs.flatMap((t) => {
        if (!panes(t.root).some((p) => p.terminal === terminal)) return [t];
        const root = without(t.root, terminal);
        // Mod panes (a file, a board) are the desktop app's; a tab that still has any is kept.
        return root && (panes(root).length || JSON.stringify(root).includes('"mod"')) ? [{ ...t, root }] : [];
      }),
    })),
  };
}

export function removeSpace(doc: Doc, spaceId: string): Doc {
  return { ...doc, spaces: doc.spaces.filter((s) => s.id !== spaceId) };
}

/** The terminals a document places somewhere. */
export function placed(doc: Doc): Set<string> {
  return new Set(doc.spaces.flatMap((s) => s.tabs.flatMap((t) => panes(t.root).map((p) => p.terminal))));
}
