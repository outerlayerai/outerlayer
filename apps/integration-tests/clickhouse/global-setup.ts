import { setupClickHouse, cleanClickHouse, executeClickHouse, queryClickHouse } from './setup-clickhouse';

export default async function globalSetup() {
  console.log('\n🔧 Global Setup: Starting ClickHouse...');
  await setupClickHouse();
  // Truncate stale data from previous test runs.
  // Individual test suites use unique TEST_RUN_ID for isolation and skip
  // afterAll cleanup (to avoid ALTER TABLE DELETE mutations), so we clean here.
  await cleanClickHouse();

  // Warmup: insert and query a dummy row to prime ClickHouse's insert/query pipeline.
  // After a fresh start or TRUNCATE, the first INSERT can be slow while ClickHouse
  // initializes MergeTree parts. This ensures the engine is ready before tests begin.
  await executeClickHouse(`
    INSERT INTO otel_traces (Timestamp, TraceId, SpanId, TenantId, AppId, UpdatedAt, IsDeleted)
    VALUES (now(), '__warmup__', '__warmup__', '__warmup__', '__warmup__', now64(3), 0)
  `);
  await queryClickHouse(`SELECT count() FROM otel_traces WHERE TraceId = '__warmup__' FORMAT JSONEachRow`);
  await cleanClickHouse();

  console.log('✅ Global Setup: ClickHouse ready\n');
}
