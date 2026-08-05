// ---------------------------------------------------------------------------
// assessCollectionHealth - Unit Tests
//
// The policy that decides when the dashboard warns about a broken pipeline.
// Every case here corresponds to a real failure mode from the 15-week
// silent outage: errored collectors, never-registered schedulers, and dead
// CI record steps.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { assessCollectionHealth } from '../collection-health';

const NOW = new Date('2026-06-06T12:00:00.000Z');

function source(overrides: {
  source: string;
  last_collected_at?: string | null;
  last_run_at?: string | null;
  last_run_status?: string;
  last_error?: string | null;
}) {
  return {
    last_collected_at: null,
    last_run_at: null,
    last_run_status: 'success',
    last_error: null,
    ...overrides,
  };
}

function hoursBefore(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

describe('assessCollectionHealth', () => {
  it('returns no issues when all sources are fresh and successful', () => {
    const issues = assessCollectionHealth(
      [
        source({
          source: 'betterstack_incidents',
          last_collected_at: hoursBefore(0.5),
        }),
        source({ source: 'cd_push', last_collected_at: hoursBefore(20) }),
        source({ source: 'backfill', last_collected_at: hoursBefore(1000) }),
      ],
      NOW,
    );

    expect(issues).toEqual([]);
  });

  it('reports an error-level issue with the message when a source last errored', () => {
    const issues = assessCollectionHealth(
      [
        source({
          source: 'betterstack_incidents',
          last_run_status: 'error',
          last_error: 'BetterStack API error: 401 Unauthorized',
          last_collected_at: hoursBefore(1),
        }),
      ],
      NOW,
    );

    expect(issues).toEqual([
      {
        source: 'betterstack_incidents',
        level: 'error',
        message:
          'betterstack_incidents collection is failing: BetterStack API error: 401 Unauthorized',
      },
    ]);
  });

  it('warns when incident collection has never run at all', () => {
    const issues = assessCollectionHealth(
      [source({ source: 'cd_push', last_collected_at: hoursBefore(2) })],
      NOW,
    );

    expect(issues).toEqual([
      expect.objectContaining({
        source: 'betterstack_incidents',
        level: 'warning',
        message: expect.stringContaining('never run'),
      }),
    ]);
  });

  it('warns when incident collection is stale beyond 2 hours but not before', () => {
    const fresh = assessCollectionHealth(
      [
        source({
          source: 'betterstack_incidents',
          last_collected_at: hoursBefore(1.5),
        }),
      ],
      NOW,
    );
    const stale = assessCollectionHealth(
      [
        source({
          source: 'betterstack_incidents',
          last_collected_at: hoursBefore(3),
        }),
      ],
      NOW,
    );

    expect(fresh).toEqual([]);
    expect(stale).toEqual([
      expect.objectContaining({
        source: 'betterstack_incidents',
        level: 'warning',
        message: expect.stringContaining('3h ago'),
      }),
    ]);
  });

  it('tolerates quiet deploy periods but warns after 5 days without a cd_push heartbeat', () => {
    const incidents = source({
      source: 'betterstack_incidents',
      last_collected_at: hoursBefore(0.5),
    });

    const quietWeekend = assessCollectionHealth(
      [incidents, source({ source: 'cd_push', last_collected_at: hoursBefore(4 * 24) })],
      NOW,
    );
    const dead = assessCollectionHealth(
      [incidents, source({ source: 'cd_push', last_collected_at: hoursBefore(6 * 24) })],
      NOW,
    );

    expect(quietWeekend).toEqual([]);
    expect(dead).toEqual([
      expect.objectContaining({
        source: 'cd_push',
        level: 'warning',
        message: expect.stringContaining('6 days ago'),
      }),
    ]);
  });

  it('ignores backfill errors (surfaced by the backfill UI, not the banner)', () => {
    const issues = assessCollectionHealth(
      [
        source({
          source: 'betterstack_incidents',
          last_collected_at: hoursBefore(0.5),
        }),
        source({
          source: 'backfill',
          last_run_status: 'error',
          last_error: 'token expired',
        }),
      ],
      NOW,
    );

    expect(issues).toEqual([]);
  });
});
