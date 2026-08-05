/**
 * Mock Analytics Service
 *
 * Returns realistic fake data when ClickHouse is not available.
 * Used on Vercel preview branches where ClickHouse is not provisioned.
 *
 * All 14 IAnalyticsService methods derive from a shared pool of ~60 traces
 * so every page shows consistent, interlinked data.
 */

// Subpath import (not the barrel) so no Node-only deps leak into the bundle —
// same canonical trace-I/O derivation the real TracesService uses, so the mock
// list previews match production semantics (root span wins, GENERATION fallback).
import { deriveTraceIO } from '@repo/shared-utils/trace-io';
import type { TenantContext } from './tenant-context';
import type {
  IAnalyticsService,
  DateRange,
  MetricsResponse,
  MetricsSummary,
  TimeSeriesPoint,
  ModelStatsResponse,
  ModelStats,
  TracesParams,
  TracesResponse,
  TraceSummary,
  TraceDetail,
  Span,
  PercentilesParams,
  PercentilesResponse,
  PercentilePoint,
  ExtendedMetricsResponse,
  ExtendedMetricsSummary,
  ScoresParams,
  ScoresResponse,
  Score,
  ScoreAggregationsResponse,
  ScoreNamesResponse,
  ScoreAggregation,
  RequestsParams,
  RequestsResponse,
  RequestRecord,
  AnalyticsFilter,
  RankingDataResponse,
  RankingDataItem,
  AggregateRequestsParams,
  AggregateRequestsResponse,
  AggregateRequestsRow,
  ScoreType,
  ScoreHistogramResponse,
  ScoreTrendResponse,
  ScoreTrendInterval,
  ScoreComparisonResponse,
  ScoreScatterResponse,
  SpanKindBreakdownRecord,
} from './types';
import {
  getMockDataPool,
  filterByDateRange,
  type MockSpan,
  type MockTrace,
  type MockScore,
} from './mock-data';

// ============================================================================
// Helpers
// ============================================================================

function spanToApiSpan(span: MockSpan): Span {
  return {
    id: span.id,
    traceId: span.traceId,
    parentId: span.parentId,
    name: span.name,
    status: span.status,
    statusMessage: span.statusMessage,
    durationMs: span.durationMs,
    timestamp: span.timestamp.toISOString(),
    type: span.type,
    model: span.model,
    inputTokens: span.inputTokens,
    outputTokens: span.outputTokens,
    tokens: span.tokens,
    cost: span.cost,
    input: span.input,
    output: span.output,
    outputObject: null,
    toolCalls: span.toolCalls ?? null,
    finishReason: span.finishReason,
    settings: null,
    reasoningTokens: span.reasoningTokens,
    metadata: span.metadata,
    props: span.props,
    spanKind: span.spanKind,
    serviceName: span.serviceName,
  };
}

function buildSpanScores(trace: MockTrace, allScores: MockScore[]): Record<string, Score[]> {
  const spanScores: Record<string, Score[]> = {};
  for (const span of trace.allSpans) {
    const scores = allScores.filter((s) => s.resourceId === span.id);
    if (scores.length > 0) {
      spanScores[span.id] = scores.map((s) => ({
        id: s.id,
        resourceId: s.resourceId,
        name: s.name,
        score: s.score,
        label: s.label,
        reason: s.reason,
        source: s.source,
        createdAt: s.createdAt.toISOString(),
      }));
    }
  }
  return spanScores;
}

function traceToDetail(trace: MockTrace, allScores?: MockScore[]): TraceDetail {
  const spanScores = allScores ? buildSpanScores(trace, allScores) : undefined;
  return {
    id: trace.id,
    name: trace.name,
    status: trace.status,
    start: trace.start.toISOString(),
    end: trace.end.toISOString(),
    latencyMs: trace.latencyMs,
    cost: trace.totalCost,
    tokens: trace.totalTokens,
    input: trace.rootSpan.input,
    output: trace.rootSpan.output,
    spans: trace.allSpans.map(spanToApiSpan),
    spanScores: spanScores && Object.keys(spanScores).length > 0 ? spanScores : undefined,
    ...(trace.userId ? { userId: trace.userId } : {}),
    ...(trace.sessionId ? { sessionId: trace.sessionId } : {}),
  };
}

const MOCK_IO_PREVIEW_MAX_CHARS = 160;

function traceToSummary(trace: MockTrace): TraceSummary {
  const io = deriveTraceIO(
    trace.allSpans.map((span) => ({
      parentId: span.parentId,
      type: span.type,
      timestamp: span.timestamp.getTime(),
      input: span.input,
      output: span.output,
    })),
  );
  const preview = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0
      ? value.slice(0, MOCK_IO_PREVIEW_MAX_CHARS)
      : undefined;

  return {
    id: trace.id,
    name: trace.name,
    status: trace.status,
    start: trace.start.toISOString(),
    end: trace.end.toISOString(),
    latencyMs: trace.latencyMs,
    cost: trace.totalCost,
    tokens: trace.totalTokens,
    spanCount: trace.allSpans.length,
    ...(preview(io.input) ? { inputPreview: preview(io.input) } : {}),
    ...(preview(io.output) ? { outputPreview: preview(io.output) } : {}),
  };
}

function matchString(actual: string | null | undefined, operator: string, target: string): boolean {
  const s = actual ?? '';
  switch (operator) {
    case 'equals':
    case '=':
      return s === target;
    case 'notequals':
    case 'not_equals':
    case '!=':
      return s !== target;
    case 'contains':
    case 'like':
      return target ? s.toLowerCase().includes(target.toLowerCase()) : false;
    case 'startsWith':
      return s.toLowerCase().startsWith(target.toLowerCase());
    case 'endsWith':
      return s.toLowerCase().endsWith(target.toLowerCase());
    case 'notContains':
      return target ? !s.toLowerCase().includes(target.toLowerCase()) : true;
    case 'isEmpty':
      return s === '';
    case 'isNotEmpty':
      return s !== '';
    default:
      return s === target;
  }
}

function matchNumeric(actual: number | null | undefined, operator: string, target: string): boolean {
  const num = actual ?? 0;
  const t = Number(target);
  if (Number.isNaN(t)) return false;
  switch (operator) {
    case '=':
    case 'equals':
      return num === t;
    case '!=':
    case 'notequals':
    case 'not_equals':
      return num !== t;
    case '>':
    case 'gt':
      return num > t;
    case '>=':
    case 'gte':
      return num >= t;
    case '<':
    case 'lt':
      return num < t;
    case '<=':
    case 'lte':
      return num <= t;
    default:
      return num === t;
  }
}

const NUMERIC_FIELDS = new Set(['prompt_tokens', 'completion_tokens', 'cost', 'latency_ms']);
const STRING_FIELDS = new Set([
  'model', 'model_used', 'user_id', 'status',
  'input', 'output', 'props', 'trace_id',
]);

function resolveSpanField(span: MockSpan, field: string): string | number | null {
  switch (field) {
    case 'model':
    case 'model_used':
      return span.model;
    case 'user_id':
      return span.userId;
    case 'status':
      return span.status;
    case 'prompt_tokens':
      return span.inputTokens;
    case 'completion_tokens':
      return span.outputTokens;
    case 'cost':
      return span.cost;
    case 'latency_ms':
      return span.durationMs;
    case 'input':
      return span.input;
    case 'output':
      return span.output;
    case 'props':
      return span.props;
    case 'trace_id':
      return span.traceId;
    default:
      return null;
  }
}

export function applyFiltersToSpans(spans: MockSpan[], filters?: AnalyticsFilter[]): MockSpan[] {
  if (!filters || filters.length === 0) return spans;
  return spans.filter((span) => {
    return filters.every((f) => {
      const val = Array.isArray(f.value) ? f.value[0] : f.value;
      const target = val ?? '';

      // Handle metadata.* fields
      if (f.field.startsWith('metadata.')) {
        const key = f.field.slice('metadata.'.length);
        const metaVal = span.metadata[key] ?? null;
        return matchString(metaVal, f.operator, target);
      }

      // Numeric fields
      if (NUMERIC_FIELDS.has(f.field)) {
        const numVal = resolveSpanField(span, f.field) as number | null;
        return matchNumeric(numVal, f.operator, target);
      }

      // String fields
      const strVal = resolveSpanField(span, f.field);
      if (strVal !== null || STRING_FIELDS.has(f.field)) {
        return matchString(strVal as string | null, f.operator, target);
      }

      // Unknown field — pass through for forward compatibility
      return true;
    });
  });
}

function getGenerationSpans(traces: MockTrace[]): MockSpan[] {
  return traces.flatMap((t) => t.generationSpans);
}

function daysBetween(start: string, end: string): number {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  return Math.max(1, Math.ceil((e - s) / 86_400_000) + 1);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function paginate<T>(items: T[], offset: number, limit: number): T[] {
  return items.slice(offset, offset + limit);
}

// ============================================================================
// Time Series from Pool (for dashboard metrics)
// ============================================================================

function buildTimeSeriesFromSpans(
  spans: MockSpan[],
  dateRange: DateRange,
): TimeSeriesPoint[] {
  const useHourly = dateRange.start === dateRange.end;
  const points: Map<string, TimeSeriesPoint> = new Map();

  // Pre-populate buckets so there are no gaps
  if (useHourly) {
    for (let h = 0; h < 24; h++) {
      const key = `${dateRange.start}-${h}`;
      points.set(key, {
        date: dateRange.start,
        hour: h,
        requests: 0, successes: 0, errors: 0,
        cost: 0, tokens: 0, inputTokens: 0, outputTokens: 0,
        avgLatencyMs: 0, uniqueUsers: 0,
      });
    }
  } else {
    const totalDays = daysBetween(dateRange.start, dateRange.end);
    const start = new Date(dateRange.start);
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().split('T')[0] as string;
      points.set(dateStr, {
        date: dateStr,
        hour: 0,
        requests: 0, successes: 0, errors: 0,
        cost: 0, tokens: 0, inputTokens: 0, outputTokens: 0,
        avgLatencyMs: 0, uniqueUsers: 0,
      });
    }
  }

  // Track users per bucket and latency sum for weighted average
  const userSets = new Map<string, Set<string>>();
  const latencySum = new Map<string, number>();

  for (const span of spans) {
    const dateStr = span.timestamp.toISOString().split('T')[0] as string;
    const hour = span.timestamp.getHours();
    const key = useHourly ? `${dateStr}-${hour}` : dateStr;

    const pt = points.get(key);
    if (!pt) continue;

    pt.requests += 1;
    if (span.status === 'OK') pt.successes += 1;
    else pt.errors += 1;
    pt.cost += span.cost;
    pt.tokens += span.tokens;
    pt.inputTokens += span.inputTokens;
    pt.outputTokens += span.outputTokens;

    latencySum.set(key, (latencySum.get(key) ?? 0) + span.durationMs);

    if (!userSets.has(key)) userSets.set(key, new Set());
    if (span.userId) userSets.get(key)!.add(span.userId);
  }

  // Finalize averages and rounding
  for (const [key, pt] of points) {
    if (pt.requests > 0) {
      pt.avgLatencyMs = Math.round((latencySum.get(key) ?? 0) / pt.requests);
    }
    pt.uniqueUsers = userSets.get(key)?.size ?? 0;
    pt.cost = Math.round(pt.cost * 1_000_000) / 1_000_000;
  }

  return [...points.values()];
}

function aggregateSummary(points: TimeSeriesPoint[]): MetricsSummary {
  const totalRequests = points.reduce((s, p) => s + p.requests, 0);
  const successCount = points.reduce((s, p) => s + p.successes, 0);
  const errorCount = points.reduce((s, p) => s + p.errors, 0);
  const totalCost = points.reduce((s, p) => s + p.cost, 0);
  const totalTokens = points.reduce((s, p) => s + p.tokens, 0);
  const inputTokens = points.reduce((s, p) => s + p.inputTokens, 0);
  const outputTokens = points.reduce((s, p) => s + p.outputTokens, 0);
  const avgLatencyMs =
    totalRequests > 0
      ? points.reduce((s, p) => s + p.avgLatencyMs * p.requests, 0) / totalRequests
      : 0;

  // Collect unique users across all buckets (approximate using max per bucket)
  const uniqueUsers = points.length > 0
    ? Math.max(...points.map((p) => p.uniqueUsers))
    : 0;

  return {
    totalRequests,
    successCount,
    errorCount,
    totalCost: Math.round(totalCost * 100) / 100,
    totalTokens,
    inputTokens,
    outputTokens,
    avgLatencyMs: Math.round(avgLatencyMs),
    uniqueUsers,
  };
}

// ============================================================================
// Mock Analytics Service
// ============================================================================

export class MockAnalyticsService implements IAnalyticsService {

  // ── Health ────────────────────────────────────────────────────────────

  async checkConnectivity(): Promise<boolean> {
    return true;
  }

  // ── Core Metrics ──────────────────────────────────────────────────────

  async getMetrics(
    _ctx: TenantContext,
    dateRange: DateRange,
    filters?: AnalyticsFilter[],
  ): Promise<MetricsResponse> {
    const pool = getMockDataPool();
    const filtered = filterByDateRange(pool.traces, dateRange.start, dateRange.end);
    const spans = applyFiltersToSpans(getGenerationSpans(filtered), filters);
    const timeSeries = buildTimeSeriesFromSpans(spans, dateRange);

    return {
      summary: aggregateSummary(timeSeries),
      timeSeries,
    };
  }

  async getExtendedMetrics(
    _ctx: TenantContext,
    dateRange: DateRange,
  ): Promise<ExtendedMetricsResponse> {
    const pool = getMockDataPool();
    const filtered = filterByDateRange(pool.traces, dateRange.start, dateRange.end);
    const spans = getGenerationSpans(filtered);
    const timeSeries = buildTimeSeriesFromSpans(spans, dateRange);
    const summary = aggregateSummary(timeSeries);
    const totalRequests = summary.totalRequests || 1;

    // Count distinct models
    const modelSet = new Set(spans.map((s) => s.model).filter(Boolean));

    const extendedSummary: ExtendedMetricsSummary = {
      ...summary,
      avgCostPerRequest: summary.totalCost / totalRequests,
      avgInputTokensPerRequest: summary.inputTokens / totalRequests,
      avgOutputTokensPerRequest: summary.outputTokens / totalRequests,
      avgTotalTokensPerRequest: summary.totalTokens / totalRequests,
      modelCount: modelSet.size,
    };

    return { summary: extendedSummary, timeSeries };
  }

  async getModelStats(
    _ctx: TenantContext,
    dateRange: DateRange,
    limit: number = 10,
    filters?: AnalyticsFilter[],
  ): Promise<ModelStatsResponse> {
    const pool = getMockDataPool();
    const filtered = filterByDateRange(pool.traces, dateRange.start, dateRange.end);
    const spans = applyFiltersToSpans(getGenerationSpans(filtered), filters);

    // Group by model
    const byModel = new Map<string, MockSpan[]>();
    for (const span of spans) {
      if (!span.model) continue;
      if (!byModel.has(span.model)) byModel.set(span.model, []);
      byModel.get(span.model)!.push(span);
    }

    const models: ModelStats[] = [...byModel.entries()]
      .map(([model, modelSpans]) => {
        const requests = modelSpans.length;
        const cost = modelSpans.reduce((s, sp) => s + sp.cost, 0);
        const tokens = modelSpans.reduce((s, sp) => s + sp.tokens, 0);
        const inputTk = modelSpans.reduce((s, sp) => s + sp.inputTokens, 0);
        const outputTk = modelSpans.reduce((s, sp) => s + sp.outputTokens, 0);
        const avgLatency = requests > 0
          ? modelSpans.reduce((s, sp) => s + sp.durationMs, 0) / requests
          : 0;
        const successes = modelSpans.filter((sp) => sp.status === 'OK').length;

        return {
          model,
          requests,
          cost: Math.round(cost * 1_000_000) / 1_000_000,
          tokens,
          inputTokens: inputTk,
          outputTokens: outputTk,
          avgLatencyMs: Math.round(avgLatency),
          successRate: requests > 0 ? (successes / requests) * 100 : 0,
        };
      })
      .sort((a, b) => b.requests - a.requests)
      .slice(0, limit);

    return { models };
  }

  // ── Ranking by dimension ──────────────────────────────────────────────

  async getRankingData(
    _ctx: TenantContext,
    dateRange: DateRange,
    dimension: string,
    limit: number = 10,
    filters?: AnalyticsFilter[],
  ): Promise<RankingDataResponse> {
    // For model dimension, reuse model stats logic
    if (dimension === 'model') {
      const modelStats = await this.getModelStats(_ctx, dateRange, limit, filters);
      return {
        items: modelStats.models.map((m): RankingDataItem => ({
          dimensionValue: m.model,
          requests: m.requests,
          cost: m.cost,
          tokens: m.tokens,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          avgLatencyMs: m.avgLatencyMs,
          successRate: m.successRate,
        })),
      };
    }

    // For user_id and metadata dimensions, group mock spans by the dimension
    const pool = getMockDataPool();
    const filtered = filterByDateRange(pool.traces, dateRange.start, dateRange.end);
    const spans = applyFiltersToSpans(getGenerationSpans(filtered), filters);

    const byDimension = new Map<string, MockSpan[]>();
    for (const span of spans) {
      let key: string | undefined;
      if (dimension === 'user_id') {
        key = span.userId || undefined;
      } else if (dimension.startsWith('metadata.')) {
        // Mock spans don't have metadata, use model as fallback
        key = span.model || undefined;
      }
      if (!key) continue;
      if (!byDimension.has(key)) byDimension.set(key, []);
      byDimension.get(key)!.push(span);
    }

    const items: RankingDataItem[] = [...byDimension.entries()]
      .map(([dimValue, dimSpans]): RankingDataItem => {
        const requests = dimSpans.length;
        const cost = dimSpans.reduce((s, sp) => s + sp.cost, 0);
        const tokens = dimSpans.reduce((s, sp) => s + sp.tokens, 0);
        const inputTk = dimSpans.reduce((s, sp) => s + sp.inputTokens, 0);
        const outputTk = dimSpans.reduce((s, sp) => s + sp.outputTokens, 0);
        const avgLatency = requests > 0
          ? dimSpans.reduce((s, sp) => s + sp.durationMs, 0) / requests
          : 0;
        const successes = dimSpans.filter((sp) => sp.status === 'OK').length;

        return {
          dimensionValue: dimValue,
          requests,
          cost: Math.round(cost * 1_000_000) / 1_000_000,
          tokens,
          inputTokens: inputTk,
          outputTokens: outputTk,
          avgLatencyMs: Math.round(avgLatency),
          successRate: requests > 0 ? (successes / requests) * 100 : 0,
        };
      })
      .sort((a, b) => b.requests - a.requests)
      .slice(0, limit);

    return { items };
  }

  // ── Traces ────────────────────────────────────────────────────────────

  async getTraces(
    _ctx: TenantContext,
    params: TracesParams,
  ): Promise<TracesResponse> {
    const pool = getMockDataPool();
    let traces = filterByDateRange(pool.traces, params.startDate, params.endDate);

    if (params.model) {
      traces = traces.filter((t) =>
        t.generationSpans.some((s) => s.model === params.model),
      );
    }
    if (params.userId) {
      traces = traces.filter((t) => t.userId === params.userId);
    }
    if (params.status) {
      traces = traces.filter((t) => t.status === params.status);
    }

    // Sort by start DESC
    traces = [...traces].sort((a, b) => b.start.getTime() - a.start.getTime());
    const total = traces.length;
    const page = paginate(traces, params.offset, params.limit);

    return {
      traces: page.map(traceToSummary),
      total: Math.max(total, 1), // Always >= 1 for onboarding check
      limit: params.limit,
      offset: params.offset,
    };
  }

  async getTraceDetail(
    _ctx: TenantContext,
    traceId: string,
  ): Promise<TraceDetail | null> {
    const pool = getMockDataPool();
    const trace = pool.traces.find((t) => t.id === traceId);
    if (!trace) return null;
    return traceToDetail(trace, pool.scores);
  }

  async getTraceDetailLightweight(
    ctx: TenantContext,
    traceId: string,
  ): Promise<TraceDetail | null> {
    // Mock returns full data since there's no performance concern
    return this.getTraceDetail(ctx, traceId);
  }

  async getSpanIO(
    _ctx: TenantContext,
    _traceId: string,
    spanId: string,
  ): Promise<import('./types').SpanIO | null> {
    const pool = getMockDataPool();
    for (const trace of pool.traces) {
      const span = trace.allSpans.find((s) => s.id === spanId);
      if (span) {
        return {
          input: span.input || '',
          output: span.output || '',
          outputObject: null,
          toolCalls: null,
        };
      }
    }
    return null;
  }

  // ── Percentiles ───────────────────────────────────────────────────────

  async getPercentiles(
    _ctx: TenantContext,
    params: PercentilesParams,
    filters?: AnalyticsFilter[],
  ): Promise<PercentilesResponse> {
    const dateRange = this.resolveDateRange(params);
    const pool = getMockDataPool();
    const filtered = filterByDateRange(pool.traces, dateRange.start, dateRange.end);
    const spans = applyFiltersToSpans(getGenerationSpans(filtered), filters);

    // Group spans by day
    const byDay = new Map<string, MockSpan[]>();
    for (const span of spans) {
      const dateStr = span.timestamp.toISOString().split('T')[0] as string;
      if (!byDay.has(dateStr)) byDay.set(dateStr, []);
      byDay.get(dateStr)!.push(span);
    }

    // Build data points for every day in range (even if no data)
    const totalDays = daysBetween(dateRange.start, dateRange.end);
    const data: PercentilePoint[] = [];
    const start = new Date(dateRange.start);

    for (let i = 0; i < totalDays; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().split('T')[0] as string;
      const daySpans = byDay.get(dateStr) ?? [];

      // Extract metric values
      const values = daySpans.map((s) => {
        switch (params.metric) {
          case 'latency': return s.durationMs;
          case 'inputTokens': return s.inputTokens;
          case 'outputTokens': return s.outputTokens;
          case 'totalTokens': return s.tokens;
          default: return s.durationMs;
        }
      }).sort((a, b) => a - b);

      data.push({
        timestamp: `${dateStr} 00:00:00`,
        p75: Math.round(percentile(values, 0.75)),
        p90: Math.round(percentile(values, 0.90)),
        p95: Math.round(percentile(values, 0.95)),
        p99: Math.round(percentile(values, 0.99)),
      });
    }

    return { metric: params.metric, data };
  }

  // ── Aggregate Requests ──────────────────────────────────────────────

  async getAggregateRequests(
    _ctx: TenantContext,
    params: AggregateRequestsParams,
  ): Promise<AggregateRequestsResponse> {
    // Reuse ranking data logic then paginate
    const dateRange: DateRange = {
      start: params.startDate || new Date(Date.now() - 30 * 86_400_000).toISOString().split('T')[0]!,
      end: params.endDate || new Date().toISOString().split('T')[0]!,
    };
    const ranking = await this.getRankingData(
      _ctx,
      dateRange,
      params.dimension,
      1000, // get all items
      params.filters,
    );

    // Sort
    const sortField = (params.sortField || 'requests') as keyof AggregateRequestsRow;
    const sortOrder = params.sortOrder || 'desc';
    const sorted = [...ranking.items].sort((a, b) => {
      const aVal = Number(a[sortField]) || 0;
      const bVal = Number(b[sortField]) || 0;
      return sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
    });

    const total = sorted.length;
    const page = sorted.slice(params.offset, params.offset + params.limit);

    return {
      items: page,
      total,
      limit: params.limit,
      offset: params.offset,
    };
  }

  // ── Requests ───────────────────────────────────────────────────────

  async getRequests(
    _ctx: TenantContext,
    params: RequestsParams,
  ): Promise<RequestsResponse> {
    const pool = getMockDataPool();
    const traces = filterByDateRange(pool.traces, params.startDate, params.endDate);
    let spans = getGenerationSpans(traces);

    if (params.model) {
      spans = spans.filter((s) => s.model === params.model);
    }
    if (params.userId) {
      spans = spans.filter((s) => s.userId === params.userId);
    }
    if (params.status) {
      spans = spans.filter((s) => s.status === params.status);
    }

    spans = applyFiltersToSpans(spans, params.filters);

    // Sort by timestamp DESC
    spans = [...spans].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const total = spans.length;
    const offset = params.offset;
    const limit = params.limit;
    const page = paginate(spans, offset, limit);

    const requests: RequestRecord[] = page.map((span) => ({
      id: span.id,
      tenantId: 'mock-tenant',
      appId: 'mock-app',
      cost: span.cost,
      promptTokens: span.inputTokens,
      completionTokens: span.outputTokens,
      latencyMs: span.durationMs,
      modelUsed: span.model ?? 'unknown',
      status: span.status,
      input: span.input,
      output: span.output || null,
      ts: span.timestamp.toISOString(),
      userId: span.userId ?? '',
      traceId: span.traceId,
      statusMessage: span.statusMessage,
      props: '',
    }));

    return { requests, total, limit, offset };
  }

  // ── Scores ────────────────────────────────────────────────────────────

  async getScores(
    _ctx: TenantContext,
    params: ScoresParams,
  ): Promise<ScoresResponse> {
    const pool = getMockDataPool();
    let scores = [...pool.scores];

    if (params.resourceId) {
      scores = scores.filter((s) => s.resourceId === params.resourceId);
    }
    if (params.name) {
      scores = scores.filter((s) => s.name === params.name);
    }
    if (params.source) {
      scores = scores.filter((s) => s.source === params.source);
    }
    if (params.startDate) {
      const startMs = new Date(params.startDate).getTime();
      scores = scores.filter((s) => s.createdAt.getTime() >= startMs);
    }
    if (params.endDate) {
      const endMs = new Date(params.endDate + 'T23:59:59.999Z').getTime();
      scores = scores.filter((s) => s.createdAt.getTime() <= endMs);
    }

    // Sort by createdAt DESC
    scores.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;
    const total = scores.length;
    const page = paginate(scores, offset, limit);

    const apiScores: Score[] = page.map((s) => ({
      id: s.id,
      resourceId: s.resourceId,
      name: s.name,
      score: s.score,
      label: s.label,
      reason: s.reason,
      source: s.source,
      createdAt: s.createdAt.toISOString(),
    }));

    return { scores: apiScores, total, limit, offset };
  }

  async getScoresBySpanIds(
    _ctx: TenantContext,
    spanIds: string[],
  ): Promise<Record<string, Score[]>> {
    const pool = getMockDataPool();
    const map: Record<string, Score[]> = {};

    for (const spanId of spanIds) {
      const scores = pool.scores.filter((s) => s.resourceId === spanId);
      if (scores.length > 0) {
        map[spanId] = scores.map((s) => ({
          id: s.id,
          resourceId: s.resourceId,
          name: s.name,
          score: s.score,
          label: s.label,
          reason: s.reason,
          source: s.source,
          createdAt: s.createdAt.toISOString(),
        }));
      }
    }

    return map;
  }

  async getScoreAggregations(
    _ctx: TenantContext,
    dateRange: DateRange,
  ): Promise<ScoreAggregationsResponse> {
    const pool = getMockDataPool();
    const startMs = new Date(dateRange.start).getTime();
    const endMs = new Date(dateRange.end + 'T23:59:59.999Z').getTime();

    const filtered = pool.scores.filter(
      (s) => s.createdAt.getTime() >= startMs && s.createdAt.getTime() <= endMs,
    );

    // Group by name
    const byName = new Map<string, number[]>();
    for (const score of filtered) {
      if (!byName.has(score.name)) byName.set(score.name, []);
      byName.get(score.name)!.push(score.score);
    }

    const aggregations: ScoreAggregation[] = [...byName.entries()].map(([name, vals]) => ({
      name,
      avgScore: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100,
      count: vals.length,
      minScore: Math.min(...vals),
      maxScore: Math.max(...vals),
    }));

    return { aggregations };
  }

  async getDistinctScoreNames(
    _ctx: TenantContext,
  ): Promise<ScoreNamesResponse> {
    const pool = getMockDataPool();
    const names = [...new Set(pool.scores.map((s) => s.name))].sort();
    return { names };
  }

  async detectScoreType(
    _ctx: TenantContext,
    _name: string,
  ): Promise<ScoreType> {
    return 'numeric';
  }

  async getScoreHistogram(
    _ctx: TenantContext,
    name: string,
    _dateRange: DateRange,
    _source?: string,
  ): Promise<ScoreHistogramResponse> {
    return {
      name,
      type: 'numeric',
      buckets: Array.from({ length: 10 }, (_, i) => ({
        bucket: i * 0.1,
        count: Math.floor(Math.random() * 50) + 5,
      })),
      categories: [],
    };
  }

  async getScoreTrend(
    _ctx: TenantContext,
    name: string,
    interval: ScoreTrendInterval,
    _dateRange: DateRange,
    _source?: string,
  ): Promise<ScoreTrendResponse> {
    const now = new Date();
    const points = Array.from({ length: 12 }, (_, i) => {
      const ts = new Date(now.getTime() - (11 - i) * 3600000);
      return {
        timestamp: ts.toISOString(),
        avgScore: Math.random() * 0.5 + 0.5,
        count: Math.floor(Math.random() * 100) + 10,
      };
    });
    return { name, interval, points };
  }

  async getScoreComparison(
    _ctx: TenantContext,
    nameA: string,
    nameB: string,
    _dateRange: DateRange,
    _source?: string,
  ): Promise<ScoreComparisonResponse> {
    return {
      nameA,
      nameB,
      type: 'boolean',
      matrix: [
        { labelA: 'true', labelB: 'true', count: 45 },
        { labelA: 'true', labelB: 'false', count: 12 },
        { labelA: 'false', labelB: 'true', count: 8 },
        { labelA: 'false', labelB: 'false', count: 35 },
      ],
      totalMatched: 100,
      totalA: 120,
      totalB: 110,
    };
  }

  async getScoreScatter(
    _ctx: TenantContext,
    nameA: string,
    nameB: string,
    _dateRange: DateRange,
    _source?: string,
  ): Promise<ScoreScatterResponse> {
    const points = Array.from({ length: 50 }, () => ({
      scoreA: Math.random() * 0.5 + 0.5,
      scoreB: Math.random() * 0.5 + 0.5,
    }));
    return { nameA, nameB, points, totalMatched: 50, totalA: 60, totalB: 55 };
  }

  async getDistinctMetadataKeys(
    _ctx: TenantContext,
  ): Promise<string[]> {
    return ['environment', 'version', 'customer_id'];
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private resolveDateRange(params: PercentilesParams): DateRange {
    if (params.range === 'custom' && params.startDate && params.endDate) {
      return { start: params.startDate, end: params.endDate };
    }

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0] as string;
    const daysBack: Record<string, number> = {
      today: 0,
      '7d': 7,
      '30d': 30,
      '90d': 90,
    };
    const days = daysBack[params.range] ?? 7;
    const start = new Date(now.getTime() - days * 86_400_000)
      .toISOString()
      .split('T')[0] as string;

    return { start, end: todayStr };
  }

  async getSpanKindBreakdown(): Promise<SpanKindBreakdownRecord[]> {
    return [
      { kind: 'llm', count: 450, avgLatencyMs: 1200, totalCost: 12.5, totalTokens: 500000 },
      { kind: 'function', count: 380, avgLatencyMs: 50, totalCost: 0, totalTokens: 0 },
      { kind: 'tool', count: 120, avgLatencyMs: 800, totalCost: 0.5, totalTokens: 10000 },
      { kind: 'retrieval', count: 95, avgLatencyMs: 200, totalCost: 0, totalTokens: 0 },
      { kind: 'embedding', count: 60, avgLatencyMs: 150, totalCost: 1.2, totalTokens: 80000 },
      { kind: 'agent', count: 30, avgLatencyMs: 5000, totalCost: 8.0, totalTokens: 300000 },
    ];
  }
}
