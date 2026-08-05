/**
 * Acceptance: the expired-temp-access cleanup is actually scheduled.
 *
 * cleanup_expired_temp_access() has no caller in application code — a pg_cron
 * job is the only thing that runs it. The migration that was supposed to
 * register that job called cron.unschedule() before cron.schedule() to be
 * re-runnable, and on any database where the job did not already exist
 * unschedule raises `could not find valid entry for job`. The block's own
 * `WHEN OTHERS` handler swallowed it and skipped the schedule, so the job was
 * never created and expired grants were never revoked. The only symptom was a
 * NOTICE nobody reads.
 *
 * That is the failure this test exists to catch: not "does the function work"
 * (unit-testable, and it did) but "is anything calling it" — which nothing
 * downstream would have noticed for as long as it kept not happening.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Client } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54332/postgres';

const JOB_NAME = 'cleanup-expired-temp-access';

describe('expired temp-access cleanup schedule', () => {
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

  it('registers exactly one active job that calls the cleanup function', async () => {
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
        schedule: '*/30 * * * *',
        command: 'SELECT public.cleanup_expired_temp_access()',
        active: true,
      },
    ]);
  });

  it('the scheduled command actually runs — the function it names exists and returns a result', async () => {
    // A job row pointing at a function that has been renamed or dropped would
    // satisfy the assertion above and still never clean anything up.
    const { rows } = await db.query<{ result: Record<string, unknown> }>(
      'SELECT public.cleanup_expired_temp_access() AS result',
    );

    expect(rows[0]?.result).toEqual({
      expired_grants_processed: expect.any(Number),
      memberships_deleted: expect.any(Number),
      cleanup_timestamp: expect.any(String),
    });
  });
});
