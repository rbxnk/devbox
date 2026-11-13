import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LABEL, resumeStep } from './resume.ts';
import type { Term } from './push.ts';

const claude = { pid: 97, name: 'claude' }, bash = { pid: 52, name: 'bash' };
const sessions = (pid: number) => (pid === 97 ? 'abc-1' : null);
const term = (pid: number | null, foreground: any, noted?: string): Term =>
  ({ address: 't1', state: 'live', pid, foreground, labels: noted === undefined ? {} : { [LABEL]: noted } as Record<string, string> });

test('notes the session Claude Code runs, and follows it', () => {
  assert.deepEqual(resumeStep(term(52, claude), sessions), { label: '52 abc-1' });
  assert.equal(resumeStep(term(52, claude, '52 abc-1'), sessions), null);
  assert.deepEqual(resumeStep(term(52, claude, '52 old'), sessions), { label: '52 abc-1' }); // after /resume or /clear
  assert.equal(resumeStep(term(52, { pid: 98, name: 'claude' }), sessions), null); // no session file yet
});

test('resumes only in a replaced shell', () => {
  assert.deepEqual(resumeStep(term(60, null, '52 abc-1'), sessions), { label: '', send: 'claude --resume abc-1' });
  assert.deepEqual(resumeStep(term(60, bash, '52 abc-1'), sessions), { label: '', send: 'claude --resume abc-1' });
  assert.deepEqual(resumeStep(term(52, bash, '52 abc-1'), sessions), { label: '' }); // Claude Code was quit
  assert.deepEqual(resumeStep(term(60, bash, '52 $(rm -rf ~)'), sessions), { label: '' }); // never types a bad label
  assert.equal(resumeStep(term(null, null, '52 abc-1'), sessions), null); // lost, waiting for its shell
  assert.equal(resumeStep(term(60, bash), sessions), null);
  assert.equal(resumeStep({ ...term(60, bash, '52 abc-1'), address: 'mac/t1' }, sessions), null);
  assert.equal(resumeStep({ ...term(60, bash, '52 abc-1'), state: 'finished' }, sessions), null);
});
