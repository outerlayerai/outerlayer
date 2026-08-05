/**
 * Tests: CLI Auth Helper
 *
 * Unit tests for createCliSupabaseClient() — Bearer token extraction and the
 * per-request Supabase client. (API-key verification belongs to the gateway's
 * Postgres key-store, not to this helper.)
 */

import { createCliSupabaseClient } from '../auth-helper';

describe('createCliSupabaseClient', () => {
  it('should return null when Authorization header is missing', () => {
    const request = new Request('http://localhost/api/cli/test', {
      method: 'GET',
    });
    const result = createCliSupabaseClient(request);
    expect(result).toBeNull();
  });

  it('should return null when Authorization header does not start with Bearer', () => {
    const request = new Request('http://localhost/api/cli/test', {
      method: 'GET',
      headers: { Authorization: 'Basic abc123' },
    });
    const result = createCliSupabaseClient(request);
    expect(result).toBeNull();
  });

  it('should return a Supabase client when valid Bearer token is present', () => {
    const request = new Request('http://localhost/api/cli/test', {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-jwt-token' },
    });
    const result = createCliSupabaseClient(request);
    expect(result).not.toBeNull();
  });
});
