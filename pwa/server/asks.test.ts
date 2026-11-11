import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installHook, watchResolved } from './asks.ts';

test('the hook is added once and other hooks are kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-'));
  const file = path.join(dir, 'settings.json');
  try {
    assert.equal(installHook(file, 8787), true); // no file yet
    fs.writeFileSync(file, JSON.stringify({ theme: 'dark', hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'other' }] }] } }));
    assert.equal(installHook(file, 8787), true);
    assert.equal(installHook(file, 8787), false); // nothing to change
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(s.theme, 'dark');
    assert.deepEqual(s.hooks.PermissionRequest.map((g: any) => g.hooks[0].command ?? g.hooks[0].url), ['other', 'http://127.0.0.1:8787/hook/ask']);
    assert.equal(installHook(file, 9000), true); // a new port replaces ours
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PermissionRequest.length, 2);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('a request is over when its tool call has a result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-'));
  const file = path.join(dir, 't.jsonl');
  const line = (o: object) => fs.appendFileSync(file, JSON.stringify(o) + '\n');
  try {
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'A', name: 'Bash', input: { command: 'ls' } }] } });
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'B', name: 'Bash', input: { command: 'rm x' } }] } });
    let over = false;
    const stop = watchResolved(file, 'Bash', { command: 'rm x' }, () => { over = true; });
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'A' }] } }); // another call's result
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(over, false);
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'B' }] } });
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(over, true);
    stop();
  } finally { fs.rmSync(dir, { recursive: true }); }
});
