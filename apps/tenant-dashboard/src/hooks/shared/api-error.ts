import { ApiError } from '@/lib/api/client';

/**
 * SWR-style fetcher that throws `ApiError` (status-attached) on non-2xx.
 *
 * Preserves the HTTP status on failure, which `useClientLogger`'s 401/403/404
 * carve-out relies on. `ApiError` extends `Error`, so consumers that read
 * `error.message` keep working; consumers that read
 * `(err as Error & { status }).status` see it too.
 *
 * Use this for any client-side `fetch` whose error feeds `useSWR` /
 * `useClientLogger`. For openapi-fetch routes, use `dashboardApi` directly
 * — it already produces `ApiError` via `ApiError.from(error, response)`.
 *
 * @example
 *   const fetcher = (url: string) => apiFetch<TracesResponse>(url);
 *
 * @example  // POST with body
 *   apiFetch<WidgetData>('/api/x', {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify(payload),
 *   });
 */
export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw ApiError.from(
      body,
      response,
      `Request failed with status ${response.status}`,
    );
  }

  // A 2xx that isn't JSON means the request was silently redirected away
  // from the API (e.g. an expired session bounced to the login page and
  // fetch followed it). Surface that as an auth-shaped ApiError instead of
  // letting `.json()` throw a raw `Unexpected token '<'` SyntaxError into
  // the UI.
  const contentType = response.headers.get("content-type") ?? "";
  if (response.redirected || !contentType.includes("application/json")) {
    throw ApiError.from(
      {
        error: {
          code: "unauthorized",
          message:
            "Your session has expired. Please refresh the page and sign in again.",
        },
      },
      response,
    );
  }

  return response.json() as Promise<T>;
}

/**
 * Browser-native messages for a `fetch` that died WITHOUT an HTTP response:
 * connection drop, navigation/page-teardown abort, offline blip. Keyed by
 * exact message because that's all the browser gives us — these TypeErrors
 * carry no status and no error code.
 */
const NETWORK_FETCH_MESSAGES: ReadonlySet<string> = new Set([
  'Failed to fetch', // Chromium
  'NetworkError when attempting to fetch resource.', // Firefox
  'Load failed', // Safari
]);

/**
 * True when `err` is a transport-level fetch failure (the request never got
 * an HTTP response) or an explicit abort. These are transient by nature —
 * the next SWR tick retries and heals them — so they must not page on-call
 * (`use-client-logger.ts` routes them to Logtail) and must not toast over a
 * populated table (`use-fetch-error-notifier.ts` gates the snackbar).
 */
export function isTransientNetworkFetchError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  return err instanceof TypeError && NETWORK_FETCH_MESSAGES.has(err.message);
}
