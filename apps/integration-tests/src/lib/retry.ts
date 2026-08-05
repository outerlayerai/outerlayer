/**
 * Bounded retry for transient Supabase infrastructure errors in test setup.
 *
 * Under CI load, local Supabase's Kong/PostgREST occasionally surfaces "An
 * invalid response was received from the upstream server" (a gateway blip),
 * dropped connections, or timeouts. Test-fixture setup writes are either
 * inserts of fresh random-keyed rows or idempotent updates, so re-issuing
 * them is safe — and one blip should not fail a whole suite (it took down
 * cli-routes and snapshot-storage runs on two different PRs in one day).
 *
 * Deterministic errors (constraint violations, RLS denials, bad payloads)
 * are returned immediately so real failures still surface on attempt one.
 */
export async function retryOnTransientError<R extends { error: { message: string } | null }>(
  fn: () => PromiseLike<R>,
  maxRetries = 3,
  delayMs = 500
): Promise<R> {
  // Generic over the WHOLE result (not just `data`) so PostgREST's
  // discriminated unions (`.single()`'s error-XOR-data) survive the wrapper —
  // callers keep their `if (error) throw` narrowing.
  let result = await fn();
  for (let i = 1; i < maxRetries; i++) {
    const message = result.error?.message ?? '';
    const isTransient =
      message.includes('upstream server') ||
      message.includes('ECONNRESET') ||
      message.includes('fetch failed') ||
      message.includes('timeout');
    if (!result.error || !isTransient) return result;

    await new Promise((resolve) => setTimeout(resolve, delayMs * i));
    result = await fn();
  }
  return result;
}

/**
 * Bounded retry for `admin.auth.admin.createUser()`. GoTrue's admin API
 * returns `{ data, error }` too, but under the same Kong/PostgREST gateway
 * load `retryOnTransientError` guards against, a blip here can come back as
 * an error whose `.message` doesn't contain the "upstream server" substring
 * (an empty/malformed body from a dropped gateway response) rather than a
 * clean PostgREST-shaped error — so this retries on ANY error, not a
 * substring match. That's safe specifically for user creation: callers
 * always pass a freshly random, never-before-used email, so there is no
 * deterministic failure mode (unlike table writes, where a real constraint
 * violation must surface on attempt one) — the only way this call fails is
 * a transient one.
 */
export async function retryCreateAuthUser<R extends { error: { message: string } | null }>(
  fn: () => PromiseLike<R>,
  maxRetries = 3,
  delayMs = 500
): Promise<R> {
  let result = await fn();
  for (let i = 1; i < maxRetries && result.error; i++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs * i));
    result = await fn();
  }
  return result;
}
