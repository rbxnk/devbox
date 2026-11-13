// Chat items from an agent's own session transcript. One adapter per agent; Claude Code is the first.
// The transcript format is Claude Code's own and undocumented: unknown entries are skipped, never fatal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asksFor, watchAsks, type Ask } from './asks.ts';
import { tail } from './tail.ts';

export type Item =
  | { type: 'user' | 'assistant' | 'note'; id: string; text: string; ts?: string }
  | { type: 'tool'; id: string; name: string; input: Record<string, unknown>; ts?: string }
  | { type: 'result'; id: string; text: string; error: boolean };

const MAX = 30_000;
const clip = (s: string) => (s.length > MAX ? s.slice(0, MAX) + '\n… (truncated)' : s);
const clipDeep = (v: unknown): unknown =>
  typeof v === 'string' ? clip(v)
    : Array.isArray(v) ? v.map(clipDeep)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipDeep(x)]))
    : v;

const tag = (s: string, name: string) => s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();

/** What a person typed, without the wrappers Claude Code adds around it. Null: nothing to show. */
function userText(raw: string): { type: 'user' | 'note'; text: string } | null {
  const command = tag(raw, 'command-name');
  if (command) return { type: 'user', text: [command, tag(raw, 'command-args')].filter(Boolean).join(' ') };
  const out = tag(raw, 'local-command-stdout');
  if (out !== undefined) return out ? { type: 'note', text: out } : null;
  const text = raw.replace(/<(system-reminder|local-command-caveat|task-notification)>[\s\S]*?<\/\1>/g, '')
    .replace(/^\s*<hc [^>]*>([\s\S]*)<\/hc>\s*$/, '$1').trim(); // hc wraps a message sent from another terminal
  return text ? { type: 'user', text } : null;
}

function flatten(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
}

/** The chat items in one transcript line. */
export function parseClaude(line: string): Item[] {
  let d: any;
  try { d = JSON.parse(line); } catch { return []; }
  if (!d || d.isSidechain || d.isMeta || (d.type !== 'user' && d.type !== 'assistant')) return [];
  const ts = d.timestamp, id = (i: number) => `${d.uuid}:${i}`;
  if (d.isCompactSummary) return [{ type: 'note', id: id(0), text: 'Earlier conversation was compacted.', ts }];
  const content = d.message?.content;
  const blocks: any[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  const out: Item[] = [];
  blocks.forEach((b, i) => {
    if (b?.type === 'text' && typeof b.text === 'string') {
      if (d.type === 'assistant') { if (b.text.trim()) out.push({ type: 'assistant', id: id(i), text: clip(b.text), ts }); }
      else { const u = userText(b.text); if (u) out.push({ ...u, text: clip(u.text), id: id(i), ts }); }
    } else if (b?.type === 'image' && d.type === 'user') {
      out.push({ type: 'user', id: id(i), text: '[image]', ts });
    } else if (b?.type === 'tool_use') {
      out.push({ type: 'tool', id: b.id, name: b.name, input: clipDeep(b.input ?? {}) as Record<string, unknown>, ts });
    } else if (b?.type === 'tool_result') {
      out.push({ type: 'result', id: b.tool_use_id, text: clip(flatten(b.content)), error: b.is_error === true });
    }
  });
  return out;
}

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');

/** The id of the session a Claude Code process is in now. Null: not a Claude Code process. */
function sessionOf(pid: number, home = claudeHome()): string | null {
  let session: unknown;
  try { session = JSON.parse(fs.readFileSync(path.join(home, 'sessions', `${pid}.json`), 'utf8')).sessionId; } catch { return null; }
  return typeof session === 'string' && /^[\w-]+$/.test(session) ? session : null;
}

/** The session a Claude Code process is in now, and its transcript file. Null: not a Claude Code process. */
export function claudeSession(pid: number, home = claudeHome()): { session: string; file: string } | null {
  const session = sessionOf(pid, home);
  if (!session) return null;
  const projects = path.join(home, 'projects');
  // The folder is named after the folder the session started in, which the process may have left since.
  for (const dir of fs.readdirSync(projects, { withFileTypes: true })) {
    const file = path.join(projects, dir.name, `${session}.jsonl`);
    if (dir.isDirectory() && fs.existsSync(file)) return { session, file };
  }
  return { session, file: '' }; // a session that hasn't written anything yet
}

/**
 * Follows the chat of the Claude Code process `pid`: `emit` gets `{type:'reset'}` whenever the
 * session changes (/clear, /resume), then every item so far, `{type:'ready'}`, and new items as they come.
 * Returns the function that stops it.
 */
export type Control = { type: 'reset' } | { type: 'ready' } | { type: 'none' } | { type: 'asks'; asks: Ask[] };
export function followClaude(pid: number, emit: (item: Item | Control) => void): () => void {
  let current = '\0', read: (() => string[]) | null = null, ready = false; // '\0': nothing sent yet
  const tick = () => {
    const s = claudeSession(pid);
    const key = s ? `${s.session}\n${s.file}` : '';
    if (key !== current) {
      current = key; ready = false; asked = '';
      read = s?.file ? tail(s.file) : null;
      emit({ type: s ? 'reset' : 'none' });
    }
    for (const line of read?.() ?? []) for (const item of parseClaude(line)) emit(item);
    if (s && !ready) { ready = true; emit({ type: 'ready' }); }
    // What Claude Code is asking the person right now (server/asks.ts).
    const asks = s ? asksFor(s.session) : [];
    const sig = asks.map((a) => a.id).join();
    if (sig !== asked) { asked = sig; emit({ type: 'asks', asks }); }
  };
  let asked = '';
  const unwatch = watchAsks(() => tick());
  tick();
  // shortcut: polls twice a second, since file watching is unreliable on the bind-mounted home; watch if this ever costs.
  const timer = setInterval(tick, 500);
  return () => { clearInterval(timer); unwatch(); };
}
