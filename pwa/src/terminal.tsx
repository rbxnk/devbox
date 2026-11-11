// A real terminal (Ghostty, as WASM) on an hc attach stream.
import { useEffect, useRef, useState } from 'preact/hooks';
import { FitAddon, Terminal, init } from 'ghostty-web';
import { CLOSE, DATA, RESIZE, size } from '../shared/frames.ts';
import { hc, useApp } from './state.ts';

const ready = init();
const enc = new TextEncoder();

// Keys a phone keyboard lacks, as the bytes a terminal sends for them.
const KEYS: [label: string, bytes: string][] = [
  ['esc', '\x1b'], ['tab', '\t'], ['⇧tab', '\x1b[Z'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'],
  ['^C', '\x03'], ['^D', '\x04'], ['^R', '\x12'], ['^L', '\x0c'], ['⏎', '\r'],
];

export function TerminalView({ address }: { address: string }) {
  const box = useRef<HTMLDivElement>(null);
  const sendRef = useRef<(s: string) => void>(() => {});
  const [ended, setEnded] = useState<string | null>(null);
  const conn = useApp((s) => s.conn);
  // A kept terminal that lost its program gets a new shell: attach again then.
  const pid = useApp((s) => s.terminals[address]?.pid);

  useEffect(() => {
    if (conn !== 'open') return;
    let dead = false, channel: number | undefined, term: Terminal | undefined, observer: ResizeObserver | undefined;
    setEnded(null);
    (async () => {
      await ready;
      if (dead || !box.current) return;
      const css = getComputedStyle(document.documentElement);
      term = new Terminal({
        fontSize: 13, cursorBlink: true, scrollback: 5000,
        fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
        theme: { background: css.getPropertyValue('--term-bg').trim(), foreground: css.getPropertyValue('--term-fg').trim() },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(box.current);
      fit.fit();
      const t = term;
      let r;
      try {
        r = await hc.call('terminal.attach', { terminal: address, cols: t.cols, rows: t.rows, history: 2000 });
      } catch (e) { if (!dead) setEnded((e as Error).message); return; }
      if (dead) { hc.close(r.channel); return; }
      const ch = channel = r.channel as number;
      hc.listen(ch, (f) => {
        if (f.kind === DATA) t.write(f.payload, () => hc.credit(ch, f.payload.length)); // credit once drawn: the core's flow control
        else if (f.kind === CLOSE) { channel = undefined; setEnded('ended'); }
      });
      sendRef.current = (s) => { if (channel !== undefined) hc.send(ch, DATA, enc.encode(s)); };
      t.onData((s) => sendRef.current(s));
      t.onResize(({ cols, rows }) => { if (channel !== undefined) hc.send(ch, RESIZE, size(cols, rows)); });
      observer = new ResizeObserver(() => fit.fit());
      observer.observe(box.current!);
    })();
    return () => {
      dead = true;
      observer?.disconnect();
      if (channel !== undefined) hc.close(channel);
      sendRef.current = () => {};
      term?.dispose();
    };
  }, [address, conn, pid]);

  return (
    <div class="term">
      <div class="term-screen" ref={box} />
      {ended && <div class="term-ended">{ended === 'ended' ? 'This terminal has ended.' : ended}</div>}
      <div class="keys" role="toolbar" aria-label="Terminal keys">
        {KEYS.map(([label, bytes]) => (
          // pointerdown + preventDefault keeps the on-screen keyboard open.
          <button key={label} onPointerDown={(e) => { e.preventDefault(); sendRef.current(bytes); }}>{label}</button>
        ))}
      </div>
    </div>
  );
}
