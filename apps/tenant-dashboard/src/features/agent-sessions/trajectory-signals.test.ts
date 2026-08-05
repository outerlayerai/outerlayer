/**
 * Tests: findEditRetryLoop — the stuck-retry pattern over a session's span
 * sequence. Pure input→output; the bug classes pinned are the run-boundary
 * rules (a success resets, a DIFFERENT file doesn't extend a run, order
 * matters) and the ≥3 threshold.
 */

import { findEditRetryLoop, type TrajectorySpan } from './trajectory-signals';

const edit = (file: string, status: 'ok' | 'error' | 'rejected'): TrajectorySpan => ({
  name: 'agent.tool.Edit',
  statusCode: status === 'error' ? '2' : '1',
  metadata: { isEdit: '1', file, toolStatus: status },
});

const bash = (status: 'ok' | 'error'): TrajectorySpan => ({
  name: 'agent.tool.Bash',
  statusCode: status === 'error' ? '2' : '1',
  metadata: { toolStatus: status },
});

describe('findEditRetryLoop', () => {
  it('finds the longest consecutive failed-edit run to one file', () => {
    const spans = [
      edit('a.ts', 'error'),
      edit('a.ts', 'error'),
      edit('a.ts', 'error'),
      edit('a.ts', 'error'),
    ];
    expect(findEditRetryLoop(spans)).toEqual({ file: 'a.ts', fails: 4 });
  });

  it('returns null below the ≥3 threshold — two failures is friction, not a loop', () => {
    expect(findEditRetryLoop([edit('a.ts', 'error'), edit('a.ts', 'error')])).toBeNull();
  });

  it('a successful edit to the file RESETS its run (order matters)', () => {
    const spans = [
      edit('a.ts', 'error'),
      edit('a.ts', 'error'),
      edit('a.ts', 'ok'),
      edit('a.ts', 'error'),
      edit('a.ts', 'error'),
    ];
    expect(findEditRetryLoop(spans)).toBeNull();
  });

  it('failures to DIFFERENT files never merge into one run, but each file tracks its own', () => {
    const spans = [
      edit('a.ts', 'error'),
      edit('b.ts', 'error'),
      edit('a.ts', 'error'),
      edit('b.ts', 'error'),
      edit('a.ts', 'error'),
    ];
    // a.ts fails 3× with no intervening success to a.ts — b.ts edits don't reset it.
    expect(findEditRetryLoop(spans)).toEqual({ file: 'a.ts', fails: 3 });
  });

  it('non-edit tool failures (Bash) neither extend nor reset an edit run', () => {
    const spans = [
      edit('a.ts', 'error'),
      bash('error'),
      edit('a.ts', 'error'),
      bash('ok'),
      edit('a.ts', 'error'),
    ];
    expect(findEditRetryLoop(spans)).toEqual({ file: 'a.ts', fails: 3 });
  });

  it('a rejected edit is not a failure — it resets the run like a success', () => {
    const spans = [
      edit('a.ts', 'error'),
      edit('a.ts', 'error'),
      edit('a.ts', 'rejected'),
      edit('a.ts', 'error'),
    ];
    expect(findEditRetryLoop(spans)).toBeNull();
  });

  it('ignores non-tool spans and edits with no file', () => {
    const spans: TrajectorySpan[] = [
      { name: 'agent.turn.assistant', statusCode: '2', metadata: {} },
      { name: 'agent.tool.Edit', statusCode: '2', metadata: { isEdit: '1' } }, // no file
      edit('a.ts', 'error'),
    ];
    expect(findEditRetryLoop(spans)).toBeNull();
  });
});
