/**
 * Mock Data Pool
 *
 * Generates a deterministic pool of ~60 traces (~180 spans) used by
 * MockAnalyticsService to provide consistent data across all 14 methods.
 *
 * Uses a seeded PRNG so data is identical across cold starts.
 */

// ============================================================================
// Seeded PRNG (Lehmer / Park-Miller)
// ============================================================================

function createRng(seed: number) {
  let s = Math.abs(seed) || 1;
  return {
    next(): number {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    },
    nextInt(min: number, max: number): number {
      return Math.floor(this.next() * (max - min + 1)) + min;
    },
    pick<T>(arr: readonly T[]): T {
      return arr[this.nextInt(0, arr.length - 1)] as T;
    },
  };
}

// ============================================================================
// Internal Types
// ============================================================================

export interface MockSpan {
  id: string;
  traceId: string;
  parentId: string | null;
  name: string;
  type: 'SPAN' | 'GENERATION';
  status: string;
  statusMessage: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  cost: number;
  durationMs: number;
  timestamp: Date;
  input: string;
  output: string;
  toolCalls?: string | null;
  props: string | null;
  userId: string | null;
  finishReason: string | null;
  reasoningTokens: number;
  spanKind: string;
  serviceName: string;
  metadata: Record<string, string>;
}

export interface MockTrace {
  id: string;
  name: string;
  sessionId: string | null;
  userId: string | null;
  rootSpan: MockSpan;
  generationSpans: MockSpan[];
  allSpans: MockSpan[];
  start: Date;
  end: Date;
  latencyMs: number;
  totalCost: number;
  totalTokens: number;
  status: string;
}

export interface MockScore {
  id: string;
  resourceId: string;
  name: string;
  score: number;
  label: string;
  reason: string;
  source: 'experiment' | 'annotation';
  createdAt: Date;
}




interface MockAlert {
  id: string;
  app_id: string;
  tenant_id: string;
  name: string;
  metric: 'cost' | 'latency' | 'error_rate' | 'evaluation_score';
  threshold: number;
  time_window: number;
  status: 'triggered' | 'resolved';
  use_slack: boolean;
  use_webhook: boolean;
  evaluation_name: string | null;
  evaluation_aggregation: 'avg' | 'individual' | null;
  evaluation_threshold_direction: 'above' | 'below' | null;
  commit_sha: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

interface MockAlertHistory {
  id: string;
  alert_id: string;
  app_id: string;
  tenant_id: string;
  alert_name: string;
  alert_metric: string;
  triggered_value: string;
  status: 'triggered' | 'resolved';
  evaluation_name: string | null;
  evaluation_aggregation: 'avg' | 'individual' | null;
  evaluation_threshold_direction: 'above' | 'below' | null;
  commit_sha: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

interface MockDataPool {
  traces: MockTrace[];
  scores: MockScore[];
  userIds: string[];
  sessionIds: string[];
  alerts: MockAlert[];
  alertHistory: MockAlertHistory[];
}

// ============================================================================
// Constants
// ============================================================================

const SEED = 42;

const MODELS = [
  { name: 'gpt-4o', weight: 0.30, costPer1kIn: 0.005, costPer1kOut: 0.015, avgLatency: 1800, avgInput: 800, avgOutput: 400 },
  { name: 'gpt-4o-mini', weight: 0.25, costPer1kIn: 0.00015, costPer1kOut: 0.0006, avgLatency: 800, avgInput: 600, avgOutput: 300 },
  { name: 'claude-sonnet-4-20250514', weight: 0.20, costPer1kIn: 0.003, costPer1kOut: 0.015, avgLatency: 2200, avgInput: 900, avgOutput: 500 },
  { name: 'claude-haiku-4-20250414', weight: 0.15, costPer1kIn: 0.00025, costPer1kOut: 0.00125, avgLatency: 600, avgInput: 500, avgOutput: 200 },
  { name: 'gpt-3.5-turbo', weight: 0.10, costPer1kIn: 0.0005, costPer1kOut: 0.0015, avgLatency: 500, avgInput: 400, avgOutput: 250 },
] as const;

const USER_IDS = [
  'user-alice', 'user-bob', 'user-charlie', 'user-diana', 'user-eve',
  'user-frank', 'user-grace', 'user-hank', 'user-iris', 'user-jack',
] as const;

const SESSION_IDS = [
  'session-alpha', 'session-beta', 'session-gamma', 'session-delta',
  'session-epsilon', 'session-zeta', 'session-eta',
] as const;

const TRACE_NAMES = [
  'chat-completion', 'document-summary', 'code-generation',
  'entity-extraction', 'sentiment-analysis', 'translation',
  'question-answering', 'text-classification', 'data-extraction',
  'content-moderation',
] as const;

const SCORE_NAMES = ['relevance', 'accuracy', 'helpfulness'] as const;

const SPAN_NAMES = [
  'llm-call', 'embedding-lookup', 'retrieval-step',
  'format-response', 'validate-input', 'post-process',
] as const;

const ENVIRONMENTS = ['production', 'staging', 'development'] as const;
const CUSTOMER_TIERS = ['free', 'pro', 'enterprise'] as const;
const FEATURES = ['chat', 'search', 'summarize', 'translate', 'code-assist'] as const;

const SAMPLE_INPUTS = [
  'Summarize the following document about machine learning trends...',
  'Extract all named entities from this customer feedback...',
  'Classify the intent of the following user message...',
  'Generate a response to the customer inquiry about billing...',
  'Translate the following text from English to Spanish...',
  'Review the following code for potential issues...',
] as const;

const SAMPLE_OUTPUTS = [
  'The document discusses several key trends in machine learning...',
  'Entities found: [Organization: Acme Corp], [Person: John Smith]...',
  'Intent: billing_inquiry (confidence: 0.94)',
  'Thank you for reaching out about your billing question...',
  'El documento analiza varias tendencias clave...',
  'Code review: Found 2 potential issues: 1) Missing null check...',
] as const;

/**
 * Diverse input formats for testing the extractPromptsFromSpan parser:
 * - Array format (standard LLM messages)
 * - Object with messages key (e.g. some SDK wrappers)
 * - Plain string (simple query format)
 */
const SAMPLE_INPUTS_ARRAY_FORMAT = JSON.stringify([
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Summarize the quarterly report for Q3 2024.' },
]);

const SAMPLE_INPUTS_MESSAGES_FORMAT = JSON.stringify({
  messages: [
    { role: 'user', content: 'What is the capital of France?' },
  ],
});

const SAMPLE_INPUTS_PLAIN = 'What is the weather in San Francisco today?';

/** Tool call payloads in the format used by real ClickHouse data */
const TOOL_CALL_SINGLE = JSON.stringify([
  {
    name: 'get_weather',
    arguments: JSON.stringify({ location: 'San Francisco', unit: 'celsius' }),
    result: JSON.stringify({ temperature: 18, condition: 'partly cloudy', humidity: 72 }),
  },
]);

const TOOL_CALL_MULTI = JSON.stringify([
  {
    name: 'search_db',
    arguments: JSON.stringify({ query: 'user purchase history', userId: 'user-alice' }),
    result: JSON.stringify({ records: [{ id: 1, product: 'Widget A', date: '2024-01-15', price: 29.99 }], total: 1 }),
  },
  {
    name: 'format_result',
    arguments: JSON.stringify({ data: { records: 1 }, format: 'markdown' }),
    result: JSON.stringify({ formatted: '## Purchase History\n- Widget A ($29.99, Jan 15, 2024)' }),
  },
]);

// ============================================================================
// Pool Generation
// ============================================================================

function pickWeightedModel(rng: ReturnType<typeof createRng>) {
  const r = rng.next();
  let cumulative = 0;
  for (const model of MODELS) {
    cumulative += model.weight;
    if (r <= cumulative) return model;
  }
  return MODELS[0];
}





function generatePool(): MockDataPool {
  const rng = createRng(SEED);
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);

  const traces: MockTrace[] = [];
  const scores: MockScore[] = [];

  // Generate 60 traces spread across last 30 days (weighted toward recent)
  for (let i = 0; i < 60; i++) {
    const traceId = `trace-${String(i).padStart(3, '0')}`;

    // First 5 traces always land on today; rest use sqrt distribution weighted toward recent
    const dayOffset = i < 5 ? 30 : Math.floor(30 * Math.sqrt(rng.next()));
    const traceDate = new Date(thirtyDaysAgo.getTime() + dayOffset * 86_400_000);
    // Add random hour offset
    traceDate.setHours(rng.nextInt(6, 22), rng.nextInt(0, 59), rng.nextInt(0, 59));

    // ~90% of traces have an attributed user, matching the real pipeline's
    // `userId` (omitted whenever the root span carries no UserId).
    const userId = rng.next() < 0.90 ? rng.pick(USER_IDS) : null;
    const traceName = rng.pick(TRACE_NAMES);

    // ~50% of traces get a session, ~10 get none
    const sessionId = rng.next() < 0.83 ? rng.pick(SESSION_IDS) : null;

    // Trace-level metadata (shared by all spans in this trace)
    const traceMetadata: Record<string, string> = {
      environment: rng.pick(ENVIRONMENTS),
      customer_tier: rng.pick(CUSTOMER_TIERS),
      feature: rng.pick(FEATURES),
    };

    // Root span
    const rootDuration = rng.nextInt(500, 5000);
    const rootSpan: MockSpan = {
      id: `span-${traceId}-root`,
      traceId,
      parentId: null,
      name: traceName,
      type: 'SPAN',
      status: 'OK',
      statusMessage: '',
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      tokens: 0,
      cost: 0,
      durationMs: rootDuration,
      timestamp: traceDate,
      input: rng.pick(SAMPLE_INPUTS),
      output: rng.pick(SAMPLE_OUTPUTS),
      props: null,
      userId,
      finishReason: null,
      reasoningTokens: 0,
      spanKind: 'internal',
      serviceName: 'app-service',
      metadata: traceMetadata,
    };

    // 1-3 GENERATION child spans
    const numGenerations = rng.nextInt(1, 3);
    const generationSpans: MockSpan[] = [];

    for (let g = 0; g < numGenerations; g++) {
      const model = pickWeightedModel(rng);
      const isError = rng.next() < 0.05;
      const inputTokens = model.avgInput + rng.nextInt(-200, 200);
      const outputTokens = isError ? 0 : model.avgOutput + rng.nextInt(-100, 200);
      const tokens = inputTokens + outputTokens;
      const cost = (inputTokens / 1000) * model.costPer1kIn + (outputTokens / 1000) * model.costPer1kOut;
      const duration = model.avgLatency + rng.nextInt(-300, 500);

      const spanTimestamp = new Date(traceDate.getTime() + (g + 1) * rng.nextInt(50, 200));

      const genSpan: MockSpan = {
        id: `span-${traceId}-gen-${g}`,
        traceId,
        parentId: rootSpan.id,
        name: rng.pick(SPAN_NAMES),
        type: 'GENERATION',
        status: isError ? 'ERROR' : 'OK',
        statusMessage: isError ? 'Rate limit exceeded' : '',
        model: model.name,
        inputTokens: Math.max(0, inputTokens),
        outputTokens: Math.max(0, outputTokens),
        tokens: Math.max(0, tokens),
        cost: Math.round(cost * 1_000_000) / 1_000_000,
        durationMs: Math.max(100, duration),
        timestamp: spanTimestamp,
        input: rng.pick(SAMPLE_INPUTS),
        output: isError ? '' : rng.pick(SAMPLE_OUTPUTS),
        props: null,
        userId,
        finishReason: isError ? 'error' : 'stop',
        reasoningTokens: 0,
        spanKind: 'client',
        serviceName: 'app-service',
        metadata: traceMetadata,
      };

      generationSpans.push(genSpan);

      // ~30% of GENERATION spans get 1-2 scores
      if (rng.next() < 0.30) {
        const numScores = rng.nextInt(1, 2);
        for (let si = 0; si < numScores; si++) {
          const scoreName = rng.pick(SCORE_NAMES);
          scores.push({
            id: `score-${genSpan.id}-${si}`,
            resourceId: genSpan.id,
            name: scoreName,
            score: Math.round((rng.next() * 0.5 + 0.5) * 100) / 100, // 0.50-1.00
            label: rng.next() < 0.5 ? 'good' : 'acceptable',
            reason: `Auto-evaluated ${scoreName}`,
            source: rng.next() < 0.7 ? 'experiment' : 'annotation',
            createdAt: new Date(spanTimestamp.getTime() + 1000),
          });
        }
      }
    }

    const allSpans = [rootSpan, ...generationSpans];
    const totalCost = generationSpans.reduce((s, sp) => s + sp.cost, 0);
    const totalTokens = generationSpans.reduce((s, sp) => s + sp.tokens, 0);
    const hasError = generationSpans.some((sp) => sp.status === 'ERROR');

    // Compute trace end time from root duration
    const traceEnd = new Date(traceDate.getTime() + rootDuration);

    traces.push({
      id: traceId,
      name: traceName,
      sessionId,
      userId,
      rootSpan,
      generationSpans,
      allSpans,
      start: traceDate,
      end: traceEnd,
      latencyMs: rootDuration,
      totalCost: Math.round(totalCost * 1_000_000) / 1_000_000,
      totalTokens,
      status: hasError ? 'ERROR' : 'OK',
    });
  }

  // Append complex multi-level traces for realistic tree/timeline demos
  const complexTraces = generateComplexTraces(rng, now, scores);
  traces.push(...complexTraces);

  const alerts = generateAlerts(rng);
  const alertHistory = generateAlertHistory(rng, alerts);

  return {
    traces,
    scores,
    userIds: [...USER_IDS],
    sessionIds: [...SESSION_IDS],
    alerts,
    alertHistory,
  };
}

// ============================================================================
// Complex Trace Generation
// ============================================================================

/** Model lookup by short name for complex trace templates */
const MODEL_MAP = Object.fromEntries(MODELS.map((m) => [m.name, m])) as Record<string, (typeof MODELS)[number]>;

/** Shorthand aliases for templates → full model names */
const MODEL_ALIAS: Record<string, string> = {
  'claude-sonnet': 'claude-sonnet-4-20250514',
  'claude-haiku': 'claude-haiku-4-20250414',
  'gpt-4o': 'gpt-4o',
  'gpt-4o-mini': 'gpt-4o-mini',
};

interface SpanTemplate {
  name: string;
  type: 'SPAN' | 'GENERATION';
  /** Short alias from MODEL_ALIAS — null for SPAN (orchestration) */
  model: string | null;
  children?: SpanTemplate[];
  /** Force ERROR status on this span */
  forceError?: boolean;
}

interface ComplexTraceTemplate {
  id: string;
  name: string;
  tree: SpanTemplate;
}

const COMPLEX_TEMPLATES: ComplexTraceTemplate[] = [
  // ── 1. Multi-agent pipeline (~15 spans, depth 4) ──
  {
    id: 'trace-complex-001',
    name: 'multi-agent-pipeline',
    tree: {
      name: 'agent-pipeline', type: 'SPAN', model: null, children: [
        { name: 'intent-classification', type: 'GENERATION', model: 'claude-sonnet' },
        { name: 'tool-selection', type: 'SPAN', model: null, children: [
          { name: 'tool-ranking', type: 'GENERATION', model: 'gpt-4o' },
          { name: 'parameter-extraction', type: 'GENERATION', model: 'gpt-4o-mini' },
        ]},
        { name: 'tool-execution', type: 'SPAN', model: null, children: [
          { name: 'api-call-search', type: 'SPAN', model: null, children: [
            { name: 'response-parse', type: 'GENERATION', model: 'gpt-4o-mini' },
          ]},
          { name: 'api-call-database', type: 'SPAN', model: null, children: [
            { name: 'response-parse', type: 'GENERATION', model: 'gpt-4o-mini', forceError: true },
          ]},
          { name: 'api-call-calculator', type: 'SPAN', model: null, children: [
            { name: 'response-parse', type: 'GENERATION', model: 'gpt-4o-mini' },
          ]},
        ]},
        { name: 'result-synthesis', type: 'GENERATION', model: 'claude-sonnet' },
        { name: 'response-formatting', type: 'GENERATION', model: 'gpt-4o' },
      ],
    },
  },

  // ── 2. RAG with reranking (~12 spans, depth 3) ──
  {
    id: 'trace-complex-002',
    name: 'rag-with-reranking',
    tree: {
      name: 'rag-pipeline', type: 'SPAN', model: null, children: [
        { name: 'query-expansion', type: 'GENERATION', model: 'gpt-4o' },
        { name: 'embedding-generation', type: 'GENERATION', model: 'gpt-4o-mini' },
        { name: 'vector-search', type: 'SPAN', model: null, children: [
          { name: 'index-lookup', type: 'SPAN', model: null },
          { name: 'reranking', type: 'GENERATION', model: 'claude-haiku' },
        ]},
        { name: 'context-assembly', type: 'SPAN', model: null, children: [
          { name: 'chunk-scoring', type: 'GENERATION', model: 'gpt-4o-mini' },
        ]},
        { name: 'answer-generation', type: 'GENERATION', model: 'claude-sonnet' },
        { name: 'citation-extraction', type: 'GENERATION', model: 'gpt-4o-mini' },
      ],
    },
  },

  // ── 3. Multi-turn coding agent (~20 spans, depth 5) ──
  {
    id: 'trace-complex-003',
    name: 'multi-turn-coding-agent',
    tree: {
      name: 'coding-agent', type: 'SPAN', model: null, children: [
        { name: 'turn-1-understand', type: 'SPAN', model: null, children: [
          { name: 'user-intent-analysis', type: 'GENERATION', model: 'claude-sonnet' },
          { name: 'codebase-search', type: 'SPAN', model: null, children: [
            { name: 'search-query-gen', type: 'GENERATION', model: 'gpt-4o-mini' },
            { name: 'file-retrieval', type: 'SPAN', model: null },
          ]},
          { name: 'initial-response', type: 'GENERATION', model: 'claude-sonnet' },
        ]},
        { name: 'turn-2-implement', type: 'SPAN', model: null, children: [
          { name: 'context-update', type: 'GENERATION', model: 'gpt-4o' },
          { name: 'code-generation', type: 'SPAN', model: null, children: [
            { name: 'plan-generation', type: 'GENERATION', model: 'claude-sonnet' },
            { name: 'code-write', type: 'GENERATION', model: 'claude-sonnet' },
            { name: 'code-review', type: 'GENERATION', model: 'gpt-4o', forceError: true },
          ]},
          { name: 'code-execution', type: 'SPAN', model: null, children: [
            { name: 'result-interpretation', type: 'GENERATION', model: 'gpt-4o-mini' },
          ]},
          { name: 'response-gen', type: 'GENERATION', model: 'claude-sonnet' },
        ]},
        { name: 'turn-3-refine', type: 'SPAN', model: null, children: [
          { name: 'feedback-analysis', type: 'GENERATION', model: 'gpt-4o' },
          { name: 'code-revision', type: 'GENERATION', model: 'claude-sonnet' },
          { name: 'final-summary', type: 'GENERATION', model: 'gpt-4o-mini' },
        ]},
      ],
    },
  },
];

/**
 * Materialises the 3 complex trace templates into MockTrace objects.
 * Places them on recent dates so they appear near the top of the trace list.
 */
function generateComplexTraces(
  rng: ReturnType<typeof createRng>,
  now: Date,
  scores: MockScore[],
): MockTrace[] {
  const results: MockTrace[] = [];

  for (let tIdx = 0; tIdx < COMPLEX_TEMPLATES.length; tIdx++) {
    const template = COMPLEX_TEMPLATES[tIdx]!;
    // Place each complex trace within the last 2 days
    const traceDate = new Date(now.getTime() - tIdx * 8 * 3_600_000); // ~8h apart
    traceDate.setMinutes(rng.nextInt(0, 59), rng.nextInt(0, 59));

    const userId = rng.pick(USER_IDS);
    const sessionId = rng.pick(SESSION_IDS);
    const traceMetadata: Record<string, string> = {
      environment: 'production',
      customer_tier: rng.pick(CUSTOMER_TIERS),
      feature: rng.pick(FEATURES),
    };

    const allSpans: MockSpan[] = [];
    const generationSpans: MockSpan[] = [];
    let spanCounter = 0;
    /** Running clock offset (ms) within the trace */
    let clockMs = 0;

    function materialize(
      node: SpanTemplate,
      parentId: string | null,
      depth: number,
    ): MockSpan {
      const idx = spanCounter++;
      const spanId = `span-${template.id}-${idx}`;
      const isGen = node.type === 'GENERATION';
      const isError = node.forceError === true;

      // Resolve model
      const fullModelName = node.model ? MODEL_ALIAS[node.model] ?? node.model : null;
      const modelInfo = fullModelName ? MODEL_MAP[fullModelName] : null;

      // Token counts
      let inputTokens = 0;
      let outputTokens = 0;
      if (modelInfo) {
        inputTokens = modelInfo.avgInput + rng.nextInt(-150, 200);
        outputTokens = isError ? 0 : modelInfo.avgOutput + rng.nextInt(-80, 180);
      }
      const tokens = inputTokens + outputTokens;
      const cost = modelInfo
        ? Math.round(
            ((inputTokens / 1000) * modelInfo.costPer1kIn +
              (outputTokens / 1000) * modelInfo.costPer1kOut) * 1_000_000,
          ) / 1_000_000
        : 0;

      // Latency — GENERATION uses model avg, SPAN wraps children
      const ownLatency = modelInfo
        ? modelInfo.avgLatency + rng.nextInt(-200, 400)
        : rng.nextInt(20, 80); // orchestration overhead

      // Timestamp relative to trace start
      const spanStart = new Date(traceDate.getTime() + clockMs);
      clockMs += rng.nextInt(5, 30); // small gap before first child

      // Assign diverse input formats and tool calls based on span index
      let spanInput: string;
      let spanToolCalls: string | null = null;
      if (isGen) {
        const inputFormat = idx % 4;
        if (inputFormat === 0) {
          spanInput = SAMPLE_INPUTS_ARRAY_FORMAT;
        } else if (inputFormat === 1) {
          spanInput = SAMPLE_INPUTS_MESSAGES_FORMAT;
        } else if (inputFormat === 2) {
          spanInput = SAMPLE_INPUTS_PLAIN;
        } else {
          spanInput = rng.pick(SAMPLE_INPUTS);
        }
        // Assign tool calls to specific span indices
        if (idx === 2) spanToolCalls = TOOL_CALL_SINGLE;
        else if (idx === 5) spanToolCalls = TOOL_CALL_MULTI;
      } else {
        spanInput = rng.pick(SAMPLE_INPUTS);
      }

      const span: MockSpan = {
        id: spanId,
        traceId: template.id,
        parentId,
        name: node.name,
        type: node.type,
        status: isError ? 'ERROR' : 'OK',
        statusMessage: isError ? 'Internal server error' : '',
        model: fullModelName,
        inputTokens: Math.max(0, inputTokens),
        outputTokens: Math.max(0, outputTokens),
        tokens: Math.max(0, tokens),
        cost,
        durationMs: 0, // filled below after children
        timestamp: spanStart,
        input: spanInput,
        output: isError ? '' : rng.pick(SAMPLE_OUTPUTS),
        toolCalls: spanToolCalls,
        props: null,
        userId,
        finishReason: isGen ? (isError ? 'error' : 'stop') : null,
        reasoningTokens: 0,
        spanKind: isGen ? 'client' : 'internal',
        serviceName: 'app-service',
        metadata: traceMetadata,
      };

      // Recursively materialize children
      if (node.children) {
        for (const child of node.children) {
          materialize(child, spanId, depth + 1);
        }
      }

      // After children are placed, advance clock by own latency
      if (!node.children || node.children.length === 0) {
        clockMs += Math.max(100, ownLatency);
      } else {
        clockMs += rng.nextInt(10, 40); // closing overhead for parent
      }

      // Compute duration: from span start to current clock
      span.durationMs = Math.max(50, clockMs - (spanStart.getTime() - traceDate.getTime()));

      allSpans.push(span);
      if (isGen) {
        generationSpans.push(span);

        // ~30% of GENERATION spans get scores
        if (rng.next() < 0.30) {
          const numScores = rng.nextInt(1, 2);
          for (let si = 0; si < numScores; si++) {
            const scoreName = rng.pick(SCORE_NAMES);
            scores.push({
              id: `score-${spanId}-${si}`,
              resourceId: spanId,
              name: scoreName,
              score: Math.round((rng.next() * 0.5 + 0.5) * 100) / 100,
              label: rng.next() < 0.5 ? 'good' : 'acceptable',
              reason: `Auto-evaluated ${scoreName}`,
              source: rng.next() < 0.7 ? 'experiment' : 'annotation',
              createdAt: new Date(spanStart.getTime() + 1000),
            });
          }
        }
      }

      return span;
    }

    materialize(template.tree, null, 0);

    // Root span is the last one pushed (post-order), but we want it first
    // Actually, it's the last element since we push after children
    const rootSpan = allSpans[allSpans.length - 1]!;

    // Re-sort: root first, then by timestamp
    allSpans.sort((a, b) => {
      if (a.parentId === null) return -1;
      if (b.parentId === null) return 1;
      return a.timestamp.getTime() - b.timestamp.getTime();
    });

    const totalCost = generationSpans.reduce((s, sp) => s + sp.cost, 0);
    const totalTokens = generationSpans.reduce((s, sp) => s + sp.tokens, 0);
    const hasError = allSpans.some((sp) => sp.status === 'ERROR');
    const traceEnd = new Date(traceDate.getTime() + rootSpan.durationMs);

    results.push({
      id: template.id,
      name: template.name,
      sessionId,
      userId,
      rootSpan,
      generationSpans,
      allSpans,
      start: traceDate,
      end: traceEnd,
      latencyMs: rootSpan.durationMs,
      totalCost: Math.round(totalCost * 1_000_000) / 1_000_000,
      totalTokens,
      status: hasError ? 'ERROR' : 'OK',
    });
  }

  return results;
}






const CI_ALERT_NAMES = [
  'High Latency Alert',
  'Error Rate Spike',
  'Cost Threshold Exceeded',
  'Low Evaluation Score',
] as const;

const CI_ALERT_METRICS: Array<MockAlert['metric']> = [
  'latency', 'error_rate', 'cost', 'evaluation_score',
];

/**
 * Builds 4 mock alerts covering the main metric types.
 */
/** Sample commit SHAs used for the first few mock alerts. */
const MOCK_COMMIT_SHAS: (string | null)[] = [
  'a1b2c3d4e5f6789012345678901234567890abcd',
  'f0e1d2c3b4a5968778695a4b3c2d1e0f12345678',
  'deadbeef01234567890abcdef1234567890abcde',
  null,
];

function generateAlerts(rng: ReturnType<typeof createRng>): MockAlert[] {
  const now = new Date();
  return CI_ALERT_NAMES.map((name, idx): MockAlert => {
    const metric = CI_ALERT_METRICS[idx % CI_ALERT_METRICS.length] as MockAlert['metric'];
    const isEvalScore = metric === 'evaluation_score';
    const createdAt = new Date(now.getTime() - (idx + 1) * 7 * 24 * 60 * 60 * 1000);

    // Consume rng call to keep the sequence deterministic
    rng.next();

    return {
      id: `mock-alert-${idx}`,
      app_id: 'mock-app',
      tenant_id: 'mock-tenant',
      name,
      metric,
      threshold: metric === 'latency' ? 2000 : metric === 'cost' ? 0.5 : metric === 'error_rate' ? 5 : 0.6,
      time_window: 15,
      status: idx % 2 === 0 ? 'triggered' : 'resolved',
      use_slack: false,
      use_webhook: false,
      evaluation_name: isEvalScore ? SCORE_NAMES[0] : null,
      evaluation_aggregation: isEvalScore ? 'avg' : null,
      evaluation_threshold_direction: isEvalScore ? 'below' : null,
      commit_sha: MOCK_COMMIT_SHAS[idx % MOCK_COMMIT_SHAS.length] ?? null,
      created_at: createdAt.toISOString(),
      created_by: null,
      updated_at: null,
      updated_by: null,
    };
  });
}

/**
 * Generates 3-6 history events per alert, alternating triggered/resolved pairs
 * to simulate realistic alert lifecycle patterns.
 */
function generateAlertHistory(
  rng: ReturnType<typeof createRng>,
  alerts: MockAlert[],
): MockAlertHistory[] {
  const history: MockAlertHistory[] = [];
  let historyIdx = 0;

  /** Produce a realistic triggered_value string for the given metric */
  function triggeredValue(metric: MockAlert['metric'], threshold: number): string {
    switch (metric) {
      case 'latency':
        return `${Math.round(threshold + rng.nextInt(100, 800))}`;
      case 'error_rate':
        return `${(threshold + rng.next() * 4).toFixed(1)}`;
      case 'cost':
        return `${(threshold + rng.next() * 0.3).toFixed(2)}`;
      case 'evaluation_score':
        // Scores that drop below threshold
        return `${(threshold - rng.next() * 0.15).toFixed(2)}`;
      default:
        return `${threshold}`;
    }
  }

  for (const alert of alerts) {
    const eventCount = rng.nextInt(3, 6);
    const alertCreatedMs = new Date(alert.created_at).getTime();

    for (let i = 0; i < eventCount; i++) {
      // Events spread from alert creation to now, newest first
      const eventDate = new Date(
        alertCreatedMs + (i + 1) * rng.nextInt(12, 48) * 3_600_000,
      );

      // Alternate triggered → resolved pairs
      const isTriggered = i % 2 === 0;

      history.push({
        id: `mock-alert-history-${historyIdx++}`,
        alert_id: alert.id,
        app_id: alert.app_id,
        tenant_id: alert.tenant_id,
        alert_name: alert.name,
        alert_metric: alert.metric,
        triggered_value: isTriggered
          ? triggeredValue(alert.metric, alert.threshold)
          : '0',
        status: isTriggered ? 'triggered' : 'resolved',
        evaluation_name: alert.evaluation_name,
        evaluation_aggregation: alert.evaluation_aggregation,
        evaluation_threshold_direction: alert.evaluation_threshold_direction,
        commit_sha: isTriggered ? alert.commit_sha : null,
        created_at: eventDate.toISOString(),
        created_by: null,
        updated_at: null,
        updated_by: null,
      });
    }
  }

  // Sort newest first (matching the UI's order)
  history.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return history;
}

// ============================================================================
// Singleton + Helpers
// ============================================================================

let _pool: MockDataPool | null = null;
let _poolDate: string | null = null;

export function getMockDataPool(): MockDataPool {
  const today = new Date().toISOString().split('T')[0] as string;
  if (!_pool || _poolDate !== today) {
    _pool = generatePool();
    _poolDate = today;
  }
  return _pool;
}

export function filterByDateRange(traces: MockTrace[], start?: string, end?: string): MockTrace[] {
  if (!start && !end) return traces;
  const startMs = start ? new Date(start).getTime() : 0;
  const endMs = end ? new Date(end + 'T23:59:59.999Z').getTime() : Infinity;
  return traces.filter((t) => {
    const ts = t.start.getTime();
    return ts >= startMs && ts <= endMs;
  });
}
