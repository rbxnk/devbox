// What the hc tunnel can't carry: things read from this machine's own files. The caller has checked the token.
import type http from 'node:http';
import { followClaude } from './chat.ts';
import { answer, type Answer } from './asks.ts';
import { GitError, addWorktree, changes, checkouts, dirty, removeWorktree, repoOf } from './git.ts';
import { CoreError } from './core.ts';
import type { Push } from './push.ts';

function body(req: http.IncomingMessage, limit = 16 << 20): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const json = (res: http.ServerResponse, status: number, value: unknown) =>
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value));

export async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL, push: Push) {
  if (req.method === 'GET' && url.pathname === '/api/chat') {
    const pid = Number(url.searchParams.get('pid'));
    if (!Number.isSafeInteger(pid) || pid <= 0) { res.writeHead(400).end(); return; }
    // One JSON item per line, for as long as the client listens.
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    const stop = followClaude(pid, (item) => res.write(JSON.stringify(item) + '\n'));
    const beat = setInterval(() => res.write('\n'), 15000); // keeps a proxy from closing a quiet stream
    req.on('close', () => { stop(); clearInterval(beat); });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/answer') {
    let a: Answer & { id?: string };
    try { a = JSON.parse((await body(req)).toString()); } catch { json(res, 400, { error: 'bad request' }); return; }
    if (typeof a.id !== 'string' || (a.behavior !== 'allow' && a.behavior !== 'deny')) { json(res, 400, { error: 'bad request' }); return; }
    // Gone: it was answered in the terminal meanwhile.
    json(res, answer(a.id, a) ? 200 : 409, {});
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/push') { json(res, 200, { key: push.key }); return; }
  if (req.method === 'POST' && url.pathname === '/api/push') {
    // { subscription } adds this browser; { unsubscribe: endpoint } removes it.
    let q: any;
    try { q = JSON.parse((await body(req, 1 << 16)).toString()); } catch { json(res, 400, { error: 'bad request' }); return; }
    try {
      if (typeof q?.unsubscribe === 'string') push.unsubscribe(q.unsubscribe); else push.subscribe(q?.subscription);
      json(res, 200, {});
    } catch (e) { json(res, 400, { error: (e as Error).message }); }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/git') {
    let q: { op?: string; folder?: string; machine?: string; branch?: string; mode?: string; force?: boolean };
    try { q = JSON.parse((await body(req)).toString()); } catch { json(res, 400, { error: 'bad request' }); return; }
    if (typeof q.folder !== 'string' || !q.folder.startsWith('/')) { json(res, 400, { error: 'a folder is needed' }); return; }
    const on = typeof q.machine === 'string' && q.machine ? q.machine : undefined;
    try {
      switch (q.op) {
        case 'repo': json(res, 200, { repo: await repoOf(q.folder, on) }); return;
        case 'checkouts': { const repo = await repoOf(q.folder, on); json(res, 200, { checkouts: repo ? await checkouts(repo, on) : [] }); return; }
        case 'changes': json(res, 200, await changes(q.folder, q.mode === 'branch' ? 'branch' : 'head', on)); return;
        case 'worktree-add': json(res, 200, { path: await addWorktree(q.folder, String(q.branch ?? ''), on) }); return;
        case 'dirty': json(res, 200, { dirty: await dirty(q.folder, on) }); return;
        case 'worktree-remove': await removeWorktree(q.folder, q.force === true, on); json(res, 200, {}); return;
        default: json(res, 400, { error: 'unknown op' }); return;
      }
    } catch (e) {
      // What git or hc said is for the person to read; anything else is ours.
      if (e instanceof GitError || e instanceof CoreError) json(res, 422, { error: e.message }); else throw e;
      return;
    }
  }
  res.writeHead(404).end();
}
