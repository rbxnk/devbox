// The chat view of an agent session, built from its transcript (server/chat.ts).
import { memo } from 'preact/compat';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Control, Item } from '../server/chat.ts';
import type { Answer, Ask } from '../server/asks.ts';
import { claudeSuggestion } from '../shared/screen.ts';
import { shown, type Terminal } from '../shared/model.ts';
import { hc, token, useApp } from './state.ts';

type Tool = Extract<Item, { type: 'tool' }>;
type Result = Extract<Item, { type: 'result' }>;
type Message = Exclude<Item, Result>;
type Chat = { state: 'loading' | 'ready' | 'none'; messages: Message[]; results: Map<string, Result>; asks: Ask[] };
const empty = (state: Chat['state']): Chat => ({ state, messages: [], results: new Map(), asks: [] });

// Links leave the app; nothing a model wrote may script it.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
});
const Markdown = memo(({ text }: { text: string }) => {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: false })), [text]);
  return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />;
});

/** Follows a Claude Code process's chat for as long as the component shows it. */
function useChat(pid: number | undefined): Chat {
  const [chat, setChat] = useState<Chat>(empty('loading'));
  useEffect(() => {
    if (!pid) { setChat(empty('none')); return; }
    const abort = new AbortController();
    let next = empty('loading');
    let frame = 0;
    const flush = () => { frame = 0; setChat({ ...next }); };
    const take = (item: Item | Control) => {
      if (item.type === 'reset') next = empty('loading');
      else if (item.type === 'none') next = empty('none');
      else if (item.type === 'ready') next.state = 'ready';
      else if (item.type === 'asks') next.asks = item.asks;
      else if (item.type === 'result') next.results.set(item.id, item);
      else next.messages.push(item);
      frame ||= requestAnimationFrame(flush); // a long history arrives as thousands of items: draw once per frame
    };
    (async () => {
      for (let wait = 500; !abort.signal.aborted; wait = Math.min(wait * 2, 10_000)) {
        try {
          const res = await fetch(`/api/chat?pid=${pid}`, { headers: { authorization: `Bearer ${token}` }, signal: abort.signal });
          if (!res.ok || !res.body) throw new Error(String(res.status));
          take({ type: 'reset' });
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          for (let rest = ''; ;) {
            const { done, value } = await reader.read();
            if (done) break;
            const lines = (rest + value).split('\n');
            rest = lines.pop()!;
            for (const line of lines) if (line) { take(JSON.parse(line)); wait = 500; }
          }
        } catch { /* the stream dropped: try again below */ }
        await new Promise((r) => setTimeout(r, wait));
      }
    })();
    return () => { abort.abort(); cancelAnimationFrame(frame); };
  }, [pid]);
  return chat;
}

const base = (p: unknown) => String(p ?? '').split('/').pop() ?? '';
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));

/** One line that says what a tool call did. */
function summary(t: Tool): [verb: string, what: string] {
  const i = t.input;
  switch (t.name) {
    case 'Bash': return ['Ran', str(i.description) || str(i.command)];
    case 'Read': return ['Read', base(i.file_path)];
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return ['Edited', base(i.file_path ?? i.notebook_path)];
    case 'Write': return ['Wrote', base(i.file_path)];
    case 'Grep': case 'Glob': return ['Searched', str(i.pattern)];
    case 'WebFetch': return ['Fetched', str(i.url)];
    case 'WebSearch': return ['Searched the web', str(i.query)];
    case 'Agent': case 'Task': return ['Agent', str(i.description)];
    case 'TodoWrite': return ['Updated', 'the to-do list'];
    case 'AskUserQuestion': return ['Asked', str((i.questions as any)?.[0]?.question)];
    default: return [t.name.replace(/^mcp__/, '').replace(/__/g, ' · '), str(Object.values(i).find((v) => typeof v === 'string'))];
  }
}

function ToolBody({ tool, result, onFile }: { tool: Tool; result?: Result; onFile?: (path: string) => void }) {
  const i = tool.input;
  const file = str(i.file_path ?? i.notebook_path);
  return (
    <div class="tool-body">
      {file && <button class="file-link" onClick={() => onFile?.(file)} disabled={!onFile}>{file}</button>}
      {tool.name === 'Bash' && <pre class="code">{str(i.command)}</pre>}
      {(tool.name === 'Edit' || tool.name === 'MultiEdit') && (
        <pre class="code diff">
          {((i.edits as any[]) ?? [i]).map((e) => [
            ...str(e.old_string).split('\n').map((l) => <span class="del">- {l}{'\n'}</span>),
            ...str(e.new_string).split('\n').map((l) => <span class="add">+ {l}{'\n'}</span>),
          ])}
        </pre>
      )}
      {tool.name === 'Write' && <pre class="code">{str(i.content)}</pre>}
      {!['Bash', 'Edit', 'MultiEdit', 'Write', 'Read'].includes(tool.name) && <pre class="code">{JSON.stringify(i, null, 2)}</pre>}
      {result?.text && <pre class={`code out${result.error ? ' err' : ''}`}>{result.text}</pre>}
    </div>
  );
}

const ToolRow = memo(({ tool, result, onFile }: { tool: Tool; result?: Result; onFile?: (path: string) => void }) => {
  const [verb, what] = summary(tool);
  const [open, setOpen] = useState(false);
  return (
    <details class={`tool${result?.error ? ' failed' : ''}`} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span class="tool-verb">{verb}</span> <span class="tool-what">{what}</span>
        {!result && <span class="tool-wait" aria-label="running" />}
        {result?.error && <span class="tool-flag">failed</span>}
      </summary>
      {open && <ToolBody tool={tool} result={result} onFile={onFile} />}
    </details>
  );
});

const api = (path: string, body: unknown) =>
  fetch(path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** What a suggested "don't ask again" would do, in words. */
function remember(s: any): string {
  if (s?.type === 'addRules') return `Always allow ${(s.rules ?? []).map((r: any) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join(', ')}`;
  if (s?.type === 'addDirectories') return `Allow, and trust ${(s.directories ?? []).map(base).join(', ')}`;
  if (s?.type === 'setMode') return `Allow, and switch to ${s.mode} mode`;
  return 'Allow, and remember';
}

type Question = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] };

/** Something Claude Code is asking right now: a permission, a question, or a plan to approve. */
function AskCard({ ask, onFile }: { ask: Ask; onFile?: (path: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [denying, setDenying] = useState(false);
  const [why, setWhy] = useState('');
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const reply = async (a: Answer) => { setBusy(true); try { await api('/api/answer', { id: ask.id, ...a }); } finally { setBusy(false); } };
  const deny = (
    <>
      {denying && <input aria-label="What Claude should do instead" placeholder="Tell Claude what to do instead (optional)" value={why} onInput={(e) => setWhy(e.currentTarget.value)} />}
      <button class="choice danger" disabled={busy} onClick={() => (denying ? reply({ behavior: 'deny', ...(why.trim() ? { message: why.trim() } : {}) }) : setDenying(true))}>
        {denying ? 'Send' : ask.tool === 'ExitPlanMode' ? 'Keep planning' : 'No'}
      </button>
    </>
  );

  if (ask.tool === 'AskUserQuestion') {
    const questions = (ask.input.questions as Question[]) ?? [];
    const answerOf = (q: Question) => [...(picked[q.question] ?? []), ...(other[q.question]?.trim() ? [other[q.question].trim()] : [])];
    const complete = questions.every((q) => answerOf(q).length > 0);
    return (
      <div class="ask">
        {questions.map((q) => (
          <fieldset key={q.question} class="question">
            <legend>{q.question}</legend>
            {q.options.map((o) => {
              const on = picked[q.question]?.includes(o.label) ?? false;
              return (
                <button key={o.label} type="button" class="choice" aria-pressed={on} onClick={() => {
                  setPicked((p) => ({ ...p, [q.question]: q.multiSelect ? (on ? p[q.question].filter((l) => l !== o.label) : [...(p[q.question] ?? []), o.label]) : [o.label] }));
                  if (!q.multiSelect) setOther((x) => ({ ...x, [q.question]: '' }));
                }}>
                  <span>{o.label}</span>{o.description && <span class="choice-sub">{o.description}</span>}
                </button>
              );
            })}
            <input aria-label={`Another answer to: ${q.question}`} placeholder="Something else…" value={other[q.question] ?? ''} onInput={(e) => {
              const v = e.currentTarget.value;
              setOther((x) => ({ ...x, [q.question]: v }));
              if (!q.multiSelect && v) setPicked((p) => ({ ...p, [q.question]: [] }));
            }} />
          </fieldset>
        ))}
        <button class="primary" disabled={busy || !complete} onClick={() => reply({
          behavior: 'allow',
          // Claude Code reads the answers from the tool's own input: question text to the chosen label(s).
          updatedInput: { ...ask.input, answers: Object.fromEntries(questions.map((q) => [q.question, answerOf(q).join(', ')])) },
        })}>Answer</button>
      </div>
    );
  }

  if (ask.tool === 'ExitPlanMode') {
    return (
      <div class="ask">
        <p class="ask-title">Claude's plan</p>
        <Markdown text={str(ask.input.plan) || 'Ready to start.'} />
        <button class="primary" disabled={busy} onClick={() => reply({ behavior: 'allow', updatedInput: ask.input })}>Approve plan</button>
        {deny}
      </div>
    );
  }

  const tool: Tool = { type: 'tool', id: ask.id, name: ask.tool, input: ask.input };
  const what = summary(tool)[1];
  return (
    <div class="ask">
      <p class="ask-title">Allow {ask.tool}? <span class="tool-what">{what}</span></p>
      <ToolBody tool={tool} onFile={onFile} />
      <button class="primary" disabled={busy} onClick={() => reply({ behavior: 'allow' })}>Yes</button>
      {ask.suggestions.map((s, i) => (
        <button key={i} class="choice" disabled={busy} onClick={() => reply({ behavior: 'allow', updatedPermissions: [s] })}>{remember(s)}</button>
      ))}
      {deny}
    </div>
  );
}

const PAGE = 150;

export function ChatView({ address, t, onFile, onTerminal }: {
  address: string; t: Terminal; onFile?: (path: string) => void; onTerminal: () => void;
}) {
  const chat = useChat(t.foreground?.pid);
  const conn = useApp((s) => s.conn);
  const [limit, setLimit] = useState(PAGE);
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState<string[]>([]); // sent, not yet in the transcript
  const [error, setError] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // The box grows with what is typed, and shrinks back once it is sent.
  useLayoutEffect(() => {
    const el = box.current;
    if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 160)}px`; }
  }, [draft]);
  const stuck = useRef(true); // following the newest message
  const state = shown(t);

  // Claude Code's suggested next prompt sits in its input box a moment after a turn ends: read it off the screen.
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const settled = state === 'idle' || state === 'done';
  useEffect(() => {
    setSuggestion(null);
    if (!settled || conn !== 'open') return;
    const look = () => hc.call('terminal.read', { terminal: address }).then((r) => setSuggestion(claudeSuggestion(r.text))).catch(() => {});
    const timers = [1500, 5000].map((ms) => setTimeout(look, ms));
    return () => timers.forEach(clearTimeout);
  }, [address, settled, t.turn, conn]);

  // A sent message leaves the waiting list once the transcript has it.
  const pending = sent.filter((s) => !chat.messages.slice(-20).some((m) => m.type === 'user' && m.text.trim() === s.trim()));
  const visible = chat.messages.slice(-limit);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [chat, pending.length, state, suggestion]);

  // A picture goes to a file beside the terminal (hc's terminal.put); its path goes in the message for Claude to read.
  const [attaching, setAttaching] = useState(false);
  const attach = async (files: FileList | null) => {
    setError('');
    setAttaching(true);
    try {
      for (const f of Array.from(files ?? [])) {
        if (f.size > 8 << 20) throw new Error(`${f.name} is larger than 8 MB.`);
        const bytes = new Uint8Array(await f.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const r = await hc.call('terminal.put', { terminal: address, name: f.name || 'image.png', data: btoa(bin) });
        setDraft((d) => `${d}${d && !/\s$/.test(d) ? ' ' : ''}${r.path} `);
      }
      box.current?.focus();
    } catch (e) { setError((e as Error).message); } finally { setAttaching(false); }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setError('');
    setDraft('');
    setSent((s) => [...s.slice(-5), text]);
    stuck.current = true;
    try { await hc.call('terminal.send', { terminal: address, text }); }
    catch (e) { setSent((s) => s.filter((x) => x !== text)); setDraft(text); setError((e as Error).message); }
  };

  if (chat.state === 'none') {
    return (
      <div class="chat">
        <div class="chat-empty">
          <p>No Claude Code session is running in this terminal.</p>
          <button class="primary" onClick={onTerminal}>Open the terminal</button>
        </div>
      </div>
    );
  }

  return (
    <div class="chat">
      <div class="chat-scroll" ref={scroller} onScroll={(e) => {
        const el = e.currentTarget;
        stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}>
        {chat.messages.length > limit && (
          <button class="earlier" onClick={() => { stuck.current = false; setLimit((l) => l + PAGE); }}>Show earlier messages</button>
        )}
        {chat.state === 'loading' && <p class="empty">Loading…</p>}
        {chat.state === 'ready' && chat.messages.length === 0 && pending.length === 0 && <p class="empty">No messages yet. Say something below.</p>}
        {visible.map((m) =>
          m.type === 'tool' ? <ToolRow key={m.id} tool={m} result={chat.results.get(m.id)} onFile={onFile} />
            : m.type === 'user' ? <div key={m.id} class="bubble"><div class="bubble-text">{m.text}</div></div>
            : m.type === 'note' ? <p key={m.id} class="note">{m.text}</p>
            : <Markdown key={m.id} text={m.text} />)}
        {pending.map((text, i) => <div key={`p${i}`} class="bubble sending"><div class="bubble-text">{text}</div></div>)}
        {state === 'working' && <p class="working" role="status"><span class="dot dot-working" /> {t.status?.msg || 'Working…'}</p>}
        {chat.asks.map((ask) => <AskCard key={ask.id} ask={ask} onFile={onFile} />)}
        {state === 'blocked' && chat.asks.length === 0 && (
          <div class="ask" role="status">
            <p>{t.status?.msg || 'Claude is waiting for your answer.'}</p>
            <button class="primary" onClick={onTerminal}>Answer in the terminal</button>
          </div>
        )}
      </div>
      <form class="composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        {error && <p class="error" role="alert">{error}</p>}
        {suggestion && !draft && (
          <div class="chips">
            <button type="button" class="chip" aria-label={`Use suggested prompt: ${suggestion}`} onClick={() => { setDraft(suggestion); box.current?.focus(); }}>{suggestion}</button>
          </div>
        )}
        <div class="composer-row">
          <label class={`attach${attaching ? ' busy' : ''}`}>
            <span aria-hidden="true">+</span>
            <input type="file" accept="image/*" multiple aria-label="Attach an image" disabled={attaching || conn !== 'open'}
              onChange={(e) => { const el = e.currentTarget; void attach(el.files).then(() => { el.value = ''; }); }} />
          </label>
          <textarea
            aria-label="Message" placeholder={state === 'working' ? 'Queue a message…' : 'Message Claude…'} rows={1} value={draft}
            ref={box} onInput={(e) => setDraft(e.currentTarget.value)}
            // A keyboard sends with Enter; a phone's Enter makes a new line and the button sends.
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) { e.preventDefault(); void send(); } }}
          />
          {state === 'working' && !draft.trim()
            ? <button type="button" class="send stop" aria-label="Stop" onClick={() => hc.call('terminal.interrupt', { terminal: address }).catch((e) => setError(e.message))}>■</button>
            : <button type="submit" class="send" aria-label="Send" disabled={!draft.trim() || conn !== 'open'}>↑</button>}
        </div>
      </form>
    </div>
  );
}
