// Claude Code back after a restart. When the box or herdr-core restarts, a kept terminal gets a fresh shell
// and herdr-core never re-runs what was in it, so Claude Code is gone. The bridge notes in a label which
// Claude session each terminal's shell is running, and resumes it there once that shell has been replaced.
import { claudeSession } from './chat.ts';
import { rpc } from './core.ts';
import type { Term } from './push.ts';

export const LABEL = 'herdr-pwa.claude'; // "<shell pid> <session id>"

// Only a session with a transcript: one nobody wrote in yet can't be resumed.
const withTranscript = (pid: number) => { const s = claudeSession(pid); return s?.file ? s.session : null; };

/** What one terminal needs: a new label value ('' clears it), and a command to type into it. */
export function resumeStep(t: Term, session: (pid: number) => string | null = withTranscript): { label?: string; send?: string } | null {
  if (t.address.includes('/') || t.state !== 'live' || !t.pid) return null; // another machine, or waiting for its shell
  const noted = t.labels?.[LABEL] ?? '';
  const fg = t.foreground;
  if (fg?.name === 'claude' && fg.pid) {
    const s = session(fg.pid);
    return s && noted !== `${t.pid} ${s}` ? { label: `${t.pid} ${s}` } : null; // also follows /resume and /clear
  }
  if (!noted) return null;
  const [shell, s = ''] = noted.split(' ');
  // The same shell: Claude Code was quit in it, so leave it be. Another shell: Claude Code was lost with the old one.
  if (shell === String(t.pid) || !/^[\w-]+$/.test(s)) return { label: '' };
  return { label: '', send: `claude --resume ${s}` };
}

const resumed = new Set<string>(); // "<address> <shell pid>": events can repeat before the cleared label comes back

export async function resume(t: Term) {
  const step = resumeStep(t);
  if (!step || (step.send && resumed.has(`${t.address} ${t.pid}`))) return;
  if (step.send) resumed.add(`${t.address} ${t.pid}`);
  try {
    if (step.label !== undefined) await rpc('terminal.label', { terminal: t.address, labels: { [LABEL]: step.label } });
    if (step.send) { await rpc('terminal.send', { terminal: t.address, text: step.send }); console.log(`resumed Claude Code in ${t.address}: ${step.send}`); }
  } catch (e) { console.warn(`resume in ${t.address}:`, (e as Error).message); }
}
