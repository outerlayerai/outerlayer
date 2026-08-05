#!/usr/bin/env node
/**
 * Gate: a credential-shaped workflow `env:` key must take its value from an
 * expression, never a literal.
 *
 * WHY THIS EXISTS
 *   A password is the one credential class a secret scanner structurally cannot
 *   catch. Detectors key on entropy or a known prefix (`AKIA`, `ghp_`,
 *   `sk_live_`); a human-chosen password is low-entropy prose with no prefix, so
 *   gitleaks returns clean on it no matter how the config is tuned.
 *
 *   Entropy cannot separate a chosen password from an ordinary English phrase.
 *   Position can: in a workflow `env:` block, a key named `*PASSWORD` whose
 *   value is not a `${{ ... }}` expression is wrong regardless of what the value
 *   looks like. That is what this checks.
 *
 * THE RULE
 *   For every `env:` mapping in `.github/workflows/**` and `.github/actions/**`,
 *   a key matching PASSWORD | SECRET | TOKEN | CREDENTIAL | PRIVATE_KEY, or
 *   ending in _KEY, must have a value that either
 *     - is a `${{ ... }}` expression (secrets.*, vars.*, env.*, steps.*, ...), or
 *     - appears in ALLOWED_LITERALS below.
 *
 *   The allowlist is for values that are provably public: the Supabase CLI's
 *   fixed local demo keys (identical on every install, worthless against a real
 *   project) and obvious `test-`/`ci-` placeholders consumed only by jobs
 *   running against a throwaway local stack. Every entry is an EXACT value, not
 *   a pattern — a real credential can never match by accident.
 *
 * USAGE
 *   node scripts/ci/check-workflow-secret-literals.mjs
 *   WORKFLOW_LITERALS_CWD=<dir> node ... (self-test seam, mirrors the other gates)
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const cwd = process.env.WORKFLOW_LITERALS_CWD ?? process.cwd();

const SCAN_DIRS = [
  path.join(cwd, '.github/workflows'),
  path.join(cwd, '.github/actions'),
];

/**
 * Credential-shaped key names.
 *
 * `KEY` is matched only as a `_KEY` suffix, never as a bare substring, so
 * `SUPABASE_SERVICE_ROLE_KEY` matches while `KEYCLOAK_URL` and `MONKEY_PATCH`
 * do not. `PEPPER` is listed explicitly because `API_KEY_PEPPER` — the HMAC
 * pepper every stored api-key digest depends on — ends in neither `_KEY` nor
 * any of the other words, and leaking it is exactly as damaging as leaking a
 * password.
 */
const CREDENTIAL_KEY =
  /(PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|PRIVATE_KEY|PEPPER)|(^|_)KEY$/;

/**
 * Exact values that are provably public. Keep this list SHORT and exact —
 * never add a pattern, and never add a value that grants anything against a
 * real project.
 */
const ALLOWED_LITERALS = new Set([
  // Supabase CLI local demo keys — byte-identical on every install, scoped to
  // the `supabase-demo` issuer, and useless against a hosted project. Used by
  // jobs that boot a throwaway local Supabase.
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
  'super-secret-jwt-token-with-at-least-32-characters-long',
  // Placeholders consumed only by local-stack CI jobs. Documented as public
  // demo values in CLAUDE.md.
  'am-ci-pepper-not-a-secret',
  'ci-build-graph-placeholder',
  'test-google-client-secret',
  'test-github-client-secret',
  'sk_test_placeholder',
  'dev_password',
]);

/** Recursively collect .yml/.yaml files under `dir`. */
function collectYaml(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectYaml(full, out);
    else if (/\.ya?ml$/.test(entry)) out.push(full);
  }
  return out;
}

/** Leading-space count, treating tabs as one (YAML forbids tab indentation). */
function indentOf(line) {
  return line.length - line.trimStart().length;
}

/**
 * Find credential-shaped literal env values in one workflow file.
 *
 * Deliberately a line scanner, not a YAML parse: this must run with zero
 * dependencies in any CI image, and the shape it looks for (an `env:` block, a
 * `KEY: value` child) is unambiguous at the line level. It tracks the `env:`
 * block by indentation and exits the block on the first line indented at or
 * below the `env:` key itself.
 *
 * @returns {Array<{line: number, key: string, value: string}>}
 */
export function scanWorkflow(source) {
  const lines = source.split('\n');
  const offenders = [];
  let envIndent = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const indent = indentOf(raw);

    // Leaving the env block: a line at or left of the `env:` key's own indent.
    if (envIndent !== null && indent <= envIndent) envIndent = null;

    if (/^env:\s*(#.*)?$/.test(trimmed)) {
      envIndent = indent;
      continue;
    }
    if (envIndent === null) continue;

    // A `KEY: value` child of the env block.
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    // Strip a trailing comment, then surrounding quotes.
    let value = m[2].replace(/\s+#.*$/, '').trim();
    value = value.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');

    if (!CREDENTIAL_KEY.test(key)) continue;

    // Block scalar (`|`, `>`, with any chomp/indent indicator). The value is
    // the indented body that follows, so judge THAT — a multi-line literal
    // under a credential key is the pasted-private-key shape, which is
    // precisely the leak this repo has already had once. Skipping it here
    // would leave a bypass wide enough to drive a PEM through.
    if (/^[|>][+-]?\d*$/.test(value)) {
      const body = [];
      for (let j = i + 1; j < lines.length; j++) {
        const bodyLine = lines[j];
        if (bodyLine.trim() === '') {
          body.push('');
          continue;
        }
        if (indentOf(bodyLine) <= indent) break;
        body.push(bodyLine.trim());
      }
      const joined = body.join('\n').trim();
      if (joined !== '' && !joined.includes('${{')) {
        offenders.push({ line: i + 1, key, value: joined });
      }
      continue;
    }

    if (value === '') continue; // nothing on this line to judge
    if (value.includes('${{')) continue; // expression-sourced: the good case
    if (ALLOWED_LITERALS.has(value)) continue;

    offenders.push({ line: i + 1, key, value });
  }

  return offenders;
}

function main() {
  const files = SCAN_DIRS.flatMap((d) => collectYaml(d));
  const findings = [];

  for (const file of files) {
    const rel = path.relative(cwd, file);
    for (const o of scanWorkflow(readFileSync(file, 'utf8'))) {
      findings.push({ file: rel, ...o });
    }
  }

  if (findings.length === 0) {
    console.log(`✓ workflow secret literals: ${files.length} files clean`);
    return;
  }

  for (const f of findings) {
    // Print the KEY and location but never the full value — CI logs are
    // world-readable on a public repo, and echoing it would publish the very
    // credential we are failing the build over. 4 chars is enough to identify
    // which literal without disclosing it.
    const hint = f.value.slice(0, 4);
    console.error(
      `::error file=${f.file},line=${f.line}::${f.key} is set to a literal ` +
        `value ("${hint}…", ${f.value.length} chars). Move it to a repository ` +
        `secret and reference it as \${{ secrets.<NAME> }}.`,
    );
  }
  console.error('');
  console.error(
    `${findings.length} credential-shaped workflow env value(s) are literals. ` +
      'A password or shared secret committed here is invisible to gitleaks ' +
      '(low entropy, no prefix), which is why this gate exists. If the value ' +
      'is provably public, add the EXACT value to ALLOWED_LITERALS in ' +
      'scripts/ci/check-workflow-secret-literals.mjs with a comment saying why.',
  );
  process.exit(1);
}

// Only run when invoked directly, so the unit test can import `scanWorkflow`.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main();
}
