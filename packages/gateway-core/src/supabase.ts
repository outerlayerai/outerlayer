// The admin client factory lives in `./lib/admin-client` so that its import
// path shows at every call site that the code bypasses RLS, and so a single
// ESLint rule can ban that one path. Do not re-export it from here.
export { createTenantScopedClient } from './lib/scoped-client';
