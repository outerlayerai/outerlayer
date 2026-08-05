import { describe, it, expect } from 'vitest';
import { mintGatewayJwt } from './jwt';

/** Decode a JWT without verifying the signature (test-only). */
function decodePayload(jwt: string): Record<string, unknown> {
  const [, payloadB64] = jwt.split('.');
  const json = Buffer.from(payloadB64!, 'base64url').toString('utf-8');
  return JSON.parse(json);
}

describe('mintGatewayJwt', () => {
  const SECRET = 'test-secret-at-least-32-chars-long!!';
  const TENANT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const SYSTEM_USER_ID = '11111111-2222-3333-4444-555555555555';

  it('should set sub to systemUserId, not tenantId', async () => {
    const token = await mintGatewayJwt(SECRET, TENANT_ID, SYSTEM_USER_ID, ['trace.read']);
    const payload = decodePayload(token);

    expect(payload.sub).toBe(SYSTEM_USER_ID);
    expect(payload.sub).not.toBe(TENANT_ID);
  });

  it('should include tenant_id in app_metadata', async () => {
    const token = await mintGatewayJwt(SECRET, TENANT_ID, SYSTEM_USER_ID, ['trace.read']);
    const payload = decodePayload(token);

    expect((payload.app_metadata as any).tenant_id).toBe(TENANT_ID);
  });

  it('should include gateway_permissions array', async () => {
    const perms = ['trace.read', 'template.read'];
    const token = await mintGatewayJwt(SECRET, TENANT_ID, SYSTEM_USER_ID, perms);
    const payload = decodePayload(token);

    expect(payload.gateway_permissions).toEqual(perms);
  });

  it('should set role to gateway and issuer to gateway', async () => {
    const token = await mintGatewayJwt(SECRET, TENANT_ID, SYSTEM_USER_ID, []);
    const payload = decodePayload(token);

    expect(payload.role).toBe('gateway');
    expect(payload.iss).toBe('gateway');
  });

  it('should set aud to authenticated to match Supabase Auth token shape', async () => {
    const token = await mintGatewayJwt(SECRET, TENANT_ID, SYSTEM_USER_ID, []);
    const payload = decodePayload(token);

    expect(payload.aud).toBe('authenticated');
  });

  it('should set expiry to 60 seconds after iat', async () => {
    const token = await mintGatewayJwt(SECRET, TENANT_ID, SYSTEM_USER_ID, []);
    const payload = decodePayload(token);

    expect((payload.exp as number) - (payload.iat as number)).toBe(60);
  });

  it('should produce a valid 3-part JWT string', async () => {
    const token = await mintGatewayJwt(SECRET, TENANT_ID, SYSTEM_USER_ID, []);
    const parts = token.split('.');

    expect(parts).toHaveLength(3);
    // Each part should be non-empty base64url
    parts.forEach((part) => {
      expect(part.length).toBeGreaterThan(0);
      expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });
});
