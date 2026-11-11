// What changed in a space's folder: not committed, or on the branch since it left the default branch.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { parsePatch, type FileDiff } from '../shared/patch.ts';
import { git } from './state.ts';

type Changes = { base: string; patch: string; truncated: boolean };
const MAX_LINES = 1500;

function File({ file, onFile }: { file: FileDiff; onFile: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <details class="diff-file" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span class="diff-path">{file.path}</span>
        <span class="diff-count"><span class="add">+{file.added}</span> <span class="del">−{file.removed}</span></span>
      </summary>
      {open && (
        <>
          <button class="file-link" onClick={() => onFile(file.path)}>Open the file</button>
          {file.binary ? <p class="empty">Binary file.</p> : (
            <pre class="code diff">
              {file.lines.slice(0, MAX_LINES).map((l, i) => (
                <span key={i} class={l.kind}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : l.kind === 'ctx' ? ' ' : ''}{l.text}{'\n'}</span>
              ))}
              {file.lines.length > MAX_LINES && <span class="meta">… {file.lines.length - MAX_LINES} more lines; open the file to see it all.{'\n'}</span>}
            </pre>
          )}
        </>
      )}
    </details>
  );
}

export function ChangesView({ machine, folder, onFile }: { machine: string; folder: string; onFile: (path: string) => void }) {
  const [mode, setMode] = useState<'head' | 'branch'>('head');
  const [data, setData] = useState<Changes | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let stale = false;
    setData(null); setError('');
    git<Changes>('changes', machine, folder, { mode }).then((d) => { if (!stale) setData(d); }, (e) => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, [machine, folder, mode, tick]);
  const files = useMemo(() => (data ? parsePatch(data.patch) : []), [data]);
  const added = files.reduce((n, f) => n + f.added, 0), removed = files.reduce((n, f) => n + f.removed, 0);

  return (
    <div class="changes">
      <div class="changes-bar">
        <div class="views" role="group" aria-label="Compare with">
          <button aria-pressed={mode === 'head'} onClick={() => setMode('head')}>Uncommitted</button>
          <button aria-pressed={mode === 'branch'} onClick={() => setMode('branch')}>Branch</button>
        </div>
        <button class="icon" aria-label="Refresh" onClick={() => setTick((n) => n + 1)}>↻</button>
      </div>
      <div class="changes-scroll">
        {error && <p class="error pad" role="alert">{error}</p>}
        {!data && !error && <p class="empty">Loading…</p>}
        {data && (
          <p class="note">
            {files.length === 0 ? `Nothing changed (${data.base}).` : `${files.length} file${files.length === 1 ? '' : 's'} ${data.base}: +${added} −${removed}`}
            {data.truncated && ' The patch was too large and is cut short.'}
          </p>
        )}
        {files.map((f) => <File key={f.path} file={f} onFile={onFile} />)}
      </div>
    </div>
  );
}
