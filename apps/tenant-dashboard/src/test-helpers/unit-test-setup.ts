// Import testing library extensions
import type { env as dashboardEnv } from '../env';
import * as matchers from '@testing-library/jest-dom/matchers';
import { expect } from 'vitest';
import { TextEncoder, TextDecoder } from 'node:util';
import { toHaveNoViolations } from 'jest-axe';
import { setupBasicMocks, resetMocks } from './mocks';
import { server } from './msw-server';
import { resetMswState } from './msw-handlers';
import { getSupabaseTestCookieStore } from './supabase-session';

expect.extend(matchers);
// Adds the `toHaveNoViolations` matcher used by src/test-helpers/a11y.ts.
// Co-locating this with the jest-dom registration keeps the "what's available
// on expect()" answer in one file.
expect.extend(toHaveNoViolations);

// Set up global polyfills
Object.assign(globalThis, {
  TextEncoder,
  TextDecoder,
});

// Setup basic mocks only
setupBasicMocks();

// Start MSW at setup module scope — BEFORE any test file imports its modules —
// not in `beforeAll` (which runs after those imports). With native `fetch`, MSW
// intercepts by replacing `globalThis.fetch`; an `openapi-fetch` client created
// at module load (e.g. `lib/apps/server-client.ts`, `lib/api/client.ts`) captures
// `globalThis.fetch` at that moment, so the patch has to be in place first or
// its requests escape to the real network (ECONNREFUSED). Under the deprecated
// node-fetch polyfill this didn't matter — MSW patched the `http` layer, not the
// fetch reference. `afterEach` still resets handlers; `afterAll` still closes.
server.listen({ onUnhandledRequest: 'error' });

const originalConsoleWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (
    typeof args[0] === 'string' &&
    args[0].includes('Multiple GoTrueClient instances detected in the same browser context')
  ) {
    return;
  }
  originalConsoleWarn(...args);
};

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

// Reset mocks between tests
beforeEach(() => {
  resetMocks();
  resetMswState();
});

// ---------------------------------------------------------------------------
// Deterministic DOM teardown for jsdom test files.
//
// @testing-library/react auto-registers cleanup() in a single afterEach. Under
// the threaded CI suite that one hook is not enough: when an async component
// test exceeds testTimeout (CPU contention across parallel workers), its
// teardown is skipped and the timed-out test's mounted React tree is left in
// the document. The next test then renders a SECOND copy of the same component
// and getByRole throws "Found multiple elements" — the flake that turned
// permission-picker.test.tsx red in CI while passing 19/19 in isolation.
//
// Running cleanup() in beforeEach (as well as afterEach) makes every test start
// from a clean DOM regardless of whether the PREVIOUS test tore itself down, so
// a single timed-out test can't cascade into its neighbours.
//
// Guarded on `document` so the ~194 pure-logic files that run under the `node`
// environment never pull in react-dom.
// ---------------------------------------------------------------------------
if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react');
  beforeEach(() => cleanup());
  afterEach(() => cleanup());
}

// Mock all complex modules that cause import issues
vi.mock('@outerlayer/locales', () => ({
  useTranslate: () => ({
    t: (key: string) => key, // Return the key itself instead of hardcoded translations
  }),
  LocalizationProvider: ({ children }: any) => children,
  // The locale bootstrap touches these at module load.
  init: () => {},
  i18n: {
    isInitialized: true,
    getResourceBundle: () => undefined,
    addResourceBundle: () => {},
    setDefaultNamespace: () => {},
  },
}));

vi.mock('@/theme', () => ({
  __esModule: true,
  default: ({ children }: any) => children,
  ThemeProvider: ({ children }: any) => children,
}));

vi.mock('@/components/iconify', () => ({
  __esModule: true,
  default: () => null,
}));

// Mock Next.js modules
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  usePathname: vi.fn(() => '/test-path'),
  useParams: vi.fn(() => ({})),
}));

vi.mock('next/headers', () => ({
  cookies: () => getSupabaseTestCookieStore(),
  headers: () => ({
    get: vi.fn(),
  }),
}));

vi.mock('next/font/google', () => ({
  Geist: () => ({
    style: {
      fontFamily: 'Geist, sans-serif',
    },
  }),
  JetBrains_Mono: () => ({
    style: {
      fontFamily: 'JetBrains Mono, monospace',
    },
  }),
}));

// Mock server actions
vi.mock('../utils/actions', () => ({
  revalidateServerPath: vi.fn(),
  revalidateServerTag: vi.fn(),
}));

// Mock getCurrentUserPermissions
vi.mock('../utils/get-user-permissions', () => ({
  getCurrentUserPermissions: vi.fn().mockResolvedValue([]),
}));

// Mock useAuthContext when not wrapped in provider
vi.mock('../auth/hooks', () => ({
  useAuthContext: vi.fn(() => ({
    login: vi.fn(),
    logout: vi.fn(),
    user: null,
    loading: false,
  })),
}));

// Mock supabase client
vi.mock('../supabaseFrontendClient', () => ({
  createSupabaseFontendClient: vi.fn(),
}));

// Mock hooks
vi.mock('../hooks/use-boolean', () => ({
  useBoolean: () => ({
    value: false,
    onTrue: vi.fn(),
    onFalse: vi.fn(),
    onToggle: vi.fn(),
    setValue: vi.fn(),
  }),
}));

vi.mock('../hooks/use-local-storage', () => ({
  useLocalStorage: () => [null, vi.fn()],
}));

// Mock components
vi.mock('@/components/snackbar', () => ({
  SnackbarProvider: ({ children }: any) => children,
  useSnackbar: () => ({
    enqueueSnackbar: vi.fn(),
  }),
}));

vi.mock('@/components/settings', () => ({
  SettingsProvider: ({ children }: any) => children,
  useSettingsContext: () => ({
    themeMode: 'light',
  }),
}));

vi.mock('../components/hook-form', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: ({ children, onSubmit }: any) => React.createElement('form', {
      onSubmit: (e: any) => {
        e.preventDefault();
        onSubmit();
      }
    }, children),
    RHFTextField: ({ name, label, type, InputProps }: any) =>
      React.createElement('div', {}, [
        React.createElement('label', { key: 'label', htmlFor: name }, label),
        React.createElement('input', {
          key: 'input',
          id: name,
          name: name,
          type: type || 'text',
          'aria-label': label,
        }),
        InputProps?.endAdornment &&
          React.createElement('span', {
            key: 'toggle',
            role: 'button',
            'aria-label': 'toggle password visibility eye'
          })
      ]),
  };
});

// Mock TermsCheckbox component
vi.mock('../components/terms-checkbox', () => {
  const React = require('react');
  return {
    __esModule: true,
    TermsCheckbox: () =>
      React.createElement('div', {}, [
        React.createElement('input', {
          key: 'checkbox',
          type: 'checkbox',
          'data-testid': 'terms-checkbox',
        }),
        React.createElement('a', {
          key: 'terms-link',
          href: 'https://www.agentmark.co/terms',
          target: '_blank',
          rel: 'noopener noreferrer',
          'data-testid': 'terms-link',
        }, 'Terms of Service'),
        React.createElement('a', {
          key: 'privacy-link',
          href: 'https://www.agentmark.co/privacy',
          target: '_blank',
          rel: 'noopener noreferrer',
          'data-testid': 'privacy-link',
        }, 'Privacy Policy'),
        React.createElement('span', {
          key: 'version',
          'data-testid': 'terms-version',
        }, 'Version 2026-01-10'),
      ]),
    // The plain-state-managed sibling `TermsCheckbox` wraps for react-hook-
    // form-less callers (e.g. the invite-acceptance flow). Controlled here
    // so a test can drive checked/unchecked via a real click, same as the
    // production checkbox.
    TermsCheckboxField: ({
      checked,
      onChange,
      error,
    }: {
      checked: boolean;
      onChange: (checked: boolean) => void;
      error?: string | null;
    }) =>
      React.createElement('div', {}, [
        React.createElement('input', {
          key: 'checkbox',
          type: 'checkbox',
          checked,
          'aria-invalid': error ? true : undefined,
          'data-testid': 'terms-checkbox',
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.checked),
        }),
        React.createElement('a', {
          key: 'terms-link',
          href: 'https://www.agentmark.co/terms',
          target: '_blank',
          rel: 'noopener noreferrer',
          'data-testid': 'terms-link',
        }, 'Terms of Service'),
        React.createElement('a', {
          key: 'privacy-link',
          href: 'https://www.agentmark.co/privacy',
          target: '_blank',
          rel: 'noopener noreferrer',
          'data-testid': 'privacy-link',
        }, 'Privacy Policy'),
        error && React.createElement('span', { key: 'error', 'data-testid': 'terms-error' }, error),
      ]),
  };
});

// Mock routes. `paths` (auth/dashboard) stays stubbed, but expose the REAL
// `appPaths` route builders — they're pure string templates with no imports, so
// components that build hrefs via `appPaths.*` (e.g. ExperimentDetail's
// "Back to Experiments" button) can render under test instead of crashing on an
// undefined `appPaths`.
vi.mock('../routes/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../routes/paths')>();
  return {
    paths: {
      auth: {
        login: '/auth/login',
        register: '/auth/register',
        forgotPassword: '/auth/forgot-password',
        newPassword: '/auth/new-password',
        linkExpired: '/auth/link-expired',
        verify: '/auth/verify',
      },
      dashboard: {
        root: '/orgs',
      },
      device: {
        root: '/device',
      },
      orgs: {
        org: {
          device: { root: (orgName: string) => `/orgs/${orgName}/device` },
        },
      },
    },
    appPaths: actual.appPaths,
    APP_LEVEL_SEGMENTS: actual.APP_LEVEL_SEGMENTS,
  };
});

vi.mock('../routes/components', () => {
  const React = require('react');
  return {
    RouterLink: React.forwardRef(function RouterLink({ children, href }: any, ref: any) {
      return React.createElement('a', { href, ref }, children);
    }),
  };
});

// Mock env with actual test values (not undefined)
// This is the ROOT FIX: T3 Env validation happens at import time,
// so we must mock the module to provide real values for tests.
const mockEnvValues = {
  // Server - Required
  SUPABASE_SECRET_KEY: 'test-service-role-key',
  UNKEY_API_KEY: 'test-unkey-api-key',
  STRIPE_SECRET_KEY: 'sk_test_stripe_secret_key',
  STRIPE_SECRET_WEBHOOK_KEY: 'whsec_test_webhook_key',
  STRIPE_GROWTH_FLAT_PRICE_ID: 'price_test_growth_flat',
  STRIPE_TEAM_FLAT_PRICE_ID: 'price_test_team_flat',
  STRIPE_GROWTH_USAGE_PRICE_ID: 'price_test_growth_usage',
  STRIPE_TEAM_USAGE_PRICE_ID: 'price_test_team_usage',
  STRIPE_GROWTH_STORAGE_PRICE_ID: 'price_test_growth_storage',
  STRIPE_TEAM_STORAGE_PRICE_ID: 'price_test_team_storage',
  STRIPE_SPAN_METER_ID: 'meter_test_span',
  CRON_SECRET: 'test-cron-secret',
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\ntest-key\n-----END RSA PRIVATE KEY-----',
  GITHUB_APP_WEBHOOK_SECRET: 'test-webhook-secret',
  // Signs git-connect OAuth state AND transcript image URLs; the schema
  // requires 32+ chars, so keep any replacement at least that long.
  OAUTH_STATE_SECRET: 'test-oauth-state-secret-at-least-32-chars',
  TOKEN_ENCRYPTION_KEY: 'test-encryption-key-must-be-32-chars!',
  EMAIL_ENABLED: 'false',
  NODE_ENV: 'test' as const,

  // Server - Optional
  EMAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 'test-resend-api-key',
  FROM_EMAIL: 'test@example.com',
  REPLY_TO_EMAIL: 'reply@example.com',
  RESEND_BROADCAST_AUDIENCE_ID: 'test-audience-id',
  SMTP_HOST: undefined,
  SMTP_PORT: undefined,
  SMTP_USER: undefined,
  SMTP_PASS: undefined,
  SMTP_SECURE: undefined,
  CLICKHOUSE_HOST: undefined,
  CLICKHOUSE_PASSWORD: undefined,

  // Client - Required
  NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'test-anon-key',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3002',
  NEXT_PUBLIC_PLATFORM_ADMIN_EMAIL_DOMAIN: '@outerlayer.ai',

  // Client - Optional
  NEXT_PUBLIC_POSTHOG_UI_HOST: undefined,
  NEXT_PUBLIC_POSTHOG_PROJECT_ID: undefined,
} satisfies Partial<Record<keyof typeof dashboardEnv, unknown>>;

Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_URL: mockEnvValues.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: mockEnvValues.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_SECRET_KEY: mockEnvValues.SUPABASE_SECRET_KEY,
});

vi.mock('../env', () => ({
  env: mockEnvValues,
}));

vi.mock('../config-global', () => ({
  SUPABASE_API: {
    url: 'http://localhost:54321',
    key: 'test-anon-key',
  },
  // Stable test base for the dashboard ⇄ gateway boundary. Used by the
  // alerts client and any other module that posts to /v1/* — MSW handlers
  // match on `${GATEWAY_URL}/v1/...` so the value just has to be a valid
  // URL, not a real one.
  GATEWAY_URL: 'http://localhost:9100',
  SUPABASE_SECRET_KEY: 'test-service-role-key',
  UNKEY_API_KEY: 'test-unkey-api-key',
  CUBEJS_API_URL: undefined,
  CUBEJS_WS_URL: undefined,
  STRIPE_SECRET_KEY: 'sk_test_stripe_secret_key',
  STRIPE_SECRET_WEBHOOK_KEY: 'whsec_test_webhook_key',
  STRIPE_GROWTH_FLAT_PRICE_ID: 'price_test_growth_flat',
  STRIPE_TEAM_FLAT_PRICE_ID: 'price_test_team_flat',
  STRIPE_GROWTH_USAGE_PRICE_ID: 'price_test_growth_usage',
  STRIPE_TEAM_USAGE_PRICE_ID: 'price_test_team_usage',
  STRIPE_GROWTH_STORAGE_PRICE_ID: 'price_test_growth_storage',
  STRIPE_TEAM_STORAGE_PRICE_ID: 'price_test_team_storage',
  STRIPE_SPAN_METER_ID: 'meter_test_span',
  CRON_SECRET: 'test-cron-secret',
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\ntest-key\n-----END RSA PRIVATE KEY-----',
  GITHUB_APP_WEBHOOK_SECRET: 'test-webhook-secret',
  RESEND_API_KEY: 'test-resend-api-key',
  FROM_EMAIL: 'test@example.com',
  RESEND_BROADCAST_AUDIENCE_ID: 'test-audience-id',
  CLICKHOUSE_HOST: undefined,
  CLICKHOUSE_PASSWORD: undefined,
  TOKEN_ENCRYPTION_KEY: 'test-encryption-key-must-be-32-chars!',
  EMAIL_ENABLED: 'false',
  APP_URL: 'http://localhost:3002',
  POSTHOG_UI_HOST: undefined,
  POSTHOG_PROJECT_ID: undefined,
  API_URL: 'https://api.agentmark.co',
}));

// Mock @mui/x-data-grid to prevent CSS import errors in jsdom
vi.mock('@mui/x-data-grid', () => ({}));
vi.mock('@mui/x-data-grid/internals', () => ({}));

// Mock @repo/transactional to avoid ESM import issues with marked/react-email
vi.mock('@repo/transactional', () => ({
  ResetPasswordEmail: () => null,
  InviteUserEmail: () => null,
  ConfirmSignupEmail: () => null,
  BuildFailureEmail: () => null,
  RoleChangedEmail: () => null,
  RemovedFromOrgEmail: () => null,
  TempAccessNotificationEmail: () => null,
}));

// Global test utilities (only in browser-like environments)
if (typeof window !== 'undefined') {
  // Must be a real (constructable) class: MUI v9's Select/Autocomplete
  // instantiate it with `new ResizeObserver()`, and a `vi.fn()` wrapping an
  // arrow implementation throws "is not a constructor" when called with `new`.
  global.ResizeObserver = class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  };

  // Mock window.matchMedia
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(query => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}
