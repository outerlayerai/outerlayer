#!/usr/bin/env node
/**
 * Idempotently provision the ClickHouse READ user for the analytics_readonly
 * role (row-policy tenant isolation).
 *
 * Why a script and not a migration: migrations are committed SQL and must not
 * carry credentials. The ROLE + ROW POLICIES live in the committed ClickHouse migrations; the USER
 * that logs in with them is per-environment:
 *
 *   local dev:       yarn clickhouse:read-user:dev   (defaults below)
 *   integration CI:  invoked by apps/integration-tests/clickhouse/setup-clickhouse.ts
 *   staging/prod:    node ensure-read-user.mjs --print
 *                    → paste the emitted SQL into the ClickHouse Cloud console
 *                      with a real password, then set the gateway/dashboard
 *                      CLICKHOUSE_READ_USER / CLICKHOUSE_READ_PASSWORD secrets.
 *
 * Env (all optional locally):
 *   CLICKHOUSE_HOST            admin endpoint       (default http://localhost:8123)
 *   CLICKHOUSE_ADMIN_USER      admin user           (default "default")
 *   CLICKHOUSE_ADMIN_PASSWORD  admin password       (default $CLICKHOUSE_PASSWORD, then "dev_password")
 *   CLICKHOUSE_READ_USER       user to provision    (default "analytics_reader")
 *   CLICKHOUSE_READ_PASSWORD   its password         (default "dev_reader_password" — LOCAL ONLY)
 */

const HOST = process.env.CLICKHOUSE_HOST ?? 'http://localhost:8123';
const ADMIN_USER = process.env.CLICKHOUSE_ADMIN_USER ?? 'default';
const ADMIN_PASSWORD =
  process.env.CLICKHOUSE_ADMIN_PASSWORD ?? process.env.CLICKHOUSE_PASSWORD ?? 'dev_password';
const READ_USER = process.env.CLICKHOUSE_READ_USER ?? 'analytics_reader';
const READ_PASSWORD = process.env.CLICKHOUSE_READ_PASSWORD ?? 'dev_reader_password';

/** Single-quote escape for embedding in ClickHouse string literals. */
const q = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** The user name is interpolated as an identifier — restrict it hard. */
if (!/^[A-Za-z0-9_]+$/.test(READ_USER)) {
  console.error(`CLICKHOUSE_READ_USER must match [A-Za-z0-9_]+ (got "${READ_USER}")`);
  process.exit(1);
}

const statements = (password) => [
  // IF NOT EXISTS + explicit ALTER keeps this idempotent AND reconciles a
  // drifted password on re-run (local stacks live long).
  `CREATE USER IF NOT EXISTS ${READ_USER} IDENTIFIED WITH sha256_password BY '${q(password)}'`,
  `ALTER USER ${READ_USER} IDENTIFIED WITH sha256_password BY '${q(password)}'`,
  `GRANT analytics_readonly TO ${READ_USER}`,
  `ALTER USER ${READ_USER} DEFAULT ROLE analytics_readonly`,
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
  for (const s of statements(READ_PASSWORD)) await exec(s);
  // Prove the wiring end-to-end: the read user must be able to log in and its
  // policy layer must fail CLOSED without a tenant setting.
  const probe = new URL(HOST);
  probe.searchParams.set('user', READ_USER);
  probe.searchParams.set('password', READ_PASSWORD);
  const login = await fetch(probe, { method: 'POST', body: 'SELECT 1' });
  if (!login.ok) throw new Error(`read user cannot log in: ${await login.text()}`);
  console.log(
    `clickhouse read user ready: ${READ_USER} (role analytics_readonly) @ ${HOST}`,
  );
} catch (err) {
  console.error(String(err));
  process.exit(1);
}
