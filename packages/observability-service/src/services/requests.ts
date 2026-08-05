/**
 * Requests Sub-Service
 *
 * Handles "requests" listing queries — individual LLM-call records
 * (GENERATION-type traces with input/output).
 */

import type { IClickHouseQuery } from '../client';
import { formatISOForClickHouse, getDefaultTracesStartDate, getCurrentDateForClickHouse } from '../date-utils';
import type {
  RequestsParams,
  RequestsResponse,
  RequestRecord,
} from '../types';
import type { TenantContext } from '../tenant-context';
import { buildFilterWhereClause, buildEnvironmentWhereClause, formatRetentionCutoff, QUERY_TIMEOUT_SETTINGS, toNumber } from '../shared';
import type { RawRequest } from '../shared';

export class RequestsService {
  constructor(private readonly client: IClickHouseQuery) {}

  async getRequests(ctx: TenantContext, params: RequestsParams): Promise<RequestsResponse> {
    const { appId, tenantId } = ctx;
    const dataRetentionDays = ctx.dataRetentionDays ?? -1;
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;
    const startDate = params.startDate
      ? formatISOForClickHouse(params.startDate)
      : getDefaultTracesStartDate();
    const endDate = params.endDate
      ? formatISOForClickHouse(params.endDate)
      : getCurrentDateForClickHouse();

    const filterResult = buildFilterWhereClause(params.filters, appId, tenantId);

    // Env scoping. Mirrors ScoresService / TracesService.
    // `otel_traces.Environment` already exists — no schema change required.
    const envClause = buildEnvironmentWhereClause('Environment', {
      environment: params.environment,
      environments: params.environments,
    });

    const listQuery = `
SELECT
  SpanId as id,
  TenantId as tenant_id,
  AppId as app_id,
  Cost as cost,
  InputTokens as prompt_tokens,
  OutputTokens as completion_tokens,
  Duration as latency_ms,
  Model as model_used,
  StatusCode as status,
  Input as input,
  Output as output,
  OutputObject as output_object,
  Timestamp as ts,
  UserId as user_id,
  TraceId as trace_id,
  StatusMessage as status_message,
  Props as props
FROM otel_traces FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Type = 'GENERATION'
  AND Timestamp >= {startDate:DateTime64}
  AND Timestamp <= {endDate:DateTime64}
  AND Timestamp >= {retentionCutoff:DateTime64(3)}
  ${filterResult.clause}
  ${envClause.clause}
ORDER BY Timestamp DESC
LIMIT {limit:UInt32}
OFFSET {offset:UInt32}
`;

    const countQuery = `
SELECT count(*) as total
FROM otel_traces FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Type = 'GENERATION'
  AND Timestamp >= {startDate:DateTime64}
  AND Timestamp <= {endDate:DateTime64}
  AND Timestamp >= {retentionCutoff:DateTime64(3)}
  ${filterResult.clause}
  ${envClause.clause}
`;

    const retentionCutoff = formatRetentionCutoff(dataRetentionDays);

    const queryParams = {
      appId,
      tenantId,
      startDate,
      endDate,
      retentionCutoff,
      limit,
      offset,
      ...filterResult.params,
      ...envClause.params,
    };

    const [listResult, countResult] = await Promise.all([
      this.client.query({
        query: listQuery,
        query_params: queryParams,
        clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
        format: 'JSONEachRow',
      }),
      this.client.query({
        query: countQuery,
        query_params: {
          appId,
          tenantId,
          startDate,
          endDate,
          retentionCutoff,
          ...filterResult.params,
          ...envClause.params,
        },
        clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
        format: 'JSONEachRow',
      }),
    ]);

    const rows = await listResult.json<RawRequest>();
    const countData = await countResult.json<{ total: string }>();

    return {
      requests: rows.map((row) => this.transformRequest(row)),
      total: parseInt(countData[0]?.total || '0', 10),
      limit,
      offset,
    };
  }

  private transformRequest(raw: RawRequest): RequestRecord {
    return {
      id: raw.id,
      tenantId: raw.tenant_id,
      appId: raw.app_id,
      cost: toNumber(raw.cost),
      promptTokens: toNumber(raw.prompt_tokens),
      completionTokens: toNumber(raw.completion_tokens),
      latencyMs: toNumber(raw.latency_ms),
      modelUsed: raw.model_used || '',
      status: raw.status || 'OK',
      input: raw.input || '',
      output: raw.output || raw.output_object || null,
      ts: raw.ts,
      userId: raw.user_id || '',
      traceId: raw.trace_id,
      statusMessage: raw.status_message || '',
      props: raw.props || '',
    };
  }
}
