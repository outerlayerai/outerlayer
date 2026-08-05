/**
 * Client-safe environment variable exports.
 * These variables (NEXT_PUBLIC_*) can be safely imported by both client and server components.
 *
 * For server-only variables, use config-global.server.ts instead.
 */
import { env } from './env';

// Supabase (client-safe)
export const SUPABASE_API = {
  url: env.NEXT_PUBLIC_SUPABASE_URL,
  key: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
};

// App URL for external links (emails, webhooks, etc)
export const APP_URL = env.NEXT_PUBLIC_APP_URL;

// PostHog Analytics (UI host and project ID for dashboard links)
export const POSTHOG_UI_HOST = env.NEXT_PUBLIC_POSTHOG_UI_HOST;
export const POSTHOG_PROJECT_ID = env.NEXT_PUBLIC_POSTHOG_PROJECT_ID;

// Gateway URL for Cloudflare Workers — validated + defaulted in env.ts
// (schema `.default()` + runtimeEnv fallback), so no fallback belongs here.
export const GATEWAY_URL = env.NEXT_PUBLIC_GATEWAY_URL;

// API URL for CLI trace forwarding (Next.js API routes) — validated + defaulted
// in env.ts, same as GATEWAY_URL.
export const API_URL = env.NEXT_PUBLIC_API_URL;
