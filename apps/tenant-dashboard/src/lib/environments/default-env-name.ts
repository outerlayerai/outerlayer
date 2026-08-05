/**
 * The default environment name seeded on every app at creation time
 * (`environment.is_default = true`, name `dev`).
 *
 * Lives in this plain (non-`'use client'`) module so BOTH server components
 * (e.g. the bare-app redirect `page.tsx`) and client code can import it.
 * `@/context/env-context` re-exports it for the many client callers that
 * import it from there; importing the const out of that
 * `'use client'` module into a SERVER component instead yields a client-
 * reference stub (Next stringifies it), not the value.
 */
export const DEFAULT_ENV_NAME = 'dev';
