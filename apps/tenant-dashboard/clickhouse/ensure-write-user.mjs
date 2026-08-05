#!/usr/bin/env node
/**
 * Idempotently provision the ClickHouse WRITE user for the analytics_writer
 * role (migration 47 — least-privilege data-plane identity).
 *
 * Why a script and not a migration: migrations are committed SQL and must not
 * carry credentials. The ROLE + GRANTS live in migration 47; the USER that
 * logs in with them is per-environment:
 *
 *   local dev:       yarn clickhouse:write-user:dev  (defaults below)
 *   integration CI:  invoked by apps/integration-tests/clickhouse/setup-clickhouse.ts
 *   staging/prod:    node ensure-write-user.mjs --print
 *                    → paste the emitted SQL into the ClickHouse Cloud console
 *                      with a real password, then set the gateway
 *                      CLICKHOUSE_WRITE_USER / CLICKHOUSE_WRITE_PASSWORD secrets.
 *
 * Env (all optional locally):
 *   CLICKHOUSE_HOST            admin endpoint       (default http://localhost:8123)
 *   CLICKHOUSE_ADMIN_USER      admin user           (default "default")
 *   CLICKHOUSE_ADMIN_PASSWORD  admin password       (default $CLICKHOUSE_PASSWORD, then "dev_password")
 *   CLICKHOUSE_WRITE_USER      user to provision    (default "analytics_writer")
 *   CLICKHOUSE_WRITE_PASSWORD  its password         (default "dev_writer_password" — LOCAL ONLY)
 */

const HOST = process.env.CLICKHOUSE_HOST ?? 'http://localhost:8123';
const ADMIN_USER = process.env.CLICKHOUSE_ADMIN_USER ?? 'default';
const ADMIN_PASSWORD =
  process.env.CLICKHOUSE_ADMIN_PASSWORD ?? process.env.CLICKHOUSE_PASSWORD ?? 'dev_password';
const WRITE_USER = process.env.CLICKHOUSE_WRITE_USER ?? 'analytics_writer';
const WRITE_PASSWORD = process.env.CLICKHOUSE_WRITE_PASSWORD ?? 'dev_writer_password';

/** Single-quote escape for embedding in ClickHouse string literals. */
const q = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** The user name is interpolated as an identifier — restrict it hard. */
if (!/^[A-Za-z0-9_]+$/.test(WRITE_USER)) {
  console.error(`CLICKHOUSE_WRITE_USER must match [A-Za-z0-9_]+ (got "${WRITE_USER}")`);
  process.exit(1);
}

const statements = (password) => [
  // IF NOT EXISTS + explicit ALTER keeps this idempotent AND reconciles a
  // drifted password on re-run (local stacks live long).
  `CREATE USER IF NOT EXISTS ${WRITE_USER} IDENTIFIED WITH sha256_password BY '${q(password)}'`,
  `ALTER USER ${WRITE_USER} IDENTIFIED WITH sha256_password BY '${q(password)}'`,
  `GRANT analytics_writer TO ${WRITE_USER}`,
  `ALTER USER ${WRITE_USER} DEFAULT ROLE analytics_writer`,
];

if (process.argv.includes('--print')) {
  console.log('-- Run in the ClickHouse Cloud SQL console (replace the password):');
  for (const s of statements('<CHOOSE-A-STRONG-PASSWORD>')) console.log(`${s};`);
  process.exit(0);
}

async function exec(sql) {
  const url = new URL(HOST);
  url.searchParams.set('user', ADMIN_USER);
  if (ADMIN_PASSWORD) url.searchParams.set('password', ADMIN_PASSWORD);
  const res = await fetch(url, { method: 'POST', body: sql });
  if (!res.ok) {
    throw new Error(`ClickHouse ${res.status} on: ${sql.slice(0, 60)}…\n${await res.text()}`);
  }
}

try {
  for (const s of statements(WRITE_PASSWORD)) await exec(s);
  // Prove the wiring end-to-end: the write user must be able to log in, insert
  // is checked at grant time (not here — no throwaway rows), and the retention
  // backpressure read must work (its system.mutations grant is easy to omit).
  const probe = new URL(HOST);
  probe.searchParams.set('user', WRITE_USER);
  probe.searchParams.set('password', WRITE_PASSWORD);
  const login = await fetch(probe, {
    method: 'POST',
    body: 'SELECT count() FROM system.mutations WHERE is_done = 0',
  });
  if (!login.ok) throw new Error(`write user cannot run backpressure read: ${await login.text()}`);
  console.log(
    `clickhouse write user ready: ${WRITE_USER} (role analytics_writer) @ ${HOST}`,
  );
} catch (err) {
  console.error(String(err));
  process.exit(1);
}
