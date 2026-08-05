/**
 * Shared helpers for gateway HTTP integration tests.
 *
 * Responsibilities:
 *   1. Seed a deterministic test tenant + app in local Supabase (via the
 *      gateway's seed script at apps/gateway/scripts/seed-test-tenant.ts).
 *   2. Boot `wrangler dev` against local Supabase + ClickHouse.
 *   3. Poll `/health` until responsive, with a surfaced log tail on timeout.
 *   4. Tear down: SIGTERM wrangler, restore the original `.dev.vars`.
 *
 * Invoked by `global-setup.ts` / `global-teardown.ts` (Vitest). The test
 * files read `GATEWAY_URL` + the app id via the helpers exported here.
 */

import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 9001);
export const GATEWAY_URL = `http://localhost:${GATEWAY_PORT}`;

const REPO_ROOT = join(__dirname, '..', '..', '..');
const GATEWAY_DIR = join(REPO_ROOT, 'apps', 'gateway');
const DEV_VARS = join(GATEWAY_DIR, '.dev.vars');
const DEV_VARS_CI = join(GATEWAY_DIR, '.dev.vars.ci');
// Holds a verbatim copy of the developer's real `.dev.vars` while the CI fixture
// is swapped in, so teardown can put the original back. The name MUST keep a
// `.bak` suffix — that is what the root .gitignore matches, and a run killed
// before teardown leaves this file in the working tree holding live secrets.
const DEV_VARS_BACKUP = join(GATEWAY_DIR, '.dev.vars.gateway-http.bak');
// Marker files: globalSetup writes the seeded appId + tenantId + the minted
// real API key here; test files read them. Using files instead of env vars
// because Vitest workers may fork off the main process, and process.env
// mutations from globalSetup don't always propagate to forked workers.
const APP_ID_MARKER = join(__dirname, '.app-id');
const TENANT_ID_MARKER = join(__dirname, '.tenant-id');
const API_KEY_MARKER = join(__dirname, '.api-key');

let wranglerProcess: ChildProcess | undefined;

export function getTestAppId(): string {
  if (!existsSync(APP_ID_MARKER)) {
    throw new Error(
      `Test app id marker not found at ${APP_ID_MARKER}. Did globalSetup run?`,
    );
  }
  return readFileSync(APP_ID_MARKER, 'utf8').trim();
}

export function getTestTenantId(): string {
  if (!existsSync(TENANT_ID_MARKER)) {
    throw new Error(
      `Test tenant id marker not found at ${TENANT_ID_MARKER}. Did globalSetup run?`,
    );
  }
  return readFileSync(TENANT_ID_MARKER, 'utf8').trim();
}

/**
 * The real peppered API key minted for the seeded app by the seed script.
 * Sent as `Authorization: Bearer <key>` by the gateway-http client so tests
 * exercise the real `verify_api_key` path.
 */
export function getTestApiKey(): string {
  if (!existsSync(API_KEY_MARKER)) {
    throw new Error(
      `Test api key marker not found at ${API_KEY_MARKER}. Did globalSetup run?`,
    );
  }
  return readFileSync(API_KEY_MARKER, 'utf8').trim();
}

async function waitForHealth(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${GATEWAY_URL}/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `Gateway at ${GATEWAY_URL} did not become healthy within ${timeoutMs}ms`,
  );
}

export async function startGateway(): Promise<void> {
  // Swap in CI dev vars BEFORE seeding (preserve original so local dev isn't
  // disturbed). The seed key's digest is derived from API_KEY_PEPPER, and
  // wrangler boots with the pepper in this same `.dev.vars` — seeding after the
  // swap guarantees the seeder and the gateway share one pepper, so the minted
  // key verifies.
  // Only take a backup when there isn't one already. A previous run that was
  // killed before teardown leaves `.dev.vars` holding the CI fixture and the
  // backup still on disk; copying again would overwrite the real values with
  // the fixture and lose them for good. Keeping the existing backup means the
  // next clean teardown still restores the developer's original file.
  if (existsSync(DEV_VARS) && !existsSync(DEV_VARS_BACKUP)) {
    copyFileSync(DEV_VARS, DEV_VARS_BACKUP);
  }
  copyFileSync(DEV_VARS_CI, DEV_VARS);

  // Parse the pepper wrangler will boot with out of the (just-copied) dev vars.
  const devVarsContent = readFileSync(DEV_VARS, 'utf8');
  const pepperMatch = devVarsContent.match(/^API_KEY_PEPPER=(.*)$/m);
  const apiKeyPepper = pepperMatch?.[1]?.trim();
  if (!apiKeyPepper) {
    throw new Error(`API_KEY_PEPPER not found in ${DEV_VARS}`);
  }

  // Seed a test tenant + app + real peppered key. Args are static (no user
  // input), passed as array to spawnSync so no shell involvement. The seeder
  // must use the exact pepper wrangler boots with (above) or the minted digest
  // won't verify.
  const seed = spawnSync(
    'yarn',
    ['workspace', 'gateway', 'exec', 'tsx', 'scripts/seed-test-tenant.ts'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        API_KEY_PEPPER: apiKeyPepper,
        SUPABASE_URL: process.env.SUPABASE_URL ?? 'http://127.0.0.1:54331',
        // Local demo service-role key (see supabase-admin.ts) unless overridden.
        SUPABASE_SERVICE_ROLE_KEY:
          process.env.SUPABASE_SERVICE_ROLE_KEY ??
          'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
      },
    },
  );
  if (seed.status !== 0) {
    process.stderr.write(seed.stderr || '');
    throw new Error(`seed-test-tenant.ts exited with ${seed.status}`);
  }

  // The seed emits parseable key=value lines (see the seed script header).
  // Don't rely on a single-line stdout anymore.
  const parseLine = (key: string): string => {
    const m = seed.stdout.match(new RegExp(`^${key}=(.*)$`, 'm'));
    if (!m?.[1]) {
      throw new Error(
        `Seed output missing "${key}=" line. stdout:\n${seed.stdout}`,
      );
    }
    return m[1].trim();
  };

  const appId = parseLine('app_id');
  if (!appId.match(/^[0-9a-f-]{36}$/i)) {
    throw new Error(`Seed app_id is not a UUID: ${JSON.stringify(appId)}`);
  }
  const tenantId = parseLine('tenant_id');
  const apiKey = parseLine('api_key');

  writeFileSync(APP_ID_MARKER, appId);
  // tenant_id comes straight from the seed. Integration tests that write
  // ClickHouse rows as the seeded tenant (e.g. trace filter HTTP tests) need
  // TenantId to match what the gateway resolves via auth — otherwise
  // WHERE TenantId = {...} excludes their rows.
  writeFileSync(TENANT_ID_MARKER, tenantId);
  writeFileSync(API_KEY_MARKER, apiKey);
  console.log(`[gateway-http] seeded app_id=${appId} tenant_id=${tenantId} (minted real key)`);

  // Spawn wrangler dev. Kept in foreground stdio so log output is attributed
  // to the test suite.
  wranglerProcess = spawn('yarn', ['dev'], {
    cwd: GATEWAY_DIR,
    env: { ...process.env, GATEWAY_PORT: String(GATEWAY_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logChunks: string[] = [];
  const capture = (chunk: Buffer) => {
    const s = chunk.toString();
    logChunks.push(s);
    // Echo first 200 chars of each chunk so CI logs show wrangler progress
    // without being swamped by per-request logs.
    process.stdout.write(s.slice(0, 200));
  };
  wranglerProcess.stdout?.on('data', capture);
  wranglerProcess.stderr?.on('data', capture);

  try {
    await waitForHealth();
    console.log(`[gateway-http] wrangler dev ready at ${GATEWAY_URL}`);
  } catch (err) {
    console.error('--- wrangler output ---');
    console.error(logChunks.join(''));
    console.error('--- end wrangler output ---');
    throw err;
  }
}

export async function stopGateway(): Promise<void> {
  if (wranglerProcess && !wranglerProcess.killed) {
    wranglerProcess.kill('SIGTERM');
    // Give wrangler 5s to exit gracefully before SIGKILL.
    await new Promise((r) => setTimeout(r, 5000));
    if (!wranglerProcess.killed) {
      wranglerProcess.kill('SIGKILL');
    }
  }

  // Restore original .dev.vars if we swapped it.
  if (existsSync(DEV_VARS_BACKUP)) {
    copyFileSync(DEV_VARS_BACKUP, DEV_VARS);
    unlinkSync(DEV_VARS_BACKUP);
  }

  if (existsSync(APP_ID_MARKER)) {
    unlinkSync(APP_ID_MARKER);
  }
  if (existsSync(TENANT_ID_MARKER)) {
    unlinkSync(TENANT_ID_MARKER);
  }
  if (existsSync(API_KEY_MARKER)) {
    unlinkSync(API_KEY_MARKER);
  }
}
