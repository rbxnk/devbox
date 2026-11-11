// hc's framed protocol over the bridge's WebSocket. Reconnects by itself.
import { CLOSE, CREDIT, DATA, decodeOne, encode, u32, type Frame } from '../shared/frames.ts';

export type RpcError = { code: number; message: string; data?: { kind?: string; hint?: string } };
export type ConnState = 'connecting' | 'open' | 'denied' | 'closed';
type Stream = (frame: Frame) => void;

const enc = new TextEncoder(), dec = new TextDecoder();

export class HcError extends Error {
  kind: string;
  constructor(e: RpcError) { super(e.message); this.kind = e.data?.kind ?? 'error'; }
}

export class Hc {
  state: ConnState = 'closed';
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private streams = new Map<number, Stream>();
  private early = new Map<number, Frame[]>(); // frames for a channel nobody listens on yet
  private retry = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private token: string;
  private onState: (s: ConnState) => void;

  constructor(token: string, onState: (s: ConnState) => void) {
    this.token = token;
    this.onState = onState;
  }

  private set(s: ConnState) { this.state = s; this.onState(s); }

  connect() {
    clearTimeout(this.timer);
    this.set('connecting');
    const ws = this.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send(JSON.stringify({ token: this.token }));
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') { this.retry = 0; this.set('open'); return; } // the bridge's hello
      const f = decodeOne(new Uint8Array(e.data));
      if (!f) return;
      if (f.channel === 0) { if (f.kind === DATA) this.reply(JSON.parse(dec.decode(f.payload))); return; }
      const stream = this.streams.get(f.channel);
      if (stream) stream(f);
      else if (f.kind !== CLOSE) (this.early.get(f.channel) ?? this.early.set(f.channel, []).get(f.channel)!).push(f);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      for (const p of this.pending.values()) p.reject(new HcError({ code: 0, message: 'connection lost', data: { kind: 'disconnected' } }));
      this.pending.clear(); this.streams.clear(); this.early.clear();
      if (e.code === 4401) { this.set('denied'); return; }
      this.set('closed');
      this.timer = setTimeout(() => this.connect(), Math.min(15000, 500 * 2 ** this.retry++));
    };
  }

  /** Try again now (the app came back to the foreground). */
  wake() { if (this.state === 'closed') { this.retry = 0; this.connect(); } }

  dispose() { clearTimeout(this.timer); const ws = this.ws; this.ws = undefined; ws?.close(); }

  private reply(m: { id?: number; result?: unknown; error?: RpcError }) {
    const p = m.id === undefined ? undefined : this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id!);
    if (m.error) p.reject(new HcError(m.error)); else p.resolve(m.result);
  }

  call<T = any>(method: string, params: object = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN || this.state !== 'open') {
        reject(new HcError({ code: 0, message: 'not connected', data: { kind: 'disconnected' } })); return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.send(0, DATA, enc.encode(JSON.stringify({ jsonrpc: '2.0', id, method, params })));
    });
  }

  send(channel: number, kind: number, payload?: Uint8Array) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encode(channel, kind, payload));
  }

  /** Listen on a stream channel; frames that arrived first are delivered now. */
  listen(channel: number, stream: Stream) {
    this.streams.set(channel, stream);
    for (const f of this.early.get(channel) ?? []) stream(f);
    this.early.delete(channel);
  }

  credit(channel: number, bytes: number) { this.send(channel, CREDIT, u32(bytes)); }

  /** Stop listening and tell the core. */
  close(channel: number) { this.streams.delete(channel); this.send(channel, CLOSE); }

  /** Subscribe to events: the snapshot, then each notification as it arrives. */
  async subscribe(onMessage: (m: { method: string; params: any }) => void): Promise<{ seq: number; terminals: any[] }> {
    const r = await this.call('events.subscribe');
    let rest = '';
    const sdec = new TextDecoder(); // its own: stream mode keeps state
    this.listen(r.channel, (f) => {
      if (f.kind !== DATA) return;
      this.credit(r.channel, f.payload.length);
      const lines = (rest + sdec.decode(f.payload, { stream: true })).split('\n');
      rest = lines.pop()!;
      for (const line of lines) if (line) onMessage(JSON.parse(line));
    });
    return r;
  }
}
