/**
 * Ephemeral-mode param fetch: trade the single-use WORKER_TOKEN
 * for the run's params payload. The dashboard route deletes the Vault entry
 * on first read, so this succeeds exactly once.
 */

const FETCH_TIMEOUT_MS = 10_000;

export async function fetchWorkerParams(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
  const token = env.WORKER_TOKEN;
  const runId = env.WORKER_RUN_ID;
  const dashboardUrl = env.DASHBOARD_URL;
  if (!token || !runId || !dashboardUrl) {
    throw new Error(
      'ephemeral mode requires WORKER_TOKEN, WORKER_RUN_ID, and DASHBOARD_URL',
    );
  }
  const url = `${dashboardUrl}/api/internal/worker-params?worker_run_id=${encodeURIComponent(runId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Failed to fetch worker params: ${res.status} — ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}
