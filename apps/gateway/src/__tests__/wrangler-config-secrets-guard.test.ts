import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// Guard: no error-reporting DSN literal (a Sentry-compatible URL embedding a
// write key, e.g. `https://<key>@<host>/<project-id>`) may be committed to
// `apps/gateway/wrangler.toml`. The DSN is supplied at deploy time via
// `wrangler secret put ERROR_REPORTING_DSN --env <env>` (see
// src/services/error-reporting/index.ts, which resolves ERROR_REPORTING_DSN
// and degrades to reporting-disabled when it's unset — never throws). This
// test fails the moment a real DSN literal is reintroduced into the tracked
// wrangler.toml, whether under the legacy `BETTERSTACK_ERRORS_DSN` name or
// any other. The same guard covers the other vars that name deployment
// infrastructure and are therefore supplied as secrets rather than committed.

const wranglerTomlPath = join(__dirname, '..', '..', 'wrangler.toml');

describe('wrangler.toml secrets guard', () => {
  const contents = readFileSync(wranglerTomlPath, 'utf8');

  it('does not declare BETTERSTACK_ERRORS_DSN as a committed var', () => {
    expect(contents).not.toMatch(/BETTERSTACK_ERRORS_DSN\s*=/);
  });

  it('contains no BetterStack DSN literal (host/project-id path form)', () => {
    // A real DSN's path segment is the numeric BetterStack project id, e.g.
    // `s<project-id>.eu-nbg-2.betterstackdata.com/<project-id>`. The
    // ingesting-URL vars we do keep are bare hosts with no trailing
    // `/<digits>`.
    expect(contents).not.toMatch(/betterstackdata\.com\/\d+/);
  });

  it('contains no `user@host` credential-DSN form anywhere in the file', () => {
    expect(contents).not.toMatch(/https:\/\/[^\s"]+@[^\s"]+betterstackdata\.com/);
  });

  it.each([
    'BETTERSTACK_INGESTING_URL',
    'CLICKHOUSE_HOST',
    'CLOUDFLARE_ZONE_ID',
    'STRIPE_STORAGE_METER_ID',
    'TOPICS_TENANT_ALLOWLIST',
    'SUPABASE_API_BASE_URL',
  ])('declares no committed %s var — it is a deploy-time Worker secret', (name) => {
    // These name the deployment's infrastructure (ClickHouse service, zone,
    // Stripe meter, dogfood tenant, Supabase project ref), so they are
    // supplied per environment via `wrangler secret put <NAME> --env <env>`
    // and read from apps/gateway/.dev.vars for local and CI runs. The
    // Supabase URL is reachable from the dashboard's browser bundle, but the
    // repo does not hand the project ref to anyone who greps it.
    expect(contents).not.toMatch(new RegExp(`^\\s*${name}\\s*=`, 'm'));
  });
});
