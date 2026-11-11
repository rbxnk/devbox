import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeSession, parseClaude } from './chat.ts';
import { tail } from './tail.ts';

const line = (o: object) => JSON.stringify({ uuid: 'u', timestamp: 't', ...o });
const user = (content: unknown, more = {}) => line({ type: 'user', message: { role: 'user', content }, ...more });
const asst = (content: unknown) => line({ type: 'assistant', message: { role: 'assistant', content } });

test('transcript lines become chat items', () => {
  assert.deepEqual(parseClaude(user('hi <system-reminder>secret</system-reminder>')), [{ type: 'user', id: 'u:0', text: 'hi', ts: 't' }]);
  assert.deepEqual(parseClaude(user('<system-reminder>only</system-reminder>')), []);
  assert.deepEqual(parseClaude(user('<command-name>/clear</command-name><command-args>x</command-args>'))[0], { type: 'user', id: 'u:0', text: '/clear x', ts: 't' });
  assert.equal(parseClaude(user('<local-command-stdout>done</local-command-stdout>'))[0].type, 'note');
  assert.deepEqual(parseClaude(user('x', { isMeta: true })), []);
  assert.deepEqual(parseClaude(user('x', { isSidechain: true })), []);
  assert.deepEqual(parseClaude(asst([{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'ok' }, { type: 'tool_use', id: 'tu', name: 'Bash', input: { command: 'ls' } }])), [
    { type: 'assistant', id: 'u:1', text: 'ok', ts: 't' },
    { type: 'tool', id: 'tu', name: 'Bash', input: { command: 'ls' }, ts: 't' },
  ]);
  assert.deepEqual(parseClaude(user([{ type: 'tool_result', tool_use_id: 'tu', is_error: true, content: [{ type: 'text', text: 'boom' }, { type: 'image' }] }])), [
    { type: 'result', id: 'tu', text: 'boom\n[image]', error: true },
  ]);
  const big = parseClaude(asst([{ type: 'tool_use', id: 'w', name: 'Write', input: { content: 'x'.repeat(40_000) } }]))[0] as any;
  assert.ok(big.input.content.length < 31_000 && big.input.content.endsWith('(truncated)'));
  for (const junk of ['', 'not json', '{"type":"mode"}', 'null', '{"type":"user"}']) assert.deepEqual(parseClaude(junk), []);
});

test('a process maps to its session transcript, and the tail yields whole lines once', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
  try {
    fs.mkdirSync(path.join(home, 'sessions')); fs.mkdirSync(path.join(home, 'projects', '-p'), { recursive: true });
    assert.equal(claudeSession(7, home), null);
    fs.writeFileSync(path.join(home, 'sessions', '7.json'), JSON.stringify({ sessionId: 'abc-1' }));
    assert.deepEqual(claudeSession(7, home), { session: 'abc-1', file: '' });
    const file = path.join(home, 'projects', '-p', 'abc-1.jsonl');
    fs.writeFileSync(file, 'one\ntw');
    assert.equal(claudeSession(7, home)!.file, file);
    fs.writeFileSync(path.join(home, 'sessions', '8.json'), JSON.stringify({ sessionId: '../../etc/passwd' }));
    assert.equal(claudeSession(8, home), null);
    const read = tail(file);
    assert.deepEqual(read(), ['one']);
    assert.deepEqual(read(), []);
    fs.appendFileSync(file, 'o\nthree\n');
    assert.deepEqual(read(), ['two', 'three']);
  } finally { fs.rmSync(home, { recursive: true }); }
});
