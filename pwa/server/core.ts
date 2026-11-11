// The bridge's own calls to hc: one short-lived `hc connect` per call.
import { spawn } from 'node:child_process';

let bin = process.env.HC_BIN ?? 'herdr-core';
export const useHc = (path: string | undefined) => { if (path) bin = path; };

export class CoreError extends Error {
  kind: string;
  constructor(message: string, kind = 'error') { super(message); this.kind = kind; }
}

export function rpc<T = any>(method: string, params: object = {}, timeoutMs = 120_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const hc = spawn(bin, ['connect'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const fail = (e: Error) => { clearTimeout(timer); hc.kill(); reject(e); };
    const timer = setTimeout(() => fail(new CoreError(`${method} timed out`, 'timeout')), timeoutMs);
    hc.on('error', fail);
    hc.stdin.on('error', () => {});
    hc.on('exit', () => fail(new CoreError('hc is not answering', 'unavailable')));
    hc.stdout.on('data', (chunk: Buffer) => {
      out += chunk;
      const nl = out.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      hc.removeAllListeners('exit');
      hc.kill();
      try {
        const m = JSON.parse(out.slice(0, nl));
        if (m.error) reject(new CoreError(m.error.message, m.error.data?.kind)); else resolve(m.result);
      } catch (e) { reject(e as Error); }
    });
    hc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
  });
}

export type Ran = { ok: boolean; code: number | null; out: string; err: string };

/** Runs one program here or on another machine (`on`), without a terminal. Seconds for `timeout`. */
export async function exec(argv: string[], opts: { cwd?: string; on?: string; timeout?: number } = {}): Promise<Ran> {
  const timeout = opts.timeout ?? 60;
  const r = await rpc('machine.exec', { argv, ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.on ? { on: opts.on } : {}), timeout }, (timeout + 10) * 1000);
  const text = (b64: string) => Buffer.from(b64 ?? '', 'base64').toString();
  return { ok: r.code === 0 && !r.timed_out, code: r.code ?? null, out: text(r.stdout), err: text(r.stderr) };
}
