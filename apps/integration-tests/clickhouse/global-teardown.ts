import { teardownClickHouse } from './setup-clickhouse';

export default async function globalTeardown() {
  console.log('\n🧹 Global Teardown: Stopping ClickHouse...');
  await teardownClickHouse();
  console.log('✅ Global Teardown: ClickHouse stopped\n');
}
