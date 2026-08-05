/**
 * Tests for database-error-handler.ts — the user-facing error message
 * translator every server action funnels Supabase errors through. Targets
 * the 94 NoCoverage mutants the 2026-05-29 nightly flagged.
 *
 * The bug classes mutation testing surfaces here:
 *
 *   - ConditionalExpression on every `if (errorMessage.includes(...))` —
 *     a dropped check would silently fall through to a less-specific
 *     branch, returning the wrong copy to the user
 *   - String content of the returned messages — a refactor that changes
 *     "Please choose a different name." would otherwise be invisible
 *   - LogicalOperator on `constraintName === 'uc_api_key' ||
 *     constraintName.includes('api_key')` — flipping `||` to `&&` would
 *     stop most constraints from matching
 *   - StringLiteral on the constraint name comparisons — a typo
 *     ("api_keys" vs "api_key") would silently miss
 *
 * Pure functions, no MSW or Supabase needed — literal error inputs
 * exercise every branch.
 */

import { describe, it, expect } from 'vitest';
import {
  transformDatabaseError,
  handleDatabaseError,
  databaseErrorHandlers,
} from '../database-error-handler';

// PostgreSQL error code reference (https://www.postgresql.org/docs/current/errcodes-appendix.html):
//   23505 = unique_violation
//   23503 = foreign_key_violation
//   23502 = not_null_violation
// Tests use both the literal error CODE strings and the canonical
// English error TEXT to cover both branches of every `||` in the
// implementation.

describe('transformDatabaseError', () => {
  // -------------------------------------------------------------------------
  // unique constraint — named, with resourceName
  // -------------------------------------------------------------------------
  describe('unique constraint violations (23505) with specific constraint name', () => {
    it('returns the API-key copy when constraint name is the exact "uc_api_key"', () => {
      const error = 'duplicate key value violates unique constraint "uc_api_key"';
      const result = transformDatabaseError(error, { resourceName: 'Prod Key' });
      expect(result).toBe(
        'An API key with the name "Prod Key" already exists. Please choose a different name.',
      );
    });

    it('returns the API-key copy when constraint name contains "api_key" (fallback substring match)', () => {
      const error = 'duplicate key value violates unique constraint "tenant_api_key_idx"';
      const result = transformDatabaseError(error, { resourceName: 'My Key' });
      expect(result).toBe(
        'An API key with the name "My Key" already exists. Please choose a different name.',
      );
    });

    it('falls back to "API key" when resourceName is omitted for an api_key constraint', () => {
      const error = 'duplicate key value violates unique constraint "uc_api_key"';
      const result = transformDatabaseError(error);
      expect(result).toBe(
        'An API key with the name "API key" already exists. Please choose a different name.',
      );
    });

    it('returns the app copy for "unique_name_per_tenant"', () => {
      const error = 'duplicate key value violates unique constraint "unique_name_per_tenant"';
      const result = transformDatabaseError(error, { resourceName: 'My App' });
      expect(result).toBe(
        'An app with the name "My App" already exists. Please choose a different name.',
      );
    });

    it('returns the app copy when constraint name contains "app"', () => {
      const error = 'duplicate key value violates unique constraint "my_app_pkey"';
      const result = transformDatabaseError(error, { resourceName: 'Other' });
      expect(result).toBe(
        'An app with the name "Other" already exists. Please choose a different name.',
      );
    });

    it('returns the template copy when constraint name contains "template"', () => {
      const error = 'duplicate key value violates unique constraint "template_uniq"';
      const result = transformDatabaseError(error, { resourceName: 'Welcome Email' });
      expect(result).toBe(
        'A template with the name "Welcome Email" already exists. Please choose a different name.',
      );
    });

    it('returns the dataset copy when constraint name contains "dataset"', () => {
      const error = 'duplicate key value violates unique constraint "dataset_pkey"';
      const result = transformDatabaseError(error, { resourceName: 'eval-set-1' });
      expect(result).toBe(
        'A dataset with the name "eval-set-1" already exists. Please choose a different name.',
      );
    });

    it('returns the repository copy when constraint name contains "repository"', () => {
      const error = 'duplicate key value violates unique constraint "git_repository_uniq"';
      const result = transformDatabaseError(error, { resourceName: 'acme/api' });
      expect(result).toBe(
        'The repository "acme/api" is already connected to another app. Please choose a different repository.',
      );
    });

    it('returns the GitHub username copy when constraint name contains "github_username"', () => {
      const error = 'duplicate key value violates unique constraint "github_username_uniq"';
      const result = transformDatabaseError(error, { resourceName: 'octocat' });
      expect(result).toBe(
        'The GitHub username "octocat" is already associated with another account.',
      );
    });

    it('returns the organization name copy when constraint name contains "organization_name"', () => {
      const error = 'duplicate key value violates unique constraint "organization_name_uniq"';
      const result = transformDatabaseError(error, { resourceName: 'Acme Robotics' });
      expect(result).toBe(
        'The organization name "Acme Robotics" is already taken. Please choose a different name.',
      );
    });
  });

  // -------------------------------------------------------------------------
  // REGRESSION: routing precedence for "*_per_app" constraint names
  //
  // A per-app uniqueness constraint is conventionally named
  // `unique_<resource>_name_per_app`. The generic `'app'` substring matches
  // every such name, so the routing order has to put specific resources
  // BEFORE the app branch — otherwise a duplicate-name violation on any of
  // them surfaces as "An app with the name X already exists", which has
  // shipped as a real UX bug. These tests pin that contract so a future
  // re-sort of the if-chain can't silently regress it.
  // -------------------------------------------------------------------------
  describe('routing precedence: "*_per_app" constraint names route to the SPECIFIC resource, not "app"', () => {
    it('routes a hypothetical "unique_template_name_per_app" → template', () => {
      // Forward-looking: if anyone adds a per-app template constraint, the
      // routing precedence keeps it on the template branch.
      const result = transformDatabaseError(
        'duplicate key value violates unique constraint "unique_template_name_per_app"',
        { resourceName: 'Welcome' },
      );
      expect(result).toContain('A template with the name');
      expect(result).not.toContain('An app with the name');
    });

    it('routes a hypothetical "unique_dataset_name_per_app" → dataset', () => {
      const result = transformDatabaseError(
        'duplicate key value violates unique constraint "unique_dataset_name_per_app"',
        { resourceName: 'eval-set' },
      );
      expect(result).toContain('A dataset with the name');
      expect(result).not.toContain('An app with the name');
    });

    it('routes "uc_api_key_per_app" → API key (api_key check runs first regardless)', () => {
      const result = transformDatabaseError(
        'duplicate key value violates unique constraint "uc_api_key_per_app"',
        { resourceName: 'Prod' },
      );
      expect(result).toContain('An API key with the name');
      expect(result).not.toContain('An app with the name');
    });

    it('a constraint whose name is JUST "*_app_*" with no other resource match still routes to app', () => {
      // Negative half of the precedence: when no specific-resource
      // substring matches, the app branch is correct.
      const result = transformDatabaseError(
        'duplicate key value violates unique constraint "unique_app_slug"',
        { resourceName: 'my-app' },
      );
      expect(result).toBe(
        'An app with the name "my-app" already exists. Please choose a different name.',
      );
    });
  });

  // -------------------------------------------------------------------------
  // unique constraint — generic fallback
  // -------------------------------------------------------------------------
  describe('unique constraint violations without a recognised constraint name', () => {
    it('uses the generic copy with resourceName when present', () => {
      const error = 'duplicate key value violates unique constraint "something_random"';
      const result = transformDatabaseError(error, {
        resourceName: 'foo',
        fieldName: 'slug',
      });
      expect(result).toBe('"foo" already exists. Please choose a different slug.');
    });

    it('uses the generic copy with "this value" + default field when nothing is provided', () => {
      const error = 'duplicate key value violates unique constraint "x"';
      const result = transformDatabaseError(error);
      expect(result).toBe('this value already exists. Please choose a different name.');
    });

    it('matches by the bare error code "23505" when the constraint phrase is absent', () => {
      // PostgreSQL error code surfaced without the canonical English text —
      // the `errorMessage.includes('23505')` branch must still trigger.
      const error = 'pg error 23505 occurred during INSERT';
      const result = transformDatabaseError(error);
      expect(result).toBe('this value already exists. Please choose a different name.');
    });
  });

  // -------------------------------------------------------------------------
  // foreign key constraint
  // -------------------------------------------------------------------------
  describe('foreign key constraint violations (23503)', () => {
    it('returns the dependency copy keyed on the resource label', () => {
      const error = 'update or delete on table violates foreign key constraint';
      const result = transformDatabaseError(error, { resource: 'app' });
      expect(result).toBe(
        "This app cannot be deleted because it's being used by other items. Please remove its dependencies first.",
      );
    });

    it('falls back to "item" when resource is omitted', () => {
      const error = 'violates foreign key constraint';
      const result = transformDatabaseError(error);
      expect(result).toBe(
        "This item cannot be deleted because it's being used by other items. Please remove its dependencies first.",
      );
    });

    it('matches the bare error code "23503"', () => {
      const error = 'caught 23503 from constraint';
      const result = transformDatabaseError(error, { resource: 'dataset' });
      expect(result).toBe(
        "This dataset cannot be deleted because it's being used by other items. Please remove its dependencies first.",
      );
    });
  });

  // -------------------------------------------------------------------------
  // not null constraint
  // -------------------------------------------------------------------------
  describe('not null constraint violations (23502)', () => {
    it('uses the provided fieldName in the copy', () => {
      const error = 'null value in column "tenant_id" violates not null constraint';
      const result = transformDatabaseError(error, { fieldName: 'tenant id' });
      expect(result).toBe('The tenant id is required and cannot be empty.');
    });

    it('falls back to "field" when fieldName is omitted', () => {
      const error = 'violates not null constraint';
      const result = transformDatabaseError(error);
      expect(result).toBe('The field is required and cannot be empty.');
    });

    it('matches the bare error code "23502"', () => {
      const error = 'pg threw 23502';
      const result = transformDatabaseError(error, { fieldName: 'name' });
      expect(result).toBe('The name is required and cannot be empty.');
    });
  });

  // -------------------------------------------------------------------------
  // custom trigger errors
  // -------------------------------------------------------------------------
  describe('"Max limit reached" custom trigger', () => {
    it('uses the resource label in both halves of the copy', () => {
      const error = 'Max limit reached for table api_key';
      const result = transformDatabaseError(error, { resource: 'API key' });
      expect(result).toBe(
        'You have reached the maximum limit for API keys. Please upgrade your plan or remove existing API keys.',
      );
    });

    it('falls back to "item" pluralised when resource is omitted', () => {
      const error = 'Max limit reached';
      const result = transformDatabaseError(error);
      expect(result).toBe(
        'You have reached the maximum limit for items. Please upgrade your plan or remove existing items.',
      );
    });
  });

  // -------------------------------------------------------------------------
  // invalid input / length / range
  // -------------------------------------------------------------------------
  describe('invalid input / overflow errors', () => {
    it('returns the invalid-input copy with field name', () => {
      const error = 'invalid input syntax for type integer';
      const result = transformDatabaseError(error, { fieldName: 'age' });
      expect(result).toBe(
        'The age contains invalid characters or format. Please check your input.',
      );
    });

    it('returns the value-too-long copy with field name', () => {
      const error = 'value too long for type character varying(50)';
      const result = transformDatabaseError(error, { fieldName: 'description' });
      expect(result).toBe('The description is too long. Please shorten your input.');
    });

    it('returns the out-of-range copy when error includes "numeric field overflow"', () => {
      const error = 'numeric field overflow on column "amount"';
      const result = transformDatabaseError(error, { fieldName: 'amount' });
      expect(result).toBe(
        'The amount is outside the allowed range. Please enter a valid number.',
      );
    });

    it('returns the out-of-range copy when error includes "out of range"', () => {
      const error = 'integer out of range';
      const result = transformDatabaseError(error);
      expect(result).toBe(
        'The value is outside the allowed range. Please enter a valid number.',
      );
    });
  });

  // -------------------------------------------------------------------------
  // unknown / passthrough
  // -------------------------------------------------------------------------
  describe('passthrough for unknown errors', () => {
    it('returns the original message verbatim when no branch matches', () => {
      const error = 'something completely unexpected happened';
      const result = transformDatabaseError(error);
      expect(result).toBe('something completely unexpected happened');
    });
  });

  // -------------------------------------------------------------------------
  // input shape: string vs Error vs PostgrestError
  // -------------------------------------------------------------------------
  describe('input shape handling', () => {
    it('accepts a string error directly', () => {
      const result = transformDatabaseError('duplicate key value violates unique constraint "uc_api_key"');
      expect(result).toContain('An API key with the name');
    });

    it('extracts .message from a native Error', () => {
      const err = new Error('violates foreign key constraint');
      const result = transformDatabaseError(err, { resource: 'app' });
      expect(result).toBe(
        "This app cannot be deleted because it's being used by other items. Please remove its dependencies first.",
      );
    });

    it('extracts .message from a PostgrestError-shaped object', () => {
      // PostgrestError has additional fields; only .message is read.
      const err = {
        message: 'value too long for type character varying(255)',
        code: '22001',
        details: null,
        hint: null,
        name: 'PostgrestError',
      } as unknown as Error;
      const result = transformDatabaseError(err, { fieldName: 'title' });
      expect(result).toBe('The title is too long. Please shorten your input.');
    });
  });
});

// ===========================================================================
// handleDatabaseError — wraps transformDatabaseError into an { error } envelope
// ===========================================================================

describe('handleDatabaseError', () => {
  it('wraps the transformed message in { error: ... }', () => {
    const result = handleDatabaseError('violates not null constraint', { fieldName: 'name' });
    expect(result).toEqual({ error: 'The name is required and cannot be empty.' });
  });

  it('forwards all options to the underlying transform', () => {
    const result = handleDatabaseError(
      'duplicate key value violates unique constraint "uc_api_key"',
      { resourceName: 'X' },
    );
    expect(result).toEqual({
      error: 'An API key with the name "X" already exists. Please choose a different name.',
    });
  });
});

// ===========================================================================
// databaseErrorHandlers — pre-configured wrappers
// ===========================================================================

describe('databaseErrorHandlers', () => {
  const dupeErr = (constraint: string) =>
    `duplicate key value violates unique constraint "${constraint}"`;

  it('apiKey: applies API-key resource + name field, uses provided keyName', () => {
    const r = databaseErrorHandlers.apiKey(dupeErr('uc_api_key'), 'Prod');
    expect(r).toEqual({
      error: 'An API key with the name "Prod" already exists. Please choose a different name.',
    });
  });

  it('apiKey: still works without keyName (falls back to "API key")', () => {
    const r = databaseErrorHandlers.apiKey(dupeErr('uc_api_key'));
    expect(r.error).toContain('An API key with the name "API key" already exists');
  });

  it('app: applies app resource + name field', () => {
    const r = databaseErrorHandlers.app(dupeErr('unique_name_per_tenant'), 'My App');
    expect(r).toEqual({
      error: 'An app with the name "My App" already exists. Please choose a different name.',
    });
  });

  it('template: applies template resource + name field', () => {
    const r = databaseErrorHandlers.template(dupeErr('template_uniq'), 'Welcome');
    expect(r.error).toContain('A template with the name "Welcome" already exists');
  });

  it('repository: applies repository resource + URL field (not "name")', () => {
    // The repository handler is the only one whose fieldName is 'URL'.
    // A generic-fallback error MUST pick up the URL label, not "name".
    const r = databaseErrorHandlers.repository(dupeErr('arbitrary_no_match'), 'acme/api');
    expect(r.error).toBe('"acme/api" already exists. Please choose a different URL.');
  });
});
