import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Push, noteFor, stillNews } from './push.ts';

const t = (o: object = {}) => ({ address: 't7', title: 'Fix login', turn: 3, labels: { 'herdr.seen': '2' }, status: { state: 'working', msg: 'editing' }, ...o });

test('which events notify', () => {
  const blocked = t({ status: { state: 'blocked', msg: 'approve Bash: ls' } });
  assert.deepEqual(noteFor(t(), { type: 'status', data: {} }, blocked), { title: 'Needs you: Fix login', body: 'approve Bash: ls', url: '/#/t/t7', tag: 't7' });
  assert.equal(noteFor(blocked, { type: 'status', data: {} }, blocked), null); // still blocked: said once
  assert.equal(noteFor(t(), { type: 'status', data: {} }, t({ status: { state: 'done' } })), null); // done waits for the turn event
  assert.equal(noteFor(t(), { type: 'turn', data: { turn: 3, state: 'done' } }, t({ status: { state: 'done', msg: '' } }))!.title, 'Done: Fix login');
  assert.equal(noteFor(t(), { type: 'turn', data: { turn: 3, state: 'blocked' } }, blocked), null); // a turn that ended on a question
  assert.equal(noteFor(t(), { type: 'title', data: {} }, t()), null);
  assert.equal(noteFor(undefined, { type: 'status', data: {} }, { address: 'box/t1', status: { state: 'blocked' } })!.url, '/#/t/box%2Ft1');
});

test('nothing is sent for what was answered or seen meanwhile', () => {
  const needs = { title: 'Needs you: x', body: '', url: '', tag: 't7' }, done = { title: 'Done: x', body: '', url: '', tag: 't7' };
  assert.equal(stillNews(needs, t({ status: { state: 'blocked' } })), true);
  assert.equal(stillNews(needs, t()), false);
  assert.equal(stillNews(done, t()), true);                                  // turn 3, seen 2
  assert.equal(stillNews(done, t({ labels: { 'herdr.seen': '3' } })), false);
  assert.equal(stillNews(done, t({ labels: {} })), true);                    // no label: nobody has said they saw it
  assert.equal(stillNews(done, undefined), false);
});

test('keys and subscriptions are kept, privately', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
  try {
    const p = new Push(dir);
    assert.ok(p.key.length > 80);
    p.subscribe({ endpoint: 'https://push.example/a', keys: { p256dh: 'k', auth: 'a' } });
    p.subscribe({ endpoint: 'https://push.example/a', keys: { p256dh: 'k2', auth: 'a' } }); // same browser again
    assert.throws(() => p.subscribe({ endpoint: 'http://insecure/x', keys: { p256dh: 'k', auth: 'a' } }));
    assert.throws(() => p.subscribe({ endpoint: 'https://push.example/b' } as any));
    const again = new Push(dir);
    assert.deepEqual([again.key, again.count], [p.key, 1]);
    assert.equal(fs.statSync(path.join(dir, 'push.json')).mode & 0o777, 0o600);
    again.unsubscribe('https://push.example/a');
    assert.equal(new Push(dir).count, 0);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
