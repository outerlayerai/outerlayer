/**
 * Side-effect import for core tests that drive a live `/v1/*` request through
 * `openApiApp`: injects the fake composition root so the gtx middleware builds a
 * `gtx` without reaching for the Cloudflare adapters. Mirrors apps/gateway's
 * `inject-cf-gateway-context`, but with the in-process fake. Import once:
 *
 *     import '../../test-helpers/inject-fake-gateway-context';
 */
import { setGatewayContextFactory } from '../openapi';
import { fakeBuildGatewayContext } from './fake-gateway-context';

setGatewayContextFactory(fakeBuildGatewayContext);
