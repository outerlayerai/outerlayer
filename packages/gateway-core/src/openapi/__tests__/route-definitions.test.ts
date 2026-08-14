import { describe, it, expect } from 'vitest';
import { SyncAgentSessions, GetAgentBlob, GetAgentBlobByToken } from '../routes/agents';
import { ListSpans, SearchSpans } from '../routes/spans';
import {
  CreateScore,
  CreateScoresBatch,
  ListScores,
  SearchScores,
  GetScore,
  GetScoreAggregations,
  GetScoreNames,
  DeleteScore,
} from '../routes/scores';
import {
  SpansSearchBodySchema,
  SpansListResponseSchema,
  ScoresSearchBodySchema,
  ScoresListResponseSchema,
} from '@repo/api-schemas';
import { HealthCheck, IngestionHealth, FilesHealth } from '../routes/health';
import { ListApiKeys, CreateApiKey, RevokeApiKey } from '../routes/api-keys';
import { GetTopics } from '../routes/topics';
import { GetModelStats, GetFleetOverview, GetMetricsCompare } from '../routes/metrics';
import { ListSessions, GetSessionDetail } from '../routes/sessions';
import { ListContextChanges } from '../routes/context';

// ---------------------------------------------------------------------------
// Route definition correctness tests
//
// These verify that each OpenAPI route class is properly instantiable and has
// the correct schema metadata (tags, summary, responses). This catches typos,
// missing schema fields, and ensures the OpenAPI spec will be generated correctly.
// ---------------------------------------------------------------------------

/**
 * Minimal RouteOptions to instantiate chanfana OpenAPIRoute subclasses in tests.
 * Only `router`, `raiseUnknownParameters`, `route`, and `urlParams` are required.
 */
const MOCK_ROUTE_OPTIONS = {
  router: {},
  raiseUnknownParameters: false,
  route: '/test',
  urlParams: [],
};


type RouteClass = new (params: any) => { schema: Record<string, any>; handle?: (...args: any[]) => unknown };

function createRoute(cls: RouteClass) {
  return new cls(MOCK_ROUTE_OPTIONS);
}

/**
 * Assert a route declares a given status response with a non-empty
 * `description`. OpenAPI requires every response object to carry a
 * description; a bare `toBeDefined()` would pass for a malformed entry
 * that omits it. This pins the response is real without coupling to the
 * exact prose (which would make doc-copy edits churn the test).
 */
function expectResponse(cls: RouteClass, status: number) {
  const response = createRoute(cls).schema.responses[status] as
    | { description?: unknown }
    | undefined;
  expect(typeof response?.description).toBe('string');
  expect((response!.description as string).length).toBeGreaterThan(0);
}

interface RouteEntry {
  name: string;
  cls: RouteClass;
  tag: string;
  hasRequest?: boolean;
}

const allRoutes: RouteEntry[] = [
  { name: 'SyncAgentSessions', cls: SyncAgentSessions, tag: 'Agents', hasRequest: true },
  { name: 'GetAgentBlob', cls: GetAgentBlob, tag: 'Agents', hasRequest: true },
  { name: 'GetAgentBlobByToken', cls: GetAgentBlobByToken, tag: 'Agents', hasRequest: true },
  { name: 'ListSpans', cls: ListSpans, tag: 'Spans', hasRequest: true },
  { name: 'SearchSpans', cls: SearchSpans, tag: 'Spans', hasRequest: true },
  { name: 'CreateScore', cls: CreateScore, tag: 'Scoring', hasRequest: true },
  { name: 'CreateScoresBatch', cls: CreateScoresBatch, tag: 'Scoring', hasRequest: true },
  { name: 'ListScores', cls: ListScores, tag: 'Scoring', hasRequest: true },
  { name: 'SearchScores', cls: SearchScores, tag: 'Scoring', hasRequest: true },
  { name: 'GetScore', cls: GetScore, tag: 'Scoring', hasRequest: true },
  { name: 'GetScoreAggregations', cls: GetScoreAggregations, tag: 'Scoring', hasRequest: true },
  { name: 'GetScoreNames', cls: GetScoreNames, tag: 'Scoring' },
  { name: 'DeleteScore', cls: DeleteScore, tag: 'Scoring', hasRequest: true },
  { name: 'HealthCheck', cls: HealthCheck, tag: 'Health' },
  { name: 'IngestionHealth', cls: IngestionHealth, tag: 'Health' },
  { name: 'FilesHealth', cls: FilesHealth, tag: 'Health' },
  { name: 'ListApiKeys', cls: ListApiKeys, tag: 'API Keys', hasRequest: true },
  { name: 'CreateApiKey', cls: CreateApiKey, tag: 'API Keys', hasRequest: true },
  { name: 'RevokeApiKey', cls: RevokeApiKey, tag: 'API Keys', hasRequest: true },
  { name: 'GetTopics', cls: GetTopics, tag: 'Topics', hasRequest: true },
  { name: 'GetModelStats', cls: GetModelStats, tag: 'Metrics', hasRequest: true },
  { name: 'GetFleetOverview', cls: GetFleetOverview, tag: 'Metrics', hasRequest: true },
  { name: 'GetMetricsCompare', cls: GetMetricsCompare, tag: 'Metrics', hasRequest: true },
  { name: 'ListSessions', cls: ListSessions, tag: 'Sessions', hasRequest: true },
  { name: 'GetSessionDetail', cls: GetSessionDetail, tag: 'Sessions', hasRequest: true },
  { name: 'ListContextChanges', cls: ListContextChanges, tag: 'Context', hasRequest: true },
];

describe('OpenAPI Route Definitions', () => {
  it.each(allRoutes)(
    '$name should have schema with correct tag "$tag"',
    ({ cls, tag }) => {
      expect(createRoute(cls).schema.tags).toContain(tag);
    },
  );

  it.each(allRoutes)(
    '$name should have a summary defined',
    ({ cls }) => {
      const { summary } = createRoute(cls).schema;
      expect(typeof summary).toBe('string');
      expect((summary as string).length).toBeGreaterThan(0);
    },
  );

  it.each(allRoutes)(
    '$name should have responses defined',
    ({ cls }) => {
      expect(typeof createRoute(cls).schema.responses).toBe('object');
    },
  );

  it.each(allRoutes.filter((r) => r.hasRequest))(
    '$name should have a request schema defined',
    ({ cls }) => {
      expect(typeof createRoute(cls).schema.request).toBe('object');
    },
  );

  it.each(allRoutes)(
    '$name should have a handle method',
    ({ cls }) => {
      expect(typeof createRoute(cls).handle).toBe('function');
    },
  );
});

// ---------------------------------------------------------------------------
// Tag coverage: ensure all expected tags are represented
// ---------------------------------------------------------------------------

describe('OpenAPI Tag Coverage', () => {
  const expectedTags = ['Agents', 'Spans', 'Scoring', 'Health', 'API Keys', 'Topics', 'Metrics', 'Sessions', 'Context'];

  it.each(expectedTags)('should have at least one route with tag "%s"', (tag) => {
    const routesWithTag = allRoutes.filter((r) => r.tag === tag);
    expect(routesWithTag.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Specific route schema details
// ---------------------------------------------------------------------------

describe('Search route schemas', () => {
  // Deep pins: the generic checks above prove tags/summary/responses exist,
  // but the body/response schema REFERENCES are the wire contract — an empty
  // or wrong schema object here would still generate a spec, just a wrong
  // one. Identity (toBe) pins each route to the canonical schema export.
  const searchRoutes = [
    {
      name: 'SearchSpans',
      cls: SearchSpans as RouteClass,
      operationId: 'search-spans',
      bodySchema: SpansSearchBodySchema,
      okSchema: SpansListResponseSchema,
    },
    {
      name: 'SearchScores',
      cls: SearchScores as RouteClass,
      operationId: 'search-scores',
      bodySchema: ScoresSearchBodySchema,
      okSchema: ScoresListResponseSchema,
    },
  ];

  it.each(searchRoutes)(
    '$name pins operationId, body schema, and response schemas',
    ({ cls, operationId, bodySchema, okSchema }) => {
      const schema = createRoute(cls).schema;
      expect(schema.operationId).toBe(operationId);
      expect(schema.request.body.content['application/json'].schema).toBe(bodySchema);
      expect(schema.responses[200].content['application/json'].schema).toBe(okSchema);
      expectResponse(cls, 200);
      expectResponse(cls, 400);
      expectResponse(cls, 401);
      expectResponse(cls, 429);
    },
  );
});

describe('Agents route schemas', () => {
  it('SyncAgentSessions pins operationId and declares the batch responses', () => {
    const schema = createRoute(SyncAgentSessions as RouteClass).schema;
    expect(schema.operationId).toBe('sync-agent-sessions');
    expectResponse(SyncAgentSessions as RouteClass, 200);
    expectResponse(SyncAgentSessions as RouteClass, 400);
    expectResponse(SyncAgentSessions as RouteClass, 401);
    expectResponse(SyncAgentSessions as RouteClass, 429);
  });

  it('GetAgentBlob pins operationId and the miss response', () => {
    const schema = createRoute(GetAgentBlob as RouteClass).schema;
    expect(schema.operationId).toBe('get-agent-blob');
    expectResponse(GetAgentBlob as RouteClass, 200);
    expectResponse(GetAgentBlob as RouteClass, 404);
  });
});

describe('Health route schemas', () => {
  it('should define 200 response for HealthCheck', () => {
    const schema = createRoute(HealthCheck).schema;
    expect(schema.responses[200].description).toBe('Service is healthy.');
  });

  it('should define 200 and 503 responses for IngestionHealth', () => {
    expectResponse(IngestionHealth, 200);
    expectResponse(IngestionHealth, 503);
  });
});

describe('Span route schemas', () => {
  it('should define 200 response for ListSpans', () => {
    expectResponse(ListSpans, 200);
  });
});

describe('Score route schemas', () => {
  it('should define 201 response for CreateScore', () => {
    expectResponse(CreateScore, 201);
  });

  it('should define 200 response for ListScores', () => {
    expectResponse(ListScores, 200);
  });

  it('should define 200 response for GetScore', () => {
    expectResponse(GetScore, 200);
  });

  it('should define 404 response for GetScore', () => {
    expectResponse(GetScore, 404);
  });

  it('should define 200 response for GetScoreAggregations', () => {
    expectResponse(GetScoreAggregations, 200);
  });

  it('should define 200 response for GetScoreNames', () => {
    expectResponse(GetScoreNames, 200);
  });

  it('should define 204 response for DeleteScore', () => {
    expectResponse(DeleteScore, 204);
  });
});

describe('Topics and Metrics route schemas', () => {
  it('should define 200 response for GetTopics', () => {
    expectResponse(GetTopics, 200);
  });

  it('should define 200 response for GetModelStats', () => {
    expectResponse(GetModelStats, 200);
  });

  it('should define 200 response for GetFleetOverview', () => {
    expectResponse(GetFleetOverview, 200);
  });

  it('should define 200 response for GetMetricsCompare', () => {
    expectResponse(GetMetricsCompare, 200);
  });
});

describe('Context route schemas', () => {
  it('should define 200 response for ListContextChanges', () => {
    expectResponse(ListContextChanges, 200);
  });
});

describe('Sessions route schemas', () => {
  it('should define 200 response for ListSessions', () => {
    expectResponse(ListSessions, 200);
  });

  it('should define 200 response for GetSessionDetail', () => {
    expectResponse(GetSessionDetail, 200);
  });

  it('should define 404 response for GetSessionDetail', () => {
    expectResponse(GetSessionDetail, 404);
  });
});

// ---------------------------------------------------------------------------
// Route count sanity check
// ---------------------------------------------------------------------------

describe('Route inventory', () => {
  it('should have exactly 26 routes defined', () => {
    expect(allRoutes).toHaveLength(26);
  });

  it('should have 3 Agents routes', () => {
    expect(allRoutes.filter((r) => r.tag === 'Agents')).toHaveLength(3);
  });

  it('should have 2 Spans routes', () => {
    expect(allRoutes.filter((r) => r.tag === 'Spans')).toHaveLength(2);
  });

  it('should have 8 Scoring routes', () => {
    expect(allRoutes.filter((r) => r.tag === 'Scoring')).toHaveLength(8);
  });

  it('should have 3 Health routes', () => {
    expect(allRoutes.filter((r) => r.tag === 'Health')).toHaveLength(3);
  });

  it('should have 1 Topics route', () => {
    expect(allRoutes.filter((r) => r.tag === 'Topics')).toHaveLength(1);
  });

  it('should have 3 Metrics routes', () => {
    expect(allRoutes.filter((r) => r.tag === 'Metrics')).toHaveLength(3);
  });

  it('should have 2 Sessions routes', () => {
    expect(allRoutes.filter((r) => r.tag === 'Sessions')).toHaveLength(2);
  });

  it('should have 1 Context route', () => {
    expect(allRoutes.filter((r) => r.tag === 'Context')).toHaveLength(1);
  });
});
