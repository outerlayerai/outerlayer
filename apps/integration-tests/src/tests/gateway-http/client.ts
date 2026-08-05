/**
 * Thin fetch wrapper for gateway HTTP tests.
 *
 * Defaults to the seeded test app id + the REAL peppered API key minted for
 * that app by the seed script (`getTestApiKey`). The gateway verifies it via
 * the `verify_api_key` RPC — this is the real auth path, not a DEV_SKIP_UNKEY
 * bypass. Individual auth-boundary tests can omit headers or pass overrides.
 *
 * `mintTestApiKey` mints a SECOND real key against local Supabase (service-role
 * client) for cross-identity tests — e.g. proving that tenant B's key paired
 * with tenant A's app-id header is rejected at the verify appId cross-check.
 */

import { GATEWAY_URL, getTestApiKey, getTestAppId, getTestTenantId } from '../../../gateway-http/setup-gateway';
import { mintTestApiKey } from '../../lib/mint-test-key';

export { getTestApiKey, getTestTenantId };
// Re-exported from the harness-independent shared helper (`src/lib/mint-test-key`)
// so the gateway-http suite and the environments (parallel-project) suites mint
// keys through one code path and can never drift on the crypto or pepper source.
export { mintTestApiKey };

export type GatewayFetchInit = RequestInit & {
  /** Omit the Authorization header entirely (for auth-boundary tests). */
  noAuth?: boolean;
  /** Omit X-Outerlayer-App-Id (for auth-boundary tests). */
  noAppId?: boolean;
  /** Override the app id (e.g. to test invalid/unknown app ids). */
  appId?: string;
};

export async function gatewayFetch(
  path: string,
  init: GatewayFetchInit = {},
): Promise<Response> {
  const { noAuth, noAppId, appId, headers, ...rest } = init;

  const merged: Record<string, string> = {
    'content-type': 'application/json',
    ...(headers as Record<string, string>),
  };

  if (!noAuth && merged.authorization === undefined) {
    merged.authorization = `Bearer ${getTestApiKey()}`;
  }
  if (!noAppId && merged['x-outerlayer-app-id'] === undefined) {
    merged['x-outerlayer-app-id'] = appId ?? getTestAppId();
  }

  return fetch(`${GATEWAY_URL}${path}`, { ...rest, headers: merged });
}
