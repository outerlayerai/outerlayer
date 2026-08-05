/**
 * Deployment-skew detection + reload-once guard, shared by the route error
 * boundary (`error.tsx`) and the global error boundary (`global-error.tsx`).
 *
 * "Deployment skew" = a client is running an OLD bundle while the server has
 * already shipped a NEW one. It surfaces two ways, both of which a single
 * reload fixes (the reload pulls fresh HTML that references the new assets):
 *
 *   1. Server Action skew — an action ID baked into the old client no longer
 *      exists on the server ("...was not found on the server").
 *   2. Chunk load skew — a hashed JS chunk the old client wants was replaced by
 *      the new deploy and 404s from the CDN (`ChunkLoadError`). This is what
 *      Turbopack/webpack throw on a failed `import()` of a stale chunk.
 *
 * Keep this logic in ONE place so both error boundaries share identical
 * skew detection.
 */

const RELOAD_FLAG = "deployment-skew-reload-attempted";

/**
 * How long one unrecovered incident's attempt count lives.
 *
 * This is what bounds the retry, and it is deliberately not tied to any signal
 * that the app came up. A successful mount is NOT evidence of a good deploy:
 * chunk skew characteristically mounts the shell fine and fails afterwards, on a
 * lazy `import()` of a chunk the new deploy replaced, so the mount always
 * arrives before the failure it would be vouching for. Restore the budget on it
 * and every reload gets a fresh one, which is an unbounded silent loop.
 *
 * What a duration buys is a RATE bound, not an absolute one: at most
 * {@link MAX_RELOAD_ATTEMPTS} reloads per TTL **through this module**, and the
 * next occurrence inside the TTL is reported. Past it the count is discarded and
 * a further two reloads are allowed — deliberately, since that is what lets a
 * long-lived session recover from a genuinely separate deploy. So an incident
 * that re-fails more slowly than the TTL is not capped, only slowed; it rests on
 * the empirical claim that five minutes is far longer than a deploy takes to
 * propagate, so a real skew re-manifests well inside the window. If that ever
 * stops holding, the fix is a separate long-lived incident counter, not a longer
 * TTL — a longer one strands the recovering session instead.
 *
 * The bound is NOT the whole application's. `utils/version-skew.ts` registers an
 * `unhandledrejection` handler that reloads on the same chunk-load class, keyed
 * on its own storage entry with its own shorter window, and it allows the reload
 * when storage cannot be read — the case this module refuses. A user meeting a
 * broken deploy can therefore be reloaded by either path, and the refusal here
 * does not bind the other one. Reason about them together before changing either.
 */
const RELOAD_BUDGET_TTL_MS = 5 * 60_000;

/**
 * How many reloads one unrecovered incident may spend before the error is
 * reported instead.
 *
 * Two, because the second reload is the one that catches a CDN edge still
 * serving the previous bundle; a third has never been observed to help and just
 * lengthens the time the user spends staring at "Updating application…".
 */
const MAX_RELOAD_ATTEMPTS = 2;

/**
 * Set once any boundary in this page load has scheduled a reload. Boundaries
 * are independent React subtrees: one deploy can trip two of them in a single
 * commit, and the second would otherwise read the first's milliseconds-old
 * stamp as evidence of an earlier failed reload and report a fault that has not
 * happened. Module scope is the correct lifetime — the reload replaces the
 * whole JS context, so this resets exactly when the page does.
 */
let reloadScheduled = false;

/** True when some boundary already scheduled this page load's reload. */
export function isReloadScheduled(): boolean {
  return reloadScheduled;
}

/** Claim the page-load-wide reload slot. */
export function noteReloadScheduled(): void {
  reloadScheduled = true;
}

/**
 * Drop the page-load-scoped flag. Production resets it by reloading; tests
 * share one module instance across cases and need it back by hand.
 */
export function resetPageLoadRecoveryState(): void {
  reloadScheduled = false;
}

/** Server Action ID went missing after a deploy. */
function isServerActionSkewError(error: Error): boolean {
  const message = error?.message;
  if (!message) return false;
  return (
    error.name === "UnrecognizedActionError" ||
    message.includes("was not found on the server") ||
    (message.includes("Server Action") && message.includes("was not found"))
  );
}

/**
 * A hashed static chunk failed to load — almost always because a new deploy
 * replaced it while this client still references the old name.
 *
 * Matched by `name` first (webpack and Turbopack both set
 * `error.name === "ChunkLoadError"`), with message fallbacks for cases where
 * the error is re-wrapped and loses its name (e.g. Turbopack's
 * "Failed to load chunk <id> from module <id>", webpack's
 * "Loading chunk <n> failed", and the lazy-loader's "Loading CSS chunk").
 *
 * Also covers failed dynamic `import()` of a module script, which is the same
 * stale-deploy symptom by a different code path: the browser fetches a hashed
 * module the new deploy already replaced. Each engine words it differently —
 * Safari "Importing a module script failed", Chromium "Failed to fetch
 * dynamically imported module", Firefox "error loading dynamically imported
 * module" — and none of them set `error.name = "ChunkLoadError"`, so they must
 * be matched by message. (The Sentry trace that motivated this was Safari
 * dropping in-flight module/React Server Component (RSC) loads on a client navigation.)
 */
function isChunkLoadError(error: Error): boolean {
  if (!error) return false;
  if (error.name === "ChunkLoadError") return true;

  const message = error.message;
  if (!message) return false;
  return (
    message.includes("Failed to load chunk") ||
    message.includes("Loading chunk") ||
    message.includes("Loading CSS chunk") ||
    message.includes("ChunkLoadError") ||
    // Failed dynamic import() of a stale module script (per-engine wording).
    message.includes("Importing a module script failed") ||
    message.includes("dynamically imported module")
  );
}

/**
 * True when the error is a recoverable deployment-skew symptom — i.e. reloading
 * to fetch the current bundle is the correct response, not showing an error.
 */
export function isDeploymentSkewError(error: Error): boolean {
  return isServerActionSkewError(error) || isChunkLoadError(error);
}

/**
 * True when the React RSC Flight streaming client closes the response stream
 * before a full payload was received.
 *
 * Thrown by `startReadingFromStream` in react-server-dom-turbopack-client when
 * the ReadableStream reader yields `{ done: true }` before the Flight protocol
 * has finished — e.g. a Server Action response interrupted by a network hiccup,
 * a `revalidatePath`-triggered RSC refresh aborted mid-stream, or an E2E test
 * navigating away before the stream completes. The error propagates through
 * React's fiber system and reaches the route error boundary despite any
 * try/catch at the call site.
 *
 * A single reload fetches a fresh RSC payload, which fixes the inconsistency.
 * The same reload guard ({@link inspectReloadGuard}) prevents a loop on a
 * genuine server error.
 */
export function isRscStreamClosedError(error: Error): boolean {
  return error?.message === "Connection closed.";
}

/** What the reload guard can currently tell us. */
export interface ReloadGuardState {
  /** False when session storage could not be read at all. */
  readable: boolean;
  /** Age of the stamp, for triage; null when there is none or it is unreadable. */
  msSinceLastReload: number | null;
  /**
   * Reloads this unrecovered incident has already spent. 0 when there is no
   * stamp, and also when the stamp has outlived {@link RELOAD_BUDGET_TTL_MS} —
   * an expired stamp belongs to a finished incident, not this one.
   */
  attempts: number;
  /** True when {@link MAX_RELOAD_ATTEMPTS} is spent and reloading again is not allowed. */
  attemptsExhausted: boolean;
}

const NO_STAMP: ReloadGuardState = {
  readable: true,
  msSinceLastReload: null,
  attempts: 0,
  attemptsExhausted: false,
};

/**
 * The stamp carries both halves of the guard: when the last reload happened and
 * how many this incident has spent. A bare number is the shape an older bundle
 * writes — and reading an older bundle's stamp is the literal case this whole
 * module exists for — so it is accepted as a single attempt rather than
 * discarded, which would hand a broken deploy a fresh budget on every reload.
 */
function parseStamp(raw: string): { at: number; attempts: number } | null {
  const [atPart, attemptsPart] = raw.split(":");
  const at = Number(atPart);
  if (!Number.isFinite(at)) return null;
  const attempts = attemptsPart === undefined ? 1 : Number(attemptsPart);
  if (!Number.isFinite(attempts) || attempts < 1) return null;
  return { at, attempts };
}

/**
 * Read the guard, keeping "storage is unavailable" distinguishable from "no
 * reload has happened". Callers need the difference: an unreadable guard is a
 * different incident from a reload that genuinely failed to fix anything, and
 * conflating them makes both untriageable.
 *
 * Never throws. This runs inside an error boundary's effect, so throwing would
 * take down the one surface that must never fail.
 */
export function inspectReloadGuard(): ReloadGuardState {
  if (typeof window === "undefined") return NO_STAMP;
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(RELOAD_FLAG);
  } catch {
    return { ...NO_STAMP, readable: false };
  }
  if (!raw) return NO_STAMP;
  const stamp = parseStamp(raw);
  if (!stamp) return NO_STAMP;
  const age = Date.now() - stamp.at;
  // A stamp from the future is a clock that moved backwards (an NTP correction
  // after running fast), not an incident. Its age stays negative, so the TTL
  // check below would never fire and the budget would read as exhausted for as
  // long as the skew lasts — a genuinely separate deploy inside that span would
  // get zero reloads and a report carrying a negative age. Discard it.
  if (age < 0) return NO_STAMP;
  // Past the TTL the count describes an incident that is over, so it must not
  // charge this one. Reporting it as a fresh budget is the whole point of the
  // TTL: it is what lets a long-lived session recover from a later deploy.
  if (age >= RELOAD_BUDGET_TTL_MS) return NO_STAMP;
  return {
    readable: true,
    msSinceLastReload: age,
    attempts: stamp.attempts,
    attemptsExhausted: stamp.attempts >= MAX_RELOAD_ATTEMPTS,
  };
}

/**
 * Stamp this reload — its moment and its place in the attempt budget — and
 * report whether the stamp actually landed.
 *
 * Storage can be readable but not writable — quota exhausted by other
 * same-origin code, or a webview that hands out a storage object whose writes
 * go nowhere. A silently-dropped stamp is the dangerous case: every subsequent
 * read says "no reload has happened", so the reload is authorized again on the
 * fresh page, forever, with no in-memory state surviving to bound it. The
 * return value exists so callers can refuse to reload rather than loop, and
 * the write is read back because a `setItem` that neither throws nor persists
 * is exactly the failure this guards.
 */
export function markReloadAttempted(previousAttempts: number): boolean {
  if (typeof window === "undefined") return true;
  const stamp = `${Date.now()}:${previousAttempts + 1}`;
  try {
    sessionStorage.setItem(RELOAD_FLAG, stamp);
    return sessionStorage.getItem(RELOAD_FLAG) === stamp;
  } catch {
    return false;
  }
}

/**
 * The stamp's own age is what ends an incident — see
 * {@link RELOAD_BUDGET_TTL_MS}. There is deliberately no way to clear the guard
 * early: every candidate signal for "recovered" is observable before the
 * failure it would be vouching for, so any of them can be satisfied by a page
 * load that is about to fail.
 */
