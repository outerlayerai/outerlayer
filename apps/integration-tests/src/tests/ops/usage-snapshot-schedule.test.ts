/**
 * Acceptance: the usage-snapshot capture is actually scheduled, and the delta
 * functions refuse to report a number they cannot back up.
 *
 * `ops.capture_usage_snapshot()` has no caller in application code. A pg_cron
 * job is the only thing that runs it, so a job that silently failed to register
 * would leave the snapshot tables empty forever and the only symptom would be
 * a NOTICE nobody reads.
 *
 * The delta tests cover the readings that would be worse than no reading at
 * all: a zero that looks like "unused" when it really means "we only have one
 * capture", and a subtraction across a stats reset.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Client } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54332/postgres';

const JOB_NAME = 'ops-capture-usage-snapshot';

describe('ops usage-snapshot schedule', () => {
  let db: Client;
  let pgCronInstalled = false;

  beforeAll(async () => {
    db = new Client({ connectionString: DATABASE_URL });
    await db.connect();
    const { rows } = await db.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'");
    pgCronInstalled = rows.length > 0;
  });

  afterAll(async () => {
    await db.end();
  });

  it('registers exactly one active job that calls the capture function', async () => {
    // pg_cron is superuser-installed and absent in some environments; the
    // migration skips scheduling there by design, so asserting would be wrong.
    if (!pgCronInstalled) return;

    const { rows } = await db.query<{
      jobname: string;
      schedule: string;
      command: string;
      active: boolean;
    }>('SELECT jobname, schedule, command, active FROM cron.job WHERE jobname = $1', [JOB_NAME]);

    expect(rows).toEqual([
      {
        jobname: JOB_NAME,
        schedule: '10 4 1 * *',
        command: 'SELECT ops.capture_usage_snapshot()',
        active: true,
      },
    ]);
  });

  it('the scheduled command runs and writes a row per user table', async () => {
    // A job row naming a renamed or dropped function would satisfy the
    // assertion above and still capture nothing.
    const { rows } = await db.query<{ captured_at: Date }>(
      'SELECT ops.capture_usage_snapshot() AS captured_at',
    );
    const capturedAt = rows[0]?.captured_at;
    expect(capturedAt).toEqual(expect.any(Date));

    // Matched in SQL, not by passing `capturedAt` back: the driver truncates
    // timestamptz to milliseconds, so the round-tripped value matches no row.
    const { rows: written } = await db.query<{ tables: string; ops_rows: string }>(
      `SELECT count(*) AS tables,
              count(*) FILTER (WHERE schemaname = 'ops') AS ops_rows
       FROM ops.table_usage_snapshot
       WHERE captured_at = (SELECT MAX(captured_at) FROM ops.table_usage_snapshot)`,
    );
    // Public carries dozens of tables; the exact count drifts with the schema,
    // so pin the two things that must hold: it wrote something, and it did not
    // record its own writes.
    expect(Number(written[0]?.tables)).toBeGreaterThan(0);
    expect(Number(written[0]?.ops_rows)).toBe(0);
  });

  it('reports no rows rather than a false zero when the baseline is the latest capture', async () => {
    // With p_since after every capture, the baseline resolves to the latest one
    // and there is no window. Differencing that against itself would yield
    // zeros for every table — indistinguishable from "nothing was used".
    //
    // p_since is computed in SQL rather than round-tripped through JS: the
    // driver truncates timestamptz to millisecond precision, which would land
    // the boundary just before the newest capture and pick a real baseline.
    const { rows } = await db.query(
      "SELECT * FROM ops.table_usage_delta(NOW() + INTERVAL '1 day')",
    );

    expect(rows).toEqual([]);
  });

  it('returns NULL deltas, never negative ones, across a stats reset', async () => {
    // A reset makes the later counters smaller. Subtracting would report a
    // negative delta, which reads as nonsense; the guard must blank it instead.
    await db.query('BEGIN');
    try {
      const { rows: seeded } = await db.query<{ captured_at: string }>(
        `INSERT INTO ops.table_usage_snapshot
           (captured_at, schemaname, relname, seq_scan, idx_scan,
            n_tup_ins, n_tup_upd, n_tup_del, n_live_tup, stats_reset)
         SELECT NOW() + INTERVAL '1 hour', schemaname, relname,
                0, 0, 0, 0, 0, n_live_tup, NOW()
         FROM ops.table_usage_snapshot
         WHERE captured_at = (SELECT MAX(captured_at) FROM ops.table_usage_snapshot)
         RETURNING captured_at`,
      );
      expect(seeded.length).toBeGreaterThan(0);

      const { rows } = await db.query<{
        seq_scan_delta: number | null;
        idx_scan_delta: number | null;
        writes_delta: number | null;
        stats_reset_between: boolean;
      }>(
        `SELECT seq_scan_delta, idx_scan_delta, writes_delta, stats_reset_between
         FROM ops.table_usage_delta(NOW() - INTERVAL '30 days')`,
      );

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).toEqual({
          seq_scan_delta: null,
          idx_scan_delta: null,
          writes_delta: null,
          stats_reset_between: true,
        });
      }
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
