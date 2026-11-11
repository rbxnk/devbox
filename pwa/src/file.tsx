// A file's contents, read-only, through hc's file.read.
import { useEffect, useRef, useState } from 'preact/hooks';
import { hc } from './state.ts';

const LIMIT = 3000;

export function FileSheet({ machine, path, cwd, onClose }: { machine: string; path: string; cwd?: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [file, setFile] = useState<{ text: string; lines: number; last: number } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { ref.current?.showModal(); }, []);
  useEffect(() => {
    setFile(null); setError('');
    hc.call('file.read', { path, limit: LIMIT, ...(cwd ? { cwd } : {}), ...(machine ? { on: machine } : {}) })
      .then(setFile, (e) => setError(e.message));
  }, [machine, path, cwd]);
  return (
    <dialog ref={ref} class="sheet full" onClose={onClose} aria-label={path}>
      <header class="file-head">
        <span class="diff-path">{path}</span>
        <button class="icon" aria-label="Close" onClick={onClose}>✕</button>
      </header>
      {error && <p class="error pad" role="alert">{error}</p>}
      {!file && !error && <p class="empty">Loading…</p>}
      {file && <pre class="code file-text">{file.text}</pre>}
      {file && file.lines > file.last && <p class="note">Showing the first {file.last} of {file.lines} lines.</p>}
    </dialog>
  );
}
