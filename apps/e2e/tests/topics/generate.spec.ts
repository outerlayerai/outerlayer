/**
 * Critical-path E2E: Trace Topics — full pipeline in a LOCAL
 * browser. Sessions ingest through the real gateway, the enrichment cron
 * (mock model mode) writes facets + embeddings, generation clusters
 * them via the live topics-clustering container, and the Insights page
 * (the Topics surface) shows named topics.
 *
 * The topic→traces drill-down is a deliberate NO-OP — there is no standalone
 * Traces view to land on. Clicking a row must NOT navigate (pinned below)
 * until the agent-sessions list grows a topic filter to drill into.
 *
 * Why this shape:
 *   - Setup uses the real `/v1/agents/sync` endpoint — the enrichment scan,
 *     blob handling, and env stamping are all exercised, not simulated.
 *   - The enrichment tick is fired via wrangler's `--test-scheduled`
 *     endpoint (`GET /__scheduled`) instead of waiting for wall-clock
 *     minutes — deterministic and fast, same code path as production.
 *   - Verification is UI-only: summaries-collected counter, topic table.
 *     No reading ClickHouse back to "confirm".
 *   - Model calls run in deterministic mock mode (spec D8): feature-hash
 *     embeddings preserve text similarity, so UMAP+HDBSCAN, centroids,
 *     naming-fallback, reconciliation, and classification run for real —
 *     only the LLM provider is faked.
 *
 * Local requirements (beyond the standard four services):
 *   - Gateway started with `--test-scheduled` and:
 *       TOPICS_ENRICHMENT_ENABLED=true TOPICS_MOCK_MODEL=true
 *       TOPICS_DEBOUNCE_MINUTES=1 TOPICS_BATCH_LIMIT=200
 *     e.g. `cd apps/gateway && GATEWAY_PORT=9101 npx wrangler dev --port 9101 \
 *       --test-scheduled --var TOPICS_ENRICHMENT_ENABLED:true \
 *       --var TOPICS_MOCK_MODEL:true --var TOPICS_DEBOUNCE_MINUTES:1 \
 *       --var TOPICS_BATCH_LIMIT:200`
 *   - topics-clustering container on :8080 (`cd apps/topics-clustering &&
 *     docker compose up -d`); the dashboard needs TOPICS_MOCK_MODEL=true —
 *     generation refuses to silently fall back to the mock model, so
 *     without it every Generate click 503s. Clustering needs no extra vars
 *     (defaults to http://localhost:8080, no secret locally).
 *   - A ClickHouse with residual un-enriched traces from other local runs may
 *     need a few extra cron ticks — the spec fires ticks until the UI-visible
 *     summary count reaches the target (idempotent; errored traces are never
 *     rescanned).
 */

import { test, expect, type Page } from '@playwright/test';
import { randomBytes } from 'crypto';
import {
  waitForSupabase,
  createTestOwnerWithOrg,
  cleanupTestOwnerWithOrg,
  createTestApp,
  cleanupTestApp,
  loginTestUser,
  mintApiKey,
  type TestUser,
  type TestOrganization,
  type TestApp,
} from '../utils/test-helpers';

const GATEWAY_URL = process.env.E2E_GATEWAY_URL ?? 'http://localhost:9101';
const FIRST_COMPILE_GOTO_TIMEOUT = 180_000;

/** Three behavioral patterns + outliers. 38×3 + 6 = 120 traces (floor is 100). */
const PATTERNS = [
  {
    key: 'refund',
    count: 38,
    input: (i: number) =>
      `I want a refund for my delayed shipment order ${1000 + i}, the package never arrived`,
    output: (i: number) =>
      `Refund initiated for the delayed shipment order ${1000 + i}`,
  },
  {
    key: 'password',
    count: 38,
    input: (i: number) =>
      `I cannot login to my account after the password reset attempt ${i}`,
    output: () => `Password reset link sent to restore login access`,
  },
  {
    key: 'invoice',
    count: 38,
    input: (i: number) =>
      `Please explain the extra charge on my latest invoice billing statement ${2000 + i}`,
    output: () => `The invoice charge covers the premium plan upgrade`,
  },
] as const;

const OUTLIERS = [
  'What are your store opening hours downtown on weekends',
  'Can I bring my golden retriever to the rooftop cafe',
  'Translate this greeting into formal Japanese please',
  'Recommend a sturdy hiking backpack for alpine winter routes',
  'How do I export my yearly report as an interactive chart',
  'Does the mobile app support offline queue synchronization yet',
];

/** The sync route's per-request session cap, mirrored so the batching below
 * fails loudly here rather than as a 400 from the gateway. */
const MAX_SESSIONS_PER_SYNC = 50;

/**
 * Build one canonical AgentSession carrying a single user→assistant exchange.
 *
 * The enrichment scan reads each trace's derived Input/Output, so a two-turn
 * session is the smallest shape that gives a topic real text on both sides.
 * `costUsd` is deliberately OMITTED: the converter then resolves gpt-4 pricing
 * and derives cost from `usage`, which is the production path — passing a
 * literal would skip the code the per-topic avg-cost column depends on.
 */
function buildSession(
  text: { input: string; output: string },
  index: number,
  stampBase: number,
): Record<string, unknown> {
  // Spread across the last ~20 hours (within the enrichment lookback window)
  // so the topics-over-time chart has a real axis; vary latency and tokens, and
  // fail a tool call on ~12% so the per-topic metric columns (errors / avg
  // latency / avg cost) show non-uniform values.
  const hourOffset = index % 20;
  const startedMs = stampBase - hourOffset * 3_600_000 - index;
  const durationMs = 40 + (index % 6) * 300; // 40ms … ~1.5s
  const isError = index % 8 === 0; // ~12%
  const startedAt = new Date(startedMs).toISOString();
  const endedAt = new Date(startedMs + durationMs).toISOString();
  const inputTokens = 600 + (index % 5) * 350; // 600 … 2000
  const outputTokens = 150 + (index % 4) * 200; // 150 … 750

  return {
    schemaVersion: 1,
    id: `topics-e2e-${randomBytes(8).toString('hex')}`,
    agent: { type: 'claude-code', entrypoint: 'cli', origin: 'interactive' },
    env: { os: 'darwin' },
    startedAt,
    endedAt,
    models: ['gpt-4'],
    captureTier: 'full',
    warnings: [],
    events: [],
    totals: {
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      wallClockMs: durationMs,
    },
    turns: [
      {
        index: 0,
        role: 'user',
        source: 'human',
        ts: startedAt,
        text: text.input,
        toolCalls: [],
      },
      {
        index: 1,
        role: 'assistant',
        ts: endedAt,
        model: 'gpt-4',
        durationMs,
        text: text.output,
        usage: { in: inputTokens, out: outputTokens, cacheRead: 0, cacheCreate: 0 },
        toolCalls: isError
          ? [
              {
                name: 'Bash',
                status: 'error',
                isEdit: false,
                startTs: endedAt,
                durationMs: 5,
                errorSignature: 'command failed with exit code 1',
              },
            ]
          : [],
      },
    ],
  };
}

/**
 * Bulk-ingest canonical AgentSessions through the real gateway sync route.
 * Timestamps are BACKDATED so the enrichment scan's completion-debounce
 * (`max(Timestamp) <= now - N minutes`) sees the sessions as quiet
 * immediately — honest with respect to the production logic.
 */
async function bulkIngestSessions(
  appId: string,
  apiKey: string,
  texts: { input: string; output: string }[],
  backdateMs: number,
): Promise<void> {
  const stampBase = Date.now() - backdateMs;
  const sessions = texts.map((text, index) => buildSession(text, index, stampBase));

  for (let offset = 0; offset < sessions.length; offset += MAX_SESSIONS_PER_SYNC) {
    const batch = sessions.slice(offset, offset + MAX_SESSIONS_PER_SYNC);
    const response = await fetch(`${GATEWAY_URL}/v1/agents/sync`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-Outerlayer-App-Id': appId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ schemaVersion: 1, sessions: batch }),
    });
    if (!response.ok) {
      throw new Error(
        `Bulk ingest failed: ${response.status} ${await response.text().catch(() => '')}`,
      );
    }
    // A 200 with a non-empty `rejected` is a silently-partial fixture — the
    // spec would then measure enrichment over fewer sessions than it thinks.
    const body = (await response.json()) as {
      data?: { accepted?: string[]; rejected?: { reason: string }[] };
    };
    const rejected = body.data?.rejected ?? [];
    if (rejected.length > 0) {
      throw new Error(
        `Bulk ingest rejected ${rejected.length}/${batch.length} sessions: ${rejected[0]?.reason}`,
      );
    }
    if ((body.data?.accepted?.length ?? 0) !== batch.length) {
      throw new Error(
        `Bulk ingest accepted ${body.data?.accepted?.length ?? 0} of ${batch.length} sessions`,
      );
    }
  }
}

/** Fire one enrichment cron tick via wrangler's --test-scheduled endpoint. */
async function fireEnrichmentTick(): Promise<void> {
  const response = await fetch(
    `${GATEWAY_URL}/__scheduled?cron=${encodeURIComponent('* * * * *')}`,
  );
  if (!response.ok) {
    throw new Error(
      `__scheduled returned ${response.status} — is the gateway running with --test-scheduled?`,
    );
  }
}

/** The Topics page's user-visible signal that enrichment has progressed. */
async function readCollectedCount(page: Page): Promise<number> {
  const empty = page.getByTestId('topics-empty-state');
  if (!(await empty.isVisible().catch(() => false))) return Number.NaN;
  const text = (await empty.textContent()) ?? '';
  const match = text.match(/(\d+)\s+of\s+\d+\s+summaries/);
  return match ? Number(match[1]) : 0;
}

test.describe('Trace Topics (Insights) — enrich, generate, regenerate @local-stack', () => {
  test.describe.configure({ timeout: 600_000 });

  let user: TestUser;
  let org: TestOrganization;
  let app: TestApp;

  test.beforeAll(async () => {
    expect(await waitForSupabase()).toBe(true);
    const result = await createTestOwnerWithOrg('topics');
    user = result.user;
    org = result.org;
    app = await createTestApp(org.tenantId, 'topics');
    // SyncAgentSessions requires an API key carrying `trace.write`.
    const apiKey = await mintApiKey(user, app.id, ['trace.write']);

    const texts = [
      ...PATTERNS.flatMap((pattern) =>
        Array.from({ length: pattern.count }, (_v, i) => ({
          input: pattern.input(i),
          output: pattern.output(i),
        })),
      ),
      ...OUTLIERS.map((input) => ({ input, output: 'Handled the request.' })),
    ];
    // Backdate 10 minutes — past any sane TOPICS_DEBOUNCE_MINUTES.
    await bulkIngestSessions(app.id, apiKey, texts, 10 * 60 * 1000);
  });

  test.afterAll(async () => {
    if (app) await cleanupTestApp(app.id);
    await cleanupTestOwnerWithOrg(user?.id ?? null, org?.tenantId ?? null);
  });

  test('traces flow through enrichment into named topics with stable IDs on regenerate', async ({
    page,
  }) => {
    await loginTestUser(page, user);

    const topicsUrl = `/orgs/${org.organizationName}/apps/${app.name}/env/dev/insights`;
    await page.goto(topicsUrl, { timeout: FIRST_COMPILE_GOTO_TIMEOUT });
    await expect(page.getByTestId('topics-page')).toBeVisible({
      timeout: FIRST_COMPILE_GOTO_TIMEOUT,
    });

    // ---- Enrichment: fire cron ticks until the UI reports the floor met.
    // Each tick enriches up to TOPICS_BATCH_LIMIT traces; residue from other
    // local runs may consume ticks, hence the loop. 120 seeded traces.
    const target = 100;
    let collected = 0;
    for (let tick = 0; tick < 12 && collected < target; tick++) {
      await fireEnrichmentTick();
      // Enrichment runs inside the tick synchronously (waitUntil awaited by
      // wrangler's scheduled test harness); reload to observe progress.
      // Dev-server reloads recompile + refetch — give them real headroom,
      // and wait for either the empty state or the table before counting.
      await page.reload({ timeout: FIRST_COMPILE_GOTO_TIMEOUT });
      await expect(page.getByTestId('topics-page')).toBeVisible({
        timeout: 60_000,
      });
      await expect(
        page
          .getByTestId('topics-empty-state')
          .or(page.getByTestId('topics-table')),
      ).toBeVisible({ timeout: 60_000 });
      collected = await readCollectedCount(page);
      if (Number.isNaN(collected)) break; // table already rendered (rerun)
    }
    if (!Number.isNaN(collected)) {
      expect(collected).toBeGreaterThanOrEqual(target);
    }

    // ---- Generate: the button enables once the floor is met.
    const generateButton = page.getByTestId('generate-topics');
    await expect(generateButton).toBeEnabled({ timeout: 30_000 });
    await generateButton.click();

    // Generation: clustering (seconds at this scale) + writes + revalidate.
    const table = page.getByTestId('topics-table');
    await expect(table).toBeVisible({ timeout: 120_000 });

    // ---- Topic quality: the three seeded patterns emerge as named topics.
    const topicRows = page.locator('[data-testid^="topic-row-v"]');
    const topicCount = await topicRows.count();
    expect(topicCount).toBeGreaterThanOrEqual(2);
    expect(topicCount).toBeLessThanOrEqual(8);

    const names = await topicRows
      .locator('td:first-child')
      .allTextContents();
    for (const name of names) {
      expect(name.trim().length).toBeGreaterThan(0);
    }
    // The refund pattern's distinguishing vocabulary must surface in some
    // topic name (mock naming = keyword fallback over member summaries).
    expect(
      names.some((n) => /refund|shipment|delayed/i.test(n)),
      `expected a refund-flavored topic name in: ${names.join(' | ')}`,
    ).toBe(true);

    // ---- Screenshot the full Topics view (topics-over-time trend, per-topic
    // metric columns, inline descriptions, first-class No-match row) for the
    // PR/demo. Not an assertion — the checks above already gate correctness.
    if (process.env.TOPICS_SCREENSHOT) {
      // Best-effort: wait for the trend chart but never let a slow ApexCharts
      // mount fail the capture — the table/metrics/descriptions are the point.
      await page
        .getByTestId('topics-trend')
        .waitFor({ state: 'visible', timeout: 30_000 })
        .catch(() => {});
      await page.waitForTimeout(1500); // let ApexCharts finish its mount animation
      await page.screenshot({ path: process.env.TOPICS_SCREENSHOT, fullPage: true });
    }

    // ---- Drill-down is a pinned NO-OP: there is no filtered Traces view to
    // open. Clicking a row must stay on Insights (no navigation) until the
    // agent-sessions list grows a topic filter to drill into.
    const firstRow = topicRows.first();
    const firstRowTestId = await firstRow.getAttribute('data-testid');
    const firstTopicId = firstRowTestId!.replace('topic-row-', '');
    const firstTopicCount = Number(
      (await firstRow.locator('td').nth(1).textContent())?.trim() ?? '0',
    );
    expect(firstTopicCount).toBeGreaterThan(0);

    await firstRow.click();
    await page.waitForTimeout(1_000); // give any (buggy) navigation time to fire
    expect(
      new URL(page.url()).pathname,
      'topic-row click must be a no-op — the traces drill-down target is retired',
    ).toContain('/insights');

    // ---- Reconciliation: regenerate → the same TopicId survives (D5).
    await expect(page.getByTestId('topics-table')).toBeVisible({
      timeout: FIRST_COMPILE_GOTO_TIMEOUT,
    });
    await expect(page.getByTestId('generate-topics')).toBeEnabled({
      timeout: 30_000,
    });
    await page.getByTestId('generate-topics').click();
    // Regeneration replaces the map; wait for the map version caption to move.
    await expect(page.getByText(/Map v2 ·/)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId(`topic-row-${firstTopicId}`)).toBeVisible();
  });
});
