/**
 * A drop-in `fetch` that transparently re-issues a request when local Supabase's
 * Kong/PostgREST returns a transient gateway blip under the parallel load this
 * suite generates: a 502/503 ("An invalid response was received from the
 * upstream server") or a dropped network connection.
 *
 * Why at the transport and not as a whole-test retry: this re-issues ONLY the
 * single failed HTTP request, and ONLY on transient *infrastructure* signals —
 * gateway 502/503 (upstream unreachable, so the query never ran) and thrown
 * network errors (the request never completed). PostgREST *logic* errors
 * (constraint violations, RLS denials, bad payloads) come back as normal 4xx
 * JSON and are returned untouched, so real bugs still fail on attempt one and no
 * non-idempotent test body is replayed. It is the operation-level retry the
 * suite already uses (`src/lib/retry.ts`) lifted to the transport, so every
 * client call is covered without per-call wrapping.
 *
 * 504 (gateway timeout) is deliberately NOT retried: a timed-out write may have
 * committed, and re-issuing it could double-insert.
 */
const TRANSIENT_STATUS = new Set([502, 503]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryingFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  maxRetries = 4,
  baseDelayMs = 250,
  // The underlying fetch to wrap. Defaults to the current global (evaluated
  // per-call, so retrying-fetch's own unit tests can `globalThis.fetch = mock`
  // and have it honored). Callers that must NOT be rerouted by a later global
  // stub — the Supabase admin client — pass a fetch captured at their own
  // module-load time instead (see `supabase-admin.ts`). Binding to globalThis
  // preserves undici's fetch receiver.
  baseFetch: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await baseFetch(input, init);
      if (TRANSIENT_STATUS.has(res.status) && attempt < maxRetries) {
        // Discard the gateway error body so undici doesn't warn about an
        // undisposed stream, then back off and retry.
        await res.body?.cancel().catch(() => {});
        await delay(baseDelayMs * attempt);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await delay(baseDelayMs * attempt);
        continue;
      }
    }
  }

  throw lastError;
}
