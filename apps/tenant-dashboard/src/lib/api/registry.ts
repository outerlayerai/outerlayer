/**
 * Shared OpenAPI registry for the dashboard API.
 *
 * Routes register their schemas at import time (via `withApi()` in each
 * `route.ts`). The spec generator (`scripts/generate-openapi.ts`) imports
 * a single file that imports every `route.ts`, walks this registry, and
 * emits `docs/dashboard-openapi.yaml`.
 *
 * Uses `@asteasolutions/zod-to-openapi` — the same library chanfana wraps
 * on the gateway side. Keeping the underlying library identical guarantees
 * that schema semantics (coercion, default, passthrough) render the same
 * way in both specs.
 */

import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import type { OpenAPIObject } from 'openapi3-ts/oas30';

extendZodWithOpenApi(z);

export const dashboardApiRegistry = new OpenAPIRegistry();

/**
 * Generate an OpenAPI 3.0.3 document from the current registry state.
 * Called by `scripts/generate-openapi.ts`.
 *
 * The explicit return type pins the `openapi3-ts` version TypeScript resolves
 * this to — without it, the inferred type points at zod-to-openapi's own
 * nested `openapi3-ts` copy, which isn't nameable from outside the package.
 */
export function generateDashboardSpec(): OpenAPIObject {
  const generator = new OpenApiGeneratorV3(dashboardApiRegistry.definitions);

  return generator.generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'OuterLayer Dashboard API',
      version: '1.0',
      description:
        'Internal HTTP API that the OuterLayer dashboard web app uses for ' +
        'tenant-scoped reads/writes. This surface is served by the same ' +
        'Next.js app as the UI and authenticates via Supabase session cookie. ' +
        'Not a public API — for programmatic access use the Gateway API at ' +
        'api.agentmark.co.',
    },
    servers: [
      { url: 'https://app.outerlayer.ai', description: 'Production dashboard' },
      { url: 'http://localhost:3002', description: 'Local dev server' },
    ],
    // `security` + `securitySchemes` are injected by the generator script
    // so we don't have to duplicate them on every `registry.registerPath()`.
  });
}
