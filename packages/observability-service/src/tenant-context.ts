// Re-export from the public workspace package surface.
// `@repo/api-types` is declared as a workspace:* dependency in
// package.json; turbo orchestrates its build before this package's typecheck,
// so dist/ is always available when consumers resolve these symbols.
export type { VerifiedAppId, TenantContext } from '@repo/api-types';
export {
  createVerifiedAppId,
  isTenantContext,
} from '@repo/api-types';
