// Runs against the real hc on this machine: starts one `cat` terminal and removes it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { loadToken, start, tokenOk } from './main.ts';
import { CLOSE, CREDIT, DATA, decodeOne, decoder, encode, u32, type Frame } from '../shared/frames.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-pwa-'));
fs.writeFileSync(path.join(tmp, 'index.html'), '<p>app</p>');
const token = loadToken(path.join(tmp, 'cfg'));
const server = start({ port: 0, host: '127.0.0.1', token, dist: tmp, config: path.join(tmp, 'cfg') });
await once(server, 'listening');
const port = () => (server.address() as AddressInfo).port;
after(() => { server.close(); server.closeAllConnections(); fs.rmSync(tmp, { recursive: true }); });

test('frames survive any split', () => {
  const a = encode(7, DATA, new TextEncoder().encode('hello')), b = encode(0, CLOSE);
  const all = new Uint8Array([...a, ...b]);
  for (let cut = 0; cut <= all.length; cut++) {
    const got: Frame[] = [];
    const feed = decoder((f) => got.push({ ...f, payload: f.payload.slice() }));
    feed(all.subarray(0, cut)); feed(all.subarray(cut));
    assert.deepEqual(got.map((f) => [f.channel, f.kind, new TextDecoder().decode(f.payload)]), [[7, DATA, 'hello'], [0, CLOSE, '']]);
  }
  assert.equal(decodeOne(all), null); // two frames are not one
});

test('token is kept, private and checked', () => {
  assert.equal(loadToken(path.join(tmp, 'cfg')), token);
  assert.equal(fs.statSync(path.join(tmp, 'cfg', 'token')).mode & 0o777, 0o600);
  assert.ok(tokenOk(token, token));
  assert.ok(!tokenOk(token + 'x', token) && !tokenOk(undefined, token));
});

test('static files stay inside dist', async () => {
  const get = (p: string) => fetch(`http://127.0.0.1:${port()}${p}`).then(async (r) => [r.status, await r.text()] as [number, string]);
  assert.deepEqual(await get('/'), [200, '<p>app</p>']);
  assert.deepEqual(await get('/some/route'), [200, '<p>app</p>']);
  assert.notEqual((await get('/..%2f..%2f..%2fetc%2fpasswd'))[1].includes('root:'), true);
  assert.equal((await get('/cfg/token'))[1].includes(token), true); // only because the test put cfg inside dist
});

/** A minimal client: what src/hc.ts does, without the browser. */
async function connect(tok: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port()}/ws`);
  ws.binaryType = 'arraybuffer';
  const pending = new Map<number, (m: any) => void>();
  const streams = new Map<number, (f: Frame) => void>();
  let id = 0;
  const hello = new Promise<any>((resolve, reject) => {
    ws.onclose = (e) => reject(new Error(`closed ${e.code}`));
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') { resolve(JSON.parse(e.data).hello); return; }
      const f = decodeOne(new Uint8Array(e.data))!;
      if (f.channel === 0) { const m = JSON.parse(new TextDecoder().decode(f.payload)); pending.get(m.id)?.(m); }
      else streams.get(f.channel)?.(f);
    };
  });
  ws.onopen = () => ws.send(JSON.stringify({ token: tok }));
  const call = (method: string, params = {}) => new Promise<any>((resolve) => {
    pending.set(++id, resolve);
    ws.send(encode(0, DATA, new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id, method, params }))));
  });
  return { ws, hello: await hello, call, streams };
}

test('a wrong token is turned away', async () => {
  await assert.rejects(connect('nope'), /closed 4401/);
});

test('rpc, the allowlist, and an attach stream', async () => {
  const c = await connect(token);
  assert.equal(c.hello.framed, true);

  assert.ok(Array.isArray((await c.call('terminal.list')).result.terminals));
  for (const method of ['machine.exec', 'file.write', 'server.stop', 'hello']) {
    assert.equal((await c.call(method, { line: 'id' })).error.data.kind, 'forbidden', method);
  }

  const run = await c.call('terminal.run', { argv: ['cat'], no_parent: true, labels: { 'herdr-pwa': 'test' } });
  const t = run.result.terminal?.address ?? run.result.address;
  assert.ok(t, JSON.stringify(run));
  try {
    const attach = await c.call('terminal.attach', { terminal: t, cols: 80, rows: 24 });
    const ch = attach.result.channel;
    let seen = '';
    const echoed = new Promise<void>((resolve) => c.streams.set(ch, (f) => {
      if (f.kind !== DATA) return;
      seen += new TextDecoder().decode(f.payload);
      c.ws.send(encode(ch, CREDIT, u32(f.payload.length)));
      if (seen.includes('ping-pwa\r\nping-pwa')) resolve(); // typed once, echoed by the tty and by cat
    }));
    c.ws.send(encode(ch, DATA, new TextEncoder().encode('ping-pwa\r')));
    await echoed;
  } finally {
    await c.call('terminal.kill', { terminal: t });
    await c.call('terminal.rm', { terminal: t });
  }
  c.ws.onclose = null;
  c.ws.close();
});
