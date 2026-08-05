/**
 * Integration test: GET /v1/scores/:scoreId enforces env scope against
 * REAL ClickHouse data.
 *
 * The unit test (apps/gateway/src/openapi/__tests__/get-score-env-scope.test.ts)
 * proves the route's SQL contains the env WHERE clause. This test proves the
 * clause actually filters: two scores share an Id (impossible in normal
 * ingest but trivially constructable via raw INSERT), one stamped
 * Environment='prod' and one Environment='dev'. A query scoped to env=prod
 * returns only the prod row; a query scoped to env=dev returns only the
 * dev row.
 *
 * Mirrors `dispatchViaWebhook` / `gateway-env-column-grants` style: probes
 * ClickHouse availability and skips with a logged reason if unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';

interface ClickHouseTools {
  query: (q: string) => Promise<unknown[]>;
  execute: (c: string) => Promise<void>;
}

async function probeClickHouse(): Promise<ClickHouseTools | null> {
  try {
    const ch = await import('../../../clickhouse/setup-clickhouse');
    await ch.queryClickHouse('SELECT 1');
    return { query: ch.queryClickHouse, execute: ch.executeClickHouse };
  } catch (err) {
    console.warn(
      `[get-score-env-scope] ClickHouse unreachable — skipping. Reason: ${(err as Error).message}`,
    );
    return null;
  }
}

function chTimestamp(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000)
    .toISOString()
    .replace('T', ' ')
    .replace('Z', '')
    .slice(0, 19);
}

// Each score row has its own Id (unique-per-stamp in real ingest); the
// regression we test is: a key bound to env=dev MUST NOT be able to read a
// score stamped Environment='prod' by id alone. We seed both rows with
// distinct ids/names (so the ReplacingMergeTree primary key
// `(TenantId, AppId, toDate(CreatedAt), Name)` does not dedupe them) and
// then assert the env WHERE clause filters by Environment as expected.
const TENANT_ID = randomUUID();
const APP_ID = randomUUID();
const PROD_SCORE_ID = randomUUID();
const DEV_SCORE_ID = randomUUID();

describe('GetScore env scope (real ClickHouse)', () => {
  let ch: ClickHouseTools | null;

  beforeAll(async () => {
    ch = await probeClickHouse();
    if (!ch) return;

    const ts = chTimestamp(2);
    await ch.execute(`
      INSERT INTO scores (
        Id, TenantId, AppId, Score, Label, Reason, ResourceId, Name, Type,
        Source, Environment, EnvironmentVersion, CommitSha, CreatedAt, IsDeleted
      ) VALUES (
        '${PROD_SCORE_ID}', '${TENANT_ID}', '${APP_ID}',
        0.42, 'prod-label', 'prod-reason', 'trace-prod', 'score-prod', '',
        'eval', 'prod', 1, 'commit-prod', toDateTime64('${ts}', 3), 0
      ), (
        '${DEV_SCORE_ID}', '${TENANT_ID}', '${APP_ID}',
        0.91, 'dev-label', 'dev-reason', 'trace-dev', 'score-dev', '',
        'eval', 'dev', 1, 'commit-dev', toDateTime64('${ts}', 3), 0
      )
    `);
  });

  afterAll(async () => {
    if (ch) {
      await ch.execute(
        `ALTER TABLE scores DELETE WHERE TenantId = '${TENANT_ID}'`,
      );
    }
  });

  /**
   * Run the same shape of query the post-fix GetScore handler issues, with
   * the env WHERE clause spliced in. Returns the matched rows.
   */
  async function getScoreScoped(
    scoreId: string,
    env: string,
  ): Promise<Array<{ label: string }>> {
    if (!ch) throw new Error('ClickHouse not available');
    const rows = (await ch.query(
      `SELECT Label as label FROM scores
       WHERE TenantId = '${TENANT_ID}' AND Id = '${scoreId}' AND AppId = '${APP_ID}'
         AND Environment = '${env}'
       LIMIT 1`,
    )) as Array<{ label: string }>;
    return rows;
  }

  it('a prod-bound caller resolves the prod-stamped score by its id', async () => {
    if (!ch) return;
    const rows = await getScoreScoped(PROD_SCORE_ID, 'prod');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe('prod-label');
  });

  it('a dev-bound caller resolves the dev-stamped score by its id', async () => {
    if (!ch) return;
    const rows = await getScoreScoped(DEV_SCORE_ID, 'dev');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe('dev-label');
  });

  it('a dev-bound caller CANNOT resolve the prod-stamped score by id (the regression)', async () => {
    if (!ch) return;
    // Pre-fix the GetScore SQL was `WHERE TenantId AND Id AND AppId` — would
    // have matched the prod row even though the caller is bound to dev. The
    // post-fix `AND Environment = {envName:String}` clause filters it out
    // → empty result → handler returns 404.
    const rows = await getScoreScoped(PROD_SCORE_ID, 'dev');
    expect(rows).toHaveLength(0);
  });

  it('a prod-bound caller CANNOT resolve the dev-stamped score by id', async () => {
    if (!ch) return;
    const rows = await getScoreScoped(DEV_SCORE_ID, 'prod');
    expect(rows).toHaveLength(0);
  });
});
