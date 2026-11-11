// Web Push when an agent needs a person or finishes a turn. The bridge watches hc's events itself,
// so this works with no app open.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as webpush from 'web-push';
import type { PushSubscription } from 'web-push';

type Term = { address: string; state?: string; title?: string; turn?: number; labels?: Record<string, string>; status?: { state?: string; msg?: string } | null; foreground?: { name?: string } | null };
export type Note = { title: string; body: string; url: string; tag: string };

const nameOf = (t: Term) => t.title || t.foreground?.name || t.address;
const url = (t: Term) => `/#/t/${encodeURIComponent(t.address)}`;

/**
 * The notification an event calls for, if any. Blocked: the moment it happens. Done: on the `turn`
 * event (docs/labels.md), unless the turn ended on a question, which was already announced.
 */
export function noteFor(before: Term | undefined, ev: { type: string; data: any }, after: Term): Note | null {
  if (ev.type === 'status') {
    const was = before?.status?.state, now = after.status?.state;
    if (now === 'blocked' && was !== 'blocked') return { title: `Needs you: ${nameOf(after)}`, body: after.status?.msg ?? '', url: url(after), tag: after.address };
    if (now === 'error' && was !== 'error') return { title: `Error: ${nameOf(after)}`, body: after.status?.msg ?? '', url: url(after), tag: after.address };
  }
  if (ev.type === 'turn' && ev.data?.state !== 'blocked' && ev.data?.state !== 'error') {
    return { title: `Done: ${nameOf(after)}`, body: after.status?.msg ?? '', url: url(after), tag: after.address };
  }
  return null;
}

/** Still worth sending after a short wait: nobody answered it or looked at it meanwhile. */
export function stillNews(note: Note, now: Term | undefined): boolean {
  if (!now || now.state === 'finished') return false;
  if (note.title.startsWith('Needs you')) return now.status?.state === 'blocked';
  if (note.title.startsWith('Error')) return now.status?.state === 'error';
  const seen = now.labels?.['herdr.seen'];
  return !(seen !== undefined && Number(seen) >= (now.turn ?? 0)); // a herdr client on screen marks it seen
}

type Store = { vapid: { publicKey: string; privateKey: string }; subs: PushSubscription[]; subject?: string };

export class Push {
  private file: string;
  private store: Store;
  private terms = new Map<string, Term>();
  private stopped = false;
  private hc?: ReturnType<typeof spawn>;
  private hcBin: string;

  constructor(dir: string, hcBin = 'herdr-core') {
    this.hcBin = hcBin;
    this.file = path.join(dir, 'push.json');
    let store: Store | undefined;
    try { store = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    this.store = store?.vapid?.publicKey ? { ...store, subs: store.subs ?? [] } : { vapid: webpush.generateVAPIDKeys(), subs: [] };
    if (!store?.vapid?.publicKey) this.save();
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.store), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get key() { return this.store.vapid.publicKey; }
  get count() { return this.store.subs.length; }

  subscribe(sub: PushSubscription) {
    if (typeof sub?.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('bad subscription');
    this.store.subs = [...this.store.subs.filter((s) => s.endpoint !== sub.endpoint), { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }];
    this.save();
  }

  unsubscribe(endpoint: string) {
    const n = this.store.subs.length;
    this.store.subs = this.store.subs.filter((s) => s.endpoint !== endpoint);
    if (this.store.subs.length !== n) this.save();
  }

  async send(note: Note) {
    // The contact a push service may ask for; nothing personal unless push.json gives one.
    const subject = this.store.subject ?? 'mailto:push@herdr-pwa.invalid';
    await Promise.all(this.store.subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, JSON.stringify(note), { TTL: 3600, urgency: 'high', vapidDetails: { subject, ...this.store.vapid } });
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) this.unsubscribe(sub.endpoint); // the browser dropped it
        else console.warn('push failed:', e?.statusCode ?? e?.message);
      }
    }));
  }

  /** Follows hc's events for as long as the bridge runs, reconnecting when the core restarts. */
  watch() {
    if (this.stopped) return;
    const hc = this.hc = spawn(this.hcBin, ['connect'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let rest = '';
    hc.on('error', () => {});
    hc.stdin!.on('error', () => {});
    hc.on('exit', () => { if (!this.stopped) setTimeout(() => this.watch(), 5000); });
    hc.stdout!.on('data', (chunk: Buffer) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop()!;
      for (const line of lines) { try { this.take(JSON.parse(line)); } catch {} }
    });
    hc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events.subscribe', params: {} }) + '\n');
  }

  stop() { this.stopped = true; this.hc?.kill(); }

  private take(m: any) {
    const snapshot: Term[] | undefined = m.result?.terminals ?? (m.method === 'missed' ? m.params.terminals : undefined);
    if (snapshot) { this.terms = new Map(snapshot.map((t) => [t.address, t])); return; }
    if (m.method !== 'event' || !m.params?.terminal) return;
    const { terminal: a, type, data } = m.params;
    const before = this.terms.get(a);
    // Only the fields notifications read; the app keeps the full picture (shared/model.ts).
    let after: Term | undefined;
    if (type === 'created' || type === 'restarted') after = data;
    else if (type === 'removed') { this.terms.delete(a); return; }
    else if (!before) return;
    else if (type === 'status') after = { ...before, status: data.status };
    else if (type === 'turn') after = { ...before, turn: data.turn };
    else if (type === 'title') after = { ...before, title: data.title };
    else if (type === 'labels') after = { ...before, labels: data.labels };
    else if (type === 'finished') after = { ...before, state: 'finished' };
    else if (type === 'foreground') after = { ...before, foreground: data };
    else return;
    this.terms.set(a, after!);
    const note = this.count ? noteFor(before, { type, data }, after!) : null;
    // A moment's wait: someone watching in a herdr app answers or is marked as having seen it.
    if (note) setTimeout(() => { if (stillNews(note, this.terms.get(a))) void this.send(note); }, 4000);
  }
}
