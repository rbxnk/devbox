// The bridge: serves the built PWA and tunnels hc's framed protocol over a WebSocket.
// One WebSocket is one `hc connect`. The browser speaks hc frames; the bridge only
// checks the token and which methods are called.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { WebSocketServer, type WebSocket } from 'ws';
import { api } from './api.ts';
import { hookAsk, installHook } from './asks.ts';
import { useHc } from './core.ts';
import { Push } from './push.ts';
import { DATA, HEADER, MAX_PAYLOAD, decodeOne, decoder, encode } from '../shared/frames.ts';

// What a browser may call. Not here on purpose: hello (the bridge does it), server.stop/restart,
// machine.add/rm/rename, and machine.exec, file.write, file.edit.
export const ALLOWED = new Set([
  'server.status', 'templates.list', 'events.subscribe',
  'terminal.run', 'terminal.list', 'terminal.get', 'terminal.kill', 'terminal.rm', 'terminal.keep',
  'terminal.label', 'terminal.read', 'terminal.attach', 'terminal.send', 'terminal.wait',
  'terminal.keys', 'terminal.interrupt', 'terminal.put',
  'doc.get', 'doc.set', 'machine.list', 'machine.connect', 'file.read',
]);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.ico': 'image/x-icon',
};

/** The token in `dir/token`, made on first use. Readable by this user only. */
export function loadToken(dir: string): string {
  const file = path.join(dir, 'token');
  try { const t = fs.readFileSync(file, 'utf8').trim(); if (t) return t; } catch {}
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}

export function tokenOk(given: unknown, token: string): boolean {
  if (typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

function serveStatic(dist: string, req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  let rel: string;
  try { rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  let file = path.join(dist, path.normalize(rel));
  if (file !== dist && !file.startsWith(dist + path.sep)) { res.writeHead(403).end(); return; }
  // Anything that isn't a file is a route inside the app.
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) file = path.join(dist, 'index.html');
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404).end('not built: run npm run build'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      // Hashed files never change; the rest must be checked so updates arrive.
      'cache-control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

function tunnel(ws: WebSocket, hcBin: string) {
  const hc = spawn(hcBin, ['connect'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const done = () => { hc.kill(); ws.close(); };
  hc.on('error', done);
  hc.on('exit', done);
  hc.stdin.on('error', done);
  ws.on('close', done);
  ws.on('error', done);

  // Plain mode until hello's one-line reply, framed after it.
  let head: Buffer | null = Buffer.alloc(0);
  const frames = decoder((_f, raw) => ws.send(raw, { binary: true }));
  hc.stdout.on('data', (chunk: Buffer) => {
    try {
      if (head === null) { frames(chunk); return; }
      head = Buffer.concat([head, chunk]);
      const nl = head.indexOf(10);
      if (nl < 0) return;
      const reply = JSON.parse(head.subarray(0, nl).toString());
      const rest = head.subarray(nl + 1);
      head = null;
      if (!reply.result?.framed) { done(); return; }
      ws.send(JSON.stringify({ hello: reply.result }));
      if (rest.length) frames(rest);
    } catch { done(); }
  });
  hc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'hello', params: { framed: true, generation: 1 } }) + '\n');

  return (data: Buffer) => {
    const frame = head === null ? decodeOne(data) : null;
    if (!frame) { done(); return; }
    if (frame.channel === 0 && frame.kind === DATA) {
      let msg: any;
      try { msg = JSON.parse(Buffer.from(frame.payload).toString()); } catch { done(); return; }
      if (!ALLOWED.has(msg?.method)) {
        const error = { code: -32601, message: `${msg?.method} is not allowed through the bridge`, data: { kind: 'forbidden' } };
        if (msg?.id !== undefined) ws.send(encode(0, DATA, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error }))), { binary: true });
        return;
      }
    }
    hc.stdin.write(data);
  };
}

export function start(opts: { port: number; host?: string; token: string; dist: string; hc?: string; config: string; watch?: boolean }): http.Server {
  const dist = path.resolve(opts.dist);
  useHc(opts.hc);
  const push = new Push(opts.config, opts.hc);
  if (opts.watch) push.watch();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/hook/ask') { hookAsk(req, res); return; } // its own check: loopback only
    if (!url.pathname.startsWith('/api/')) { serveStatic(dist, req, res); return; }
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!tokenOk(bearer, opts.token)) { res.writeHead(401).end(); return; }
    api(req, res, url, push).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: HEADER + MAX_PAYLOAD });
  wss.on('connection', (ws) => {
    let forward: ((data: Buffer) => void) | null = null;
    const timer = setTimeout(() => ws.close(4401, 'no token'), 5000);
    ws.on('close', () => clearTimeout(timer));
    ws.on('message', (data: Buffer, isBinary) => {
      if (forward) { if (isBinary) forward(data); else ws.close(4400, 'frames only'); return; }
      // The first message is the token, never a URL or header a proxy might log.
      let given: unknown;
      try { given = JSON.parse(data.toString()).token; } catch {}
      if (isBinary || !tokenOk(given, opts.token)) { ws.close(4401, 'bad token'); return; }
      clearTimeout(timer);
      forward = tunnel(ws, opts.hc ?? 'herdr-core');
    });
  });
  server.on('close', () => push.stop());
  return server.listen(opts.port, opts.host ?? '0.0.0.0');
}

if (import.meta.main) {
  const dir = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'herdr-pwa');
  const port = Number(process.env.PORT ?? 8787);
  start({ port, token: loadToken(dir), dist: path.join(import.meta.dirname, '..', 'dist'), hc: process.env.HC_BIN, config: dir, watch: true });
  console.log(`herdr-pwa bridge on :${port}; token in ${path.join(dir, 'token')}`);
  // Claude Code's prompts reach the chat through this hook (server/asks.ts). HERDR_PWA_NO_HOOK=1 leaves its settings alone.
  if (!process.env.HERDR_PWA_NO_HOOK) {
    const settings = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'settings.json');
    try { if (installHook(settings, port)) console.log(`added the PermissionRequest hook to ${settings}`); }
    catch (e) { console.warn(`could not add the hook to ${settings}:`, (e as Error).message); }
  }
}
