// Permission requests and questions from Claude Code, as structured data. Claude Code POSTs each one
// to /hook/ask (an http hook, see installHook) and waits; the PWA answers it, or the person answers
// in the terminal and Claude Code drops the request. Nothing here decides anything by itself.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { tail } from './tail.ts';

export type Ask = {
  id: string; session: string;
  tool: string; input: Record<string, unknown>; suggestions: unknown[];
};
export type Answer = { behavior: 'allow' | 'deny'; message?: string; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] };

const pending = new Map<string, { ask: Ask; reply: (a: Answer | null) => void }>();
const watchers = new Set<() => void>();
const changed = () => watchers.forEach((w) => w());

export const asksFor = (session: string): Ask[] => [...pending.values()].map((p) => p.ask).filter((a) => a.session === session);
export function watchAsks(fn: () => void): () => void { watchers.add(fn); return () => watchers.delete(fn); }

/** Answers a waiting request. False: it is no longer waiting (answered in the terminal, or timed out). */
export function answer(id: string, a: Answer): boolean {
  const p = pending.get(id);
  if (!p) return false;
  p.reply(a);
  return true;
}

/** What Claude Code expects back from a PermissionRequest hook. */
function output(a: Answer) {
  const decision = a.behavior === 'allow'
    ? { behavior: 'allow', ...(a.updatedInput ? { updatedInput: a.updatedInput } : {}), ...(a.updatedPermissions?.length ? { updatedPermissions: a.updatedPermissions } : {}) }
    : { behavior: 'deny', message: a.message ?? 'Denied from the herdr app.' };
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

/**
 * Claude Code leaves the hook request open when the person answers in the terminal instead, so the
 * transcript says when a request is over: its tool call got a result, or a new prompt was typed.
 * The request doesn't name its tool call, so it is matched by tool name and input.
 */
export function watchResolved(file: string, tool: string, input: unknown, done: () => void): () => void {
  let size = 0;
  try { size = fs.statSync(file).size; } catch {}
  // The tool call was written just before the request: look a little way back for it.
  const read = tail(file, Math.max(0, size - (1 << 20)));
  let first = size > 1 << 20, id: string | undefined, asked = false;
  const timer = setInterval(() => {
    for (const line of read()) {
      if (first) { first = false; continue; } // may be half a line
      let d: any;
      try { d = JSON.parse(line); } catch { continue; }
      if (d?.isSidechain || d?.isMeta) continue;
      const blocks: any[] = Array.isArray(d?.message?.content) ? d.message.content : [];
      for (const b of blocks) {
        if (b?.type === 'tool_use' && b.name === tool && isDeepStrictEqual(b.input, input)) id = b.id;
        if (b?.type === 'tool_result' && b.tool_use_id === id) { clearInterval(timer); done(); return; }
      }
      // A typed prompt after the request: the dialog was dismissed.
      if (asked && d?.type === 'user' && typeof d.message?.content === 'string') { clearInterval(timer); done(); return; }
    }
    asked = true;
  }, 1000);
  return () => clearInterval(timer);
}

const loopback = (a?: string) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';

/** POST /hook/ask: only from this machine, which is where Claude Code runs. */
export function hookAsk(req: http.IncomingMessage, res: http.ServerResponse) {
  // A request through the reverse proxy never comes from loopback, and carries its forwarding headers.
  if (req.method !== 'POST' || !loopback(req.socket.remoteAddress) || req.headers['x-forwarded-for']) { res.writeHead(403).end(); return; }
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => { size += c.length; if (size > 4 << 20) req.destroy(); else chunks.push(c); });
  req.on('end', () => {
    let d: any;
    try { d = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400).end(); return; }
    if (process.env.HERDR_PWA_HOOK_LOG) fs.appendFileSync(process.env.HERDR_PWA_HOOK_LOG, JSON.stringify(d) + '\n');
    const none = () => { res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); }; // no decision: Claude Code carries on as without us
    if (d?.hook_event_name !== 'PermissionRequest' || typeof d.session_id !== 'string' || typeof d.tool_name !== 'string') { none(); return; }
    const ask: Ask = {
      id: crypto.randomUUID(), session: d.session_id, tool: d.tool_name,
      input: d.tool_input ?? {}, suggestions: Array.isArray(d.permission_suggestions) ? d.permission_suggestions : [],
    };
    const trace = (what: string) => { if (process.env.HERDR_PWA_HOOK_LOG) fs.appendFileSync(process.env.HERDR_PWA_HOOK_LOG, `${new Date().toISOString()} ${what} ${ask.id} ${ask.tool}\n`); };
    let unwatch = () => {};
    const finish = () => { unwatch(); if (pending.delete(ask.id)) { trace('gone'); changed(); } };
    trace('asked');
    pending.set(ask.id, { ask, reply: (a) => {
      finish();
      if (a) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(output(a))); else none();
    } });
    res.on('close', finish); // Claude Code gave up waiting, or went away
    if (typeof d.transcript_path === 'string') {
      unwatch = watchResolved(d.transcript_path, ask.tool, d.tool_input, () => pending.get(ask.id)?.reply(null));
    }
    changed();
  });
}

const HOOK_URL = (port: number) => `http://127.0.0.1:${port}/hook/ask`;

/**
 * Adds our hook to Claude Code's settings (idempotent; other hooks are left alone). PermissionRequest
 * fires for tool permissions, questions and plan approval alike, while the dialog is already on screen.
 */
export function installHook(settingsFile: string, port: number): boolean {
  let settings: any = {};
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  const hooks = (settings.hooks ??= {});
  const ours = (h: any) => typeof h?.url === 'string' && /\/hook\/ask$/.test(h.url);
  const before = JSON.stringify(hooks);
  const groups: any[] = hooks.PermissionRequest ?? [];
  for (const g of groups) g.hooks = (g.hooks ?? []).filter((h: any) => !ours(h));
  // A day: the request waits as long as the dialog is on screen.
  hooks.PermissionRequest = [...groups.filter((g) => g.hooks.length), { hooks: [{ type: 'http', url: HOOK_URL(port), timeout: 86400 }] }];
  if (JSON.stringify(hooks) === before) return false;
  const tmp = `${settingsFile}.herdr-pwa.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, settingsFile);
  return true;
}
