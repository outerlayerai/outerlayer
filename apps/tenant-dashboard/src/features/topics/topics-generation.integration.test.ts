/**
 * REAL-ClickHouse + REAL-clustering-container integration for Stage 4 topic
 * generation. Runs the actual TopicsService against a local ClickHouse and the
 * live topics-clustering service (UMAP+HDBSCAN) to prove, end to end:
 *   - a steering topic map GENERATES from real per-correction summaries;
 *   - the cold-start counter reports exactly what generation samples: NONE
 *     markers, subagent transcripts, agent-origin runs, wrong-dimension
 *     embeddings, and stale-extractor-version summaries are all excluded from
 *     BOTH numbers (numeric parity — the counter must never promise a floor
 *     generation then refuses);
 *   - TOPICS_MIN_SUMMARIES lets generation proceed below the default floor;
 *   - the generated map RENDERS through listTopics with named topics.
 *
 * Requires local ClickHouse (>= migration 38) and the clustering container:
 *   cd apps/topics-clustering && docker compose up -d   # :8080
 * Gated behind RUN_CH_INTEGRATION:
 *   RUN_CH_INTEGRATION=1 npx vitest run --config vitest.integration.config.ts \
 *     src/lib/analytics/topics/topics-generation.integration.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createClient } from '@clickhouse/client';
import {
  BATCHED_EXTRACTOR_VERSION,
  MockTopicsModelClient,
  STEERING_EXTRACTOR_VERSION,
} from '@repo/trace-topics';
import { buildTopicsService } from './service';

const CH_URL = process.env.CH_URL ?? 'http://localhost:8123';
const CH_PASSWORD = process.env.CH_PASSWORD ?? 'dev_password';
const RUN = process.env.RUN_CH_INTEGRATION === '1';

const RUN_ID = Math.random().toString(36).slice(2, 10);
const TENANT = `it-tenant-gen-${RUN_ID}`;
const APP = 'it-app-gen';
const SCOPE = { tenantId: TENANT, appId: APP, environment: 'dev', environmentIsDefault: true };

const admin = createClient({ url: CH_URL, password: CH_PASSWORD, database: 'default' });
const mock = new MockTopicsModelClient();

const dt = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

/** Three distinct convention groups — the mock's feature-hash embeddings
 * preserve vocabulary similarity, so these cluster for real. */
const GROUPS = [
  { n: 14, text: (i: number) => `Use the repo api helper instead of the legacy client for dashboard data calls variant ${i}` },
  { n: 14, text: (i: number) => `Run the full integration test suite locally and wait for green before pushing variant ${i}` },
  { n: 14, text: (i: number) => `Name every clickhouse migration file with the numeric prefix convention we use variant ${i}` },
];

async function seed() {
  const now = Date.now();
  const facetRows: Record<string, unknown>[] = [];
  const summaryRows: Record<string, unknown>[] = [];
  let idx = 0;

  for (const g of GROUPS) {
    for (let i = 0; i < g.n; i++, idx++) {
      const traceId = `gen${RUN_ID}${String(idx).padStart(4, '0')}`.slice(0, 32).padEnd(32, '0');
      const summary = g.text(i);
      const { embedding, modelVersion } = await mock.embed({ input: summary, model: 'mock', dimension: 1024 });
      // Embedded steering summary at the current extractor version, kind
      // 'rule' on the Label as the extractor writes it — clusterable.
      facetRows.push({
        TenantId: TENANT, AppId: APP, Environment: '', TraceId: traceId, Facet: 'steering',
        ItemIndex: 0, ExtractorVersion: STEERING_EXTRACTOR_VERSION, Summary: summary, Label: 'rule',
        Embedding: embedding, EmbeddingModel: modelVersion, TopicId: '', TopicDistance: 0,
        MapVersion: 0, Status: 'ok', Error: '', CreatedAt: dt(now - idx * 1000),
      });
      // A task row per trace so the app looks real (not asserted here).
      facetRows.push({
        TenantId: TENANT, AppId: APP, Environment: '', TraceId: traceId, Facet: 'task',
        ItemIndex: 0, ExtractorVersion: BATCHED_EXTRACTOR_VERSION, Summary: `task ${idx}`, Label: '',
        Embedding: [], EmbeddingModel: '', TopicId: '', TopicDistance: 0,
        MapVersion: 0, Status: 'ok', Error: '', CreatedAt: dt(now - idx * 1000),
      });
      // Root-session rollup row (interactive, top-level) so the attribution
      // join resolves and the Origin='agent' exclusion passes.
      summaryRows.push({
        TenantId: TENANT, AppId: APP, TraceId: traceId, SessionId: traceId,
        ParentSessionId: '', Origin: 'interactive', StartedAt: dt(now - idx * 1000).slice(0, 23),
        UserTurnCount: 3,
      });
    }
  }

  // 8 checked-but-clean NONE markers: Status='ok', Label='NONE', no embedding.
  // These must NOT count toward the cold-start floor.
  for (let m = 0; m < 8; m++, idx++) {
    const traceId = `non${RUN_ID}${String(m).padStart(4, '0')}`.slice(0, 32).padEnd(32, '0');
    facetRows.push({
      TenantId: TENANT, AppId: APP, Environment: '', TraceId: traceId, Facet: 'steering',
      ItemIndex: 0, ExtractorVersion: STEERING_EXTRACTOR_VERSION, Summary: '', Label: 'NONE',
      Embedding: [], EmbeddingModel: '', TopicId: '', TopicDistance: 0,
      MapVersion: 0, Status: 'ok', Error: '', CreatedAt: dt(now - idx * 1000),
    });
    summaryRows.push({
      TenantId: TENANT, AppId: APP, TraceId: traceId, SessionId: traceId,
      ParentSessionId: '', Origin: 'interactive', StartedAt: dt(now - idx * 1000).slice(0, 23),
      UserTurnCount: 1,
    });
  }

  // Embedded, ok-status steering rows generation still refuses to sample —
  // the populations behind the "127 collected / 12 sampled" contradiction.
  // The counter must exclude every one of them.
  const excluded: { key: string; n: number; rollup?: Record<string, unknown>; dimension?: number; version?: number }[] = [
    // Subagent transcripts: the rollup row carries a parent session.
    { key: 'sub', n: 6, rollup: { ParentSessionId: `parent-${RUN_ID}`, Origin: 'agent' } },
    // Top-level programmatic runs: root sessions with Origin='agent'.
    { key: 'agn', n: 5, rollup: { ParentSessionId: '', Origin: 'agent' } },
    // A previous provider's embeddings: wrong dimension for the active model.
    { key: 'dim', n: 4, dimension: 512 },
    // Summaries written by a RETIRED extractor prompt, awaiting re-extraction:
    // embedded and ok, but their text encodes the old prompt's semantics.
    { key: 'ver', n: 5, version: STEERING_EXTRACTOR_VERSION - 1 },
  ];
  for (const pop of excluded) {
    for (let i = 0; i < pop.n; i++, idx++) {
      const traceId = `${pop.key}${RUN_ID}${String(i).padStart(4, '0')}`.slice(0, 32).padEnd(32, '0');
      const summary = `Excluded-population steering correction ${pop.key} variant ${i}`;
      const { embedding, modelVersion } = await mock.embed({
        input: summary, model: 'mock', dimension: pop.dimension ?? 1024,
      });
      facetRows.push({
        TenantId: TENANT, AppId: APP, Environment: '', TraceId: traceId, Facet: 'steering',
        ItemIndex: 0, ExtractorVersion: pop.version ?? STEERING_EXTRACTOR_VERSION, Summary: summary, Label: '',
        Embedding: embedding, EmbeddingModel: modelVersion, TopicId: '', TopicDistance: 0,
        MapVersion: 0, Status: 'ok', Error: '', CreatedAt: dt(now - idx * 1000),
      });
      summaryRows.push({
        TenantId: TENANT, AppId: APP, TraceId: traceId, SessionId: traceId,
        ParentSessionId: '', Origin: 'interactive',
        ...(pop.rollup ?? {}),
        StartedAt: dt(now - idx * 1000).slice(0, 23), UserTurnCount: 1,
      });
    }
  }

  await admin.insert({ table: 'trace_facets', values: facetRows, format: 'JSONEachRow' });
  await admin.insert({ table: 'agent_session_summary', values: summaryRows, format: 'JSONEachRow' });
}

describe.skipIf(!RUN)('topics generation — real ClickHouse + clustering container', () => {
  beforeAll(async () => {
    // Fail loudly if the clustering container isn't reachable.
    const health = await fetch('http://localhost:8080/health').then((r) => r.ok).catch(() => false);
    if (!health) throw new Error('topics-clustering not reachable on :8080 — docker compose up -d in apps/topics-clustering');
    process.env.TOPICS_CLUSTERING_URL = 'http://localhost:8080';
    process.env.TOPICS_MOCK_MODEL = 'true';
    process.env.TOPICS_MIN_SUMMARIES = '15'; // surfaced through `required` below
    delete process.env.TOPICS_CLUSTERING_SECRET;
    await seed();
  });

  it('the cold-start counter reports exactly the samplable population — markers, subagent, agent-origin, wrong-dimension, and stale-version rows all excluded', async () => {
    const svc = buildTopicsService(admin as never);
    const list = await svc.listTopics(SCOPE, 'steering');
    // Seeded: 42 samplable + 8 markers + 6 subagent + 5 agent-origin +
    // 4 wrong-dimension + 5 stale-extractor-version. Only the 42 may count —
    // each excluded population that leaks in promises a floor generation then
    // refuses.
    expect(list.samplableCount).toBe(42);
    expect(list.required).toBe(15); // TOPICS_MIN_SUMMARIES override surfaced
    expect(list.mapVersion).toBe(0);
  });

  it('generates a steering map below the default floor (override) and it renders through listTopics', async () => {
    const svc = buildTopicsService(admin as never);

    const before = await svc.listTopics(SCOPE, 'steering');
    const outcome = await svc.generateTopics(SCOPE, 'steering');
    // 42 embedded summaries clears the overridden floor of 15.
    expect(outcome.status).toBe('generated');
    if (outcome.status !== 'generated') throw new Error('not generated');
    expect(outcome.sampleSize).toBe(42);
    // Numeric parity: what the page promised is what generation sampled.
    expect(outcome.sampleSize).toBe(before.samplableCount);
    expect(outcome.topicCount).toBeGreaterThanOrEqual(2); // 3 vocab groups → real clusters

    const list = await svc.listTopics(SCOPE, 'steering');
    expect(list.mapVersion).toBe(1);
    expect(list.topics.length).toBeGreaterThanOrEqual(2);
    // Every rendered topic has a name and a session count.
    for (const t of list.topics) {
      expect(t.name.trim().length).toBeGreaterThan(0);
      expect(t.sessionCount).toBeGreaterThan(0);
    }
    // The three seeded conventions surface in the topic vocabulary.
    const allNames = list.topics.map((t) => t.name.toLowerCase()).join(' ');
    const hits = ['api', 'legacy', 'test', 'migration', 'prefix', 'push'].filter((w) => allNames.includes(w));
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });
});
