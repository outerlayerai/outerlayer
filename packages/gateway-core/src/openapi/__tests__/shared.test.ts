import { describe, it, expect } from 'vitest';
import { structuredError } from '../routes/_shared';

describe('structuredError', () => {
  it('returns the canonical nested envelope', () => {
    const body = structuredError('trace_not_found', 'Trace not found');
    expect(body).toEqual({
      error: { code: 'trace_not_found', message: 'Trace not found' },
    });
  });

  it('merges extras alongside code and message', () => {
    const body = structuredError('missing_required_field', 'field required', {
      field: 'resource_id',
    });
    expect(body.error).toEqual({
      field: 'resource_id',
      code: 'missing_required_field',
      message: 'field required',
    });
  });

  it('does not let extras override code or message', () => {
    // Cast to any — the TS signature already prevents this at compile time;
    // this test guards runtime behavior if a caller slips past the types.
    const body = structuredError('score_not_found', 'Score not found', {
      code: 'tampered_code',
      message: 'tampered message',
    } as any);

    expect(body.error.code).toBe('score_not_found');
    expect(body.error.message).toBe('Score not found');
  });
});
