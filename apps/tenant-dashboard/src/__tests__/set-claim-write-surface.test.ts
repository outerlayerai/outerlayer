import fs from 'node:fs';
import path from 'node:path';
import { globSync } from 'glob';
import { describe, expect, it } from 'vitest';

/**
 * `set_claim` is a service-role RPC that writes `app_metadata.tenant_id`/
 * `role` directly onto a user's JWT claims. Tenancy resolves per request
 * instead, so every remaining `set_claim` call site is a place that has to be
 * dealt with before the claim path can be dropped. A new caller is easy to add
 * unnoticed inside an unrelated change: it is one RPC name on any service-role
 * client.
 *
 * This pins the KNOWN set as a snapshot, not an allowlist that quietly grows:
 * a new production caller fails this test with a pointer to update it
 * deliberately, rather than the write surface drifting silently.
 *
 * Scope: this scans the dashboard's own TypeScript source tree and its SQL
 * schema files (`supabase/schemas/`, the declarative source of truth —
 * migrations are derived from it and not scanned separately). Callers outside
 * this package (other apps' service-role clients, integration-test helpers)
 * are outside what this test can see.
 */

const SRC = path.resolve(__dirname, '..');
const THIS_FILE = __filename;

// Matches an actual RPC invocation, not a bare mention (a comment, a string
// in an unrelated context) — mirrors the admin-client-call boundary script's
// call-vs-mention distinction.
const SET_CLAIM_CALL = /\.rpc\(\s*["']set_claim["']/;

const files = globSync('**/*.{ts,tsx}', {
  cwd: SRC,
  absolute: true,
  ignore: [
    '**/node_modules/**',
    '**/*.test.{ts,tsx}',
    '**/*.spec.{ts,tsx}',
    '**/__tests__/**',
    '**/__mocks__/**',
  ],
}).filter((file) => file !== THIS_FILE);

// The exact known production call sites, repo-relative. Every entry here is a
// place that calls the `set_claim` RPC against a real service-role client in
// production code paths — update this list deliberately (never by widening
// the regex) when a caller is intentionally added, moved, or removed.
const KNOWN_SET_CLAIM_CALLERS: string[] = [];

describe('set_claim RPC write surface', () => {
  it('scans the real source tree (guard against a vacuous pass)', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('is called from exactly the known production call sites', () => {
    const callers = files
      .filter((file) => SET_CLAIM_CALL.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
      .sort();

    expect(callers).toEqual(KNOWN_SET_CLAIM_CALLERS);
  });
});

/**
 * SQL side of the same write surface. `set_claim` is a Postgres function, so
 * "call" here means a `PERFORM`/`SELECT set_claim(...)` invocation inside
 * another procedure — as opposed to the function's own `CREATE FUNCTION`
 * definition, a `GRANT`/`REVOKE ... ON FUNCTION` execute-privilege statement,
 * or a bare comment mention. Those three are real, expected occurrences of
 * the name that are not write sites and must not be conflated with one.
 *
 * `supabase/schemas/` is the declarative source of truth (per repo
 * convention, migrations are derived from it) — scanning it once covers every
 * historical migration's worth of intent without re-deriving migration
 * history line by line.
 */

const SCHEMAS_DIR = path.resolve(__dirname, '../../supabase/schemas');

// A line-comment prefix is stripped before classification so a hypothetical
// `-- PERFORM set_claim(...)` in prose can never be mistaken for a call.
function stripLineComment(line: string): string {
  const idx = line.indexOf('--');
  return idx === -1 ? line : line.slice(0, idx);
}

// Identifies sites by enclosing function / statement content, never by line
// number: an unrelated edit above a call site shifts every line below it,
// and a line-numbered assertion would fail on that shift with a diff that
// looks like a new claim write but isn't — training reviewers to update the
// list mechanically, which is exactly how a real new call site slips through.
const FUNCTION_HEADER = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\(/i;
const SET_CLAIM_DEFINITION =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.set_claim\s*\(/i;
const SET_CLAIM_GRANT = /^\s*GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.set_claim\s*\([^)]*\)\s+TO\s+([^;]+);/i;
const SET_CLAIM_REVOKE =
  /^\s*REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.set_claim\s*\([^)]*\)\s+FROM\s+([^;]+);/i;
// Captures the claim name literal (e.g. 'tenant_id', 'role') so two
// invocations in the same procedure still get distinct, stable identifiers.
const SET_CLAIM_INVOCATION =
  /\b(?:PERFORM|SELECT)\s+(?:public\.)?set_claim\s*\([^,]*,\s*'([^']+)'/i;

const sqlFiles = globSync('*.sql', { cwd: SCHEMAS_DIR, absolute: true });

// Name of the procedure whose body contains `lineIndex` — the nearest
// `CREATE FUNCTION` header at or above it in the same file.
function enclosingFunctionName(lines: string[], lineIndex: number): string {
  for (let i = lineIndex; i >= 0; i--) {
    const match = FUNCTION_HEADER.exec(stripLineComment(lines[i] ?? ''));
    if (match?.[1]) return match[1];
  }
  return '(module level)';
}

function scanSchemaFiles<T>(collect: (relFile: string, lines: string[]) => T[]): T[] {
  return sqlFiles.flatMap((file) => {
    const relFile = path.relative(SCHEMAS_DIR, file).split(path.sep).join('/');
    return collect(relFile, fs.readFileSync(file, 'utf8').split('\n'));
  });
}

// The function is defined exactly once. A second definition (e.g. a
// duplicate under a different schema file) would be a real anomaly, not a
// silent allowlist addition — it's pinned for the same reason as the calls.
const KNOWN_SET_CLAIM_DEFINITIONS = ['02-functions-core.sql'];

// Execute privilege is revoked from PUBLIC/anon/authenticated and granted to
// service_role in one place. A second grant/revoke site — or a widened
// target — would change who can invoke a function that writes JWT claims
// directly, so both the file and the target list are pinned.
const KNOWN_SET_CLAIM_GRANTS = [
  '96-function-execution-grants.sql:GRANT:service_role',
  '96-function-execution-grants.sql:REVOKE:PUBLIC, anon, authenticated',
].sort();

// The exact known SQL invocation sites, identified by schema file, enclosing
// procedure, and which claim it writes — a new `PERFORM`/`SELECT
// set_claim(...)` anywhere in the schema tree fails this test with the name
// of the new procedure, rather than the write surface drifting silently.
const KNOWN_SET_CLAIM_SQL_INVOCATIONS: string[] = [];

describe('set_claim SQL write surface', () => {
  it('scans the real schema tree (guard against a vacuous pass)', () => {
    expect(sqlFiles.length).toBeGreaterThan(20);
  });

  it('is defined in exactly the known schema file', () => {
    const definitions = scanSchemaFiles((relFile, lines) =>
      lines.some((line) => SET_CLAIM_DEFINITION.test(stripLineComment(line))) ? [relFile] : [],
    ).sort();

    expect(definitions).toEqual(KNOWN_SET_CLAIM_DEFINITIONS);
  });

  it('has execute privilege granted/revoked in exactly the known targets', () => {
    const grants = scanSchemaFiles((relFile, lines) =>
      lines.flatMap((rawLine) => {
        const line = stripLineComment(rawLine);
        const grantMatch = SET_CLAIM_GRANT.exec(line);
        if (grantMatch?.[1]) return [`${relFile}:GRANT:${grantMatch[1].trim()}`];
        const revokeMatch = SET_CLAIM_REVOKE.exec(line);
        if (revokeMatch?.[1]) return [`${relFile}:REVOKE:${revokeMatch[1].trim()}`];
        return [];
      }),
    ).sort();

    expect(grants).toEqual(KNOWN_SET_CLAIM_GRANTS);
  });

  it('is invoked from exactly the known SQL call sites', () => {
    const invocations = scanSchemaFiles((relFile, lines) =>
      lines.flatMap((rawLine, i) => {
        const match = SET_CLAIM_INVOCATION.exec(stripLineComment(rawLine));
        if (!match) return [];
        return [`${relFile}:${enclosingFunctionName(lines, i)}:${match[1]}`];
      }),
    ).sort();

    expect(invocations).toEqual(KNOWN_SET_CLAIM_SQL_INVOCATIONS);
  });
});
