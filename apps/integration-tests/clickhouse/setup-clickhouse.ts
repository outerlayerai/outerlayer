import { execSync, spawnSync } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// Detect which docker compose command is available
function getDockerComposeCommand(): string {
  try {
    // Try the new 'docker compose' command first (Docker Compose V2)
    execSync('docker compose version', { stdio: 'pipe' });
    return 'docker compose';
  } catch {
    // Fall back to legacy 'docker-compose' command
    return 'docker-compose';
  }
}

// Integration test ClickHouse uses different ports to avoid conflicts
export const CLICKHOUSE_TEST_HOST = 'http://127.0.0.1:18123';
const CLICKHOUSE_TEST_CONTAINER = 'clickhouse-integration-test';

async function checkClickHouseHealth(): Promise<boolean> {
  try {
    // Use curl to check ClickHouse health (more available than wget on macOS)
    const result = spawnSync('curl', ['-sf', `${CLICKHOUSE_TEST_HOST}/ping`], {
      timeout: 5000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

async function waitForClickHouse(maxRetries = 30, interval = 2000): Promise<boolean> {
  console.log('Waiting for ClickHouse to be ready...');

  for (let i = 0; i < maxRetries; i++) {
    const healthy = await checkClickHouseHealth();
    if (healthy) {
      console.log('ClickHouse is ready!');
      return true;
    }
    console.log(`ClickHouse not ready, retrying in ${interval/1000}s... (${i + 1}/${maxRetries})`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  return false;
}

// ============================================================================
// Migration Runner
// ============================================================================

/** Path to ClickHouse migration SQL files (source of truth for schema). */
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'tenant-dashboard', 'clickhouse', 'migrations');

/**
 * Statements to skip during test setup.
 * MATERIALIZE operations are unnecessary because test data is inserted after
 * schema creation, so projections/indexes populate automatically.
 */
const SKIP_PATTERNS = [
  /^ALTER TABLE .+ MATERIALIZE PROJECTION/i,
  /^ALTER TABLE .+ MATERIALIZE INDEX/i,
];

/**
 * Splits a SQL file into individual statements.
 * Handles semicolons inside strings and comments.
 */
function splitSqlStatements(sql: string): string[] {
  // Remove SQL line comments (-- ...) but preserve content inside strings
  const withoutComments = sql.replace(/--.*$/gm, '');

  return withoutComments
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/**
 * Applied-migration ledger for the test harness.
 *
 * The production runner delegates to `clickhouse-migrations`, which keeps its
 * own ledger and so only ever applies what is outstanding. This harness
 * replays the files itself, so without a ledger it re-applies EVERY migration
 * on every run — and migrations are not all idempotent (`ALTER TABLE …
 * REMOVE TTL` errors once the TTL is gone). A container that survives a run —
 * teardown skipped, suite run twice, `setupClickHouse` taking its
 * already-healthy path — then fails setup deterministically until someone
 * wipes it by hand. CI never sees it because its container is always fresh.
 */
const MIGRATION_LEDGER = '_integration_migrations';

async function chExec(statement: string): Promise<string> {
  const response = await fetch(`${CLICKHOUSE_TEST_HOST}/`, { method: 'POST', body: statement });
  const text = await response.text();
  if (!response.ok) throw new Error(`ClickHouse returned ${response.status}: ${text}`);
  return text;
}

/**
 * Versions already applied to this database. Absent ledger means the database
 * predates it: any schema on it was built by a full replay, so it is dropped
 * and rebuilt rather than guessed at — a partially-migrated database that
 * silently adopted the ledger would skip the migrations it is missing and
 * fail later, inside the tests, where the cause is far less obvious.
 */
async function appliedVersions(): Promise<Set<number>> {
  const ledgerExists =
    (
      await chExec(
        `SELECT count() FROM system.tables WHERE database = 'default' AND name = '${MIGRATION_LEDGER}' FORMAT TSV`,
      )
    ).trim() !== '0';

  if (!ledgerExists) {
    const tables = (await chExec(`SHOW TABLES FROM default FORMAT TSV`)).trim();
    if (tables.length > 0) {
      console.log('  No migration ledger on a populated database — rebuilding from scratch.');
      for (const table of tables.split('\n')) {
        await chExec(`DROP TABLE IF EXISTS default.\`${table.trim()}\``);
      }
    }
    await chExec(
      `CREATE TABLE ${MIGRATION_LEDGER} (version UInt32, migration_name String, applied_at DateTime DEFAULT now()) ENGINE = MergeTree ORDER BY version`,
    );
    return new Set();
  }

  const rows = (await chExec(`SELECT DISTINCT version FROM ${MIGRATION_LEDGER} FORMAT TSV`)).trim();
  return new Set(rows.length > 0 ? rows.split('\n').map((v) => Number(v.trim())) : []);
}

/**
 * Runs all ClickHouse migration files from tenant-dashboard/clickhouse/migrations/.
 * This ensures the test schema matches production exactly.
 */
async function runMigrations(): Promise<void> {
  console.log(`Running ClickHouse migrations from ${MIGRATIONS_DIR}...`);
  const applied = await appliedVersions();

  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort((a, b) => {
      // Sort by numeric prefix: "6_recreate_otel_traces.sql" → 6
      const numA = parseInt(a.split('_')[0]!, 10);
      const numB = parseInt(b.split('_')[0]!, 10);
      if (numA !== numB) return numA - numB;
      // Same prefix (e.g., two 9_ files) — sort alphabetically
      return a.localeCompare(b);
    });

  let appliedNow = 0;
  for (const file of files) {
    const version = parseInt(file.split('_')[0]!, 10);
    if (applied.has(version)) continue;

    const filePath = join(MIGRATIONS_DIR, file);
    const sql = readFileSync(filePath, 'utf-8');
    const statements = splitSqlStatements(sql);

    console.log(`  Running ${file} (${statements.length} statements)...`);

    for (const stmt of statements) {
      // Skip MATERIALIZE operations (not needed for fresh test data)
      if (SKIP_PATTERNS.some(pattern => pattern.test(stmt))) {
        continue;
      }

      try {
        await chExec(stmt);
      } catch (error) {
        console.error(`  Failed statement in ${file}: ${stmt.slice(0, 100)}...`);
        throw error;
      }
    }

    // Recorded only after every statement lands, so a file that dies halfway
    // is retried in full on the next run rather than being skipped as done.
    await chExec(
      `INSERT INTO ${MIGRATION_LEDGER} (version, migration_name) VALUES (${version}, '${file.replace(/'/g, "''")}')`,
    );
    appliedNow += 1;
  }

  console.log(
    appliedNow > 0
      ? `All migrations applied successfully (${appliedNow} new, ${applied.size} already applied)`
      : `Schema already current (${applied.size} migrations applied)`,
  );
}

/**
 * Provision the row-policy READ user. Mirrors
 * apps/tenant-dashboard/clickhouse/ensure-read-user.mjs: the ROLE + POLICIES
 * come from migration 29; the USER is per-environment because migrations must
 * not carry credentials. Defaults match apps/gateway/.dev.vars.ci so the
 * gateway HTTP integration lane's reads run under the policies.
 */
export const CLICKHOUSE_TEST_READ_USER = process.env.CLICKHOUSE_READ_USER ?? 'analytics_reader';
export const CLICKHOUSE_TEST_READ_PASSWORD =
  process.env.CLICKHOUSE_READ_PASSWORD ?? 'ci_reader_password';

async function ensureReadUser(): Promise<void> {
  if (!/^[A-Za-z0-9_]+$/.test(CLICKHOUSE_TEST_READ_USER)) {
    throw new Error(`CLICKHOUSE_READ_USER must match [A-Za-z0-9_]+ (got "${CLICKHOUSE_TEST_READ_USER}")`);
  }
  const pw = CLICKHOUSE_TEST_READ_PASSWORD.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const statements = [
    `CREATE USER IF NOT EXISTS ${CLICKHOUSE_TEST_READ_USER} IDENTIFIED WITH sha256_password BY '${pw}'`,
    `ALTER USER ${CLICKHOUSE_TEST_READ_USER} IDENTIFIED WITH sha256_password BY '${pw}'`,
    `GRANT analytics_readonly TO ${CLICKHOUSE_TEST_READ_USER}`,
    `ALTER USER ${CLICKHOUSE_TEST_READ_USER} DEFAULT ROLE analytics_readonly`,
  ];
  for (const stmt of statements) {
    const response = await fetch(`${CLICKHOUSE_TEST_HOST}/`, { method: 'POST', body: stmt });
    if (!response.ok) {
      throw new Error(`read-user provisioning failed (${response.status}): ${await response.text()}`);
    }
  }
  console.log(`Read user ready: ${CLICKHOUSE_TEST_READ_USER} (role analytics_readonly)`);
}

/**
 * Provision the least-privilege WRITE user. Mirrors
 * apps/tenant-dashboard/clickhouse/ensure-write-user.mjs: the ROLE + GRANTS
 * come from migration 47; the USER is per-environment because migrations must
 * not carry credentials. Defaults match apps/gateway/.dev.vars.ci so the
 * gateway HTTP integration lane's ingest / mutation path runs as
 * `analytics_writer` rather than the `default` superuser.
 */
export const CLICKHOUSE_TEST_WRITE_USER = process.env.CLICKHOUSE_WRITE_USER ?? 'analytics_writer';
export const CLICKHOUSE_TEST_WRITE_PASSWORD =
  process.env.CLICKHOUSE_WRITE_PASSWORD ?? 'ci_writer_password';

async function ensureWriteUser(): Promise<void> {
  if (!/^[A-Za-z0-9_]+$/.test(CLICKHOUSE_TEST_WRITE_USER)) {
    throw new Error(`CLICKHOUSE_WRITE_USER must match [A-Za-z0-9_]+ (got "${CLICKHOUSE_TEST_WRITE_USER}")`);
  }
  const pw = CLICKHOUSE_TEST_WRITE_PASSWORD.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const statements = [
    `CREATE USER IF NOT EXISTS ${CLICKHOUSE_TEST_WRITE_USER} IDENTIFIED WITH sha256_password BY '${pw}'`,
    `ALTER USER ${CLICKHOUSE_TEST_WRITE_USER} IDENTIFIED WITH sha256_password BY '${pw}'`,
    `GRANT analytics_writer TO ${CLICKHOUSE_TEST_WRITE_USER}`,
    `ALTER USER ${CLICKHOUSE_TEST_WRITE_USER} DEFAULT ROLE analytics_writer`,
  ];
  for (const stmt of statements) {
    const response = await fetch(`${CLICKHOUSE_TEST_HOST}/`, { method: 'POST', body: stmt });
    if (!response.ok) {
      throw new Error(`write-user provisioning failed (${response.status}): ${await response.text()}`);
    }
  }
  console.log(`Write user ready: ${CLICKHOUSE_TEST_WRITE_USER} (role analytics_writer)`);
}

function stopExistingContainer(): void {
  try {
    console.log('Stopping existing test container if any...');
    execSync(`docker rm -f ${CLICKHOUSE_TEST_CONTAINER} 2>/dev/null || true`, {
      stdio: 'pipe',
    });
  } catch {
    // Container might not exist, that's fine
  }
}
export async function setupClickHouse() {
  // Check if ClickHouse is already running and healthy
  const alreadyHealthy = await checkClickHouseHealth();
  if (alreadyHealthy) {
    console.log('ClickHouse already running and healthy, skipping setup');
    await runMigrations();
    await ensureReadUser();
    await ensureWriteUser();
    return;
  }

  console.log('Setting up ClickHouse for integration tests...');
  console.log(`ClickHouse Test Host: ${CLICKHOUSE_TEST_HOST}`);

  const clickhouseDir = __dirname;

  try {
    stopExistingContainer();

    const dockerCompose = getDockerComposeCommand();
    console.log(`Starting ClickHouse test container using '${dockerCompose}'...`);
    execSync(`${dockerCompose} up -d`, {
      cwd: clickhouseDir,
      stdio: 'inherit',
    });

    const ready = await waitForClickHouse();
    if (!ready) {
      throw new Error('ClickHouse failed to become ready');
    }

    await runMigrations();
    await ensureReadUser();
    await ensureWriteUser();

    console.log('ClickHouse setup complete!');
    console.log(`ClickHouse available at: ${CLICKHOUSE_TEST_HOST}`);

  } catch (error) {
    console.error('Failed to setup ClickHouse:', error);
    throw error;
  }
}

export async function teardownClickHouse() {
  console.log('Tearing down ClickHouse test container...');

  const clickhouseDir = __dirname;
  const dockerCompose = getDockerComposeCommand();

  try {
    execSync(`${dockerCompose} down -v`, {
      cwd: clickhouseDir,
      stdio: 'inherit',
    });
    console.log('ClickHouse teardown complete!');
  } catch (error) {
    console.error('Failed to teardown ClickHouse:', error);
  }
}

export async function cleanClickHouse() {
  console.log('Cleaning ClickHouse test data...');

  const tables = ['otel_traces', 'scores'];
  for (const table of tables) {
    try {
      const response = await fetch(`${CLICKHOUSE_TEST_HOST}/`, {
        method: 'POST',
        body: `TRUNCATE TABLE IF EXISTS ${table}`,
      });
      if (!response.ok) {
        console.warn(`Warning: Failed to truncate ${table}: ${await response.text()}`);
      }
    } catch (error) {
      console.error(`Failed to clean ${table}:`, error);
    }
  }
  console.log('ClickHouse data cleaned!');
}

// Helper to query ClickHouse directly
export async function queryClickHouse(query: string): Promise<any[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let response: Response;
  try {
    response = await fetch(
      `${CLICKHOUSE_TEST_HOST}/?default_format=JSONEachRow`,
      {
        method: "POST",
        body: query,
        signal: controller.signal,
      }
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`ClickHouse query failed: ${await response.text()}`);
  }

  const text = await response.text();
  if (!text.trim()) return [];

  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

// Helper to execute ClickHouse command
// Force synchronous inserts to ensure data is immediately visible after INSERT returns
export async function executeClickHouse(command: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(`${CLICKHOUSE_TEST_HOST}/?async_insert=0&wait_for_async_insert=1`, {
      method: "POST",
      body: command,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`ClickHouse command failed: ${await response.text()}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

// Handle command line arguments only when run directly
const isRunDirectly = process.argv[1]?.includes('setup-clickhouse');
if (isRunDirectly) {
  const command = process.argv[2];

  if (command === 'setup') {
    setupClickHouse();
  } else if (command === 'teardown') {
    teardownClickHouse();
  } else if (command === 'clean') {
    cleanClickHouse();
  } else {
    console.log('Usage: tsx clickhouse/setup-clickhouse.ts [setup|teardown|clean]');
    process.exit(1);
  }
}
