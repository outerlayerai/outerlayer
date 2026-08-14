/**
 * TenantId Enforcement Guard — services inline SQL (source scan).
 *
 * Reads `services/*.ts` off disk and asserts every backtick template literal
 * that touches a tenant table carries a TenantId predicate. Lives in its own
 * file — separate from the builder-invoking suites in
 * tenant-id-enforcement.test.ts — because Stryker's `inPlace: true` mode
 * rewrites the on-disk files with mutant-switch instrumentation, which
 * mangles the SQL text this scan matches against; vitest.stryker.config.ts
 * excludes exactly this file so the mutation dry run stays clean while the
 * scan runs fully strict under every other runner (ci:unit, nightly, local).
 *
 * If this fails, an inline service query was added or changed without tenant
 * scoping. Fix by adding `AND TenantId = {tenantId:String}` to its WHERE
 * clause.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { TENANT_TABLE_PATTERN, assertTenantId } from './tenant-id-guard';

describe('TenantId enforcement: services inline SQL', () => {
  // Discover every service file by scanning the directory — a new service
  // file cannot silently escape the guard by not being added to a list.
  const SERVICES_DIR = new URL('../services/', import.meta.url);
  const SERVICE_FILES = readdirSync(SERVICES_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'));

  // Backtick-delimited template literals are the odd-indexed segments after a
  // split on the backtick; SQL lives only in these, so comments that mention a
  // table name are not scanned.
  function templateLiterals(source: string): string[] {
    return source.split('`').filter((_, i) => i % 2 === 1);
  }

  const cases = SERVICE_FILES.flatMap((file) => {
    const source = readFileSync(new URL(file, SERVICES_DIR), 'utf8');
    return templateLiterals(source)
      .map((sql, index) => ({ file, index, sql }))
      .filter(({ sql }) => TENANT_TABLE_PATTERN.test(sql));
  });

  it('at least one inline service query is scanned (guard is wired to real SQL)', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)('$file inline query #$index carries a TenantId predicate', ({ file, index, sql }) => {
    assertTenantId(`${file} inline query #${index}`, sql);
  });
});
