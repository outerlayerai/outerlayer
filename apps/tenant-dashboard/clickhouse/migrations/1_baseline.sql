-- Baseline schema: every table, materialized view, projection, index, and
-- TTL for the analytics database, applied to a fresh instance in one step.
-- Data backfills from the pre-baseline history are omitted: a fresh
-- instance has nothing to backfill.

CREATE TABLE agent_blobs
(
    `TenantId` String,
    `AppId` String,
    `Sha256` String,
    `MediaType` LowCardinality(String),
    `Bytes` UInt32,
    `Data` String,
    `InsertedAt` DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(InsertedAt)
ORDER BY (TenantId, AppId, Sha256)
SETTINGS index_granularity = 8192;

CREATE TABLE agent_session_summary
(
    `TenantId` String,
    `AppId` String,
    `TraceId` String,
    `SessionId` String,
    `Title` String,
    `AgentType` LowCardinality(String),
    `ActorId` String,
    `GitRepo` String,
    `GitBranch` String,
    `CommitSha` String,
    `CaptureTier` LowCardinality(String),
    `StartedAt` DateTime64(3),
    `EndedAt` DateTime64(3),
    `TurnCount` UInt32,
    `ToolCallCount` UInt32,
    `ErrorCount` UInt32,
    `CostUsd` Float64,
    `Models` Array(String),
    `InsertedAt` DateTime DEFAULT now(),
    `PrNumber` UInt32 DEFAULT 0,
    `PrUrl` String DEFAULT '',
    `OutcomeCommitShas` Array(String) DEFAULT [],
    `WorkerKind` LowCardinality(String) DEFAULT '',
    `ParentSessionId` String DEFAULT '',
    `UserTurnCount` UInt32 DEFAULT 0,
    `RejectedToolCallCount` UInt32 DEFAULT 0,
    `PermissionPromptCount` UInt32 DEFAULT 0,
    `ApiErrorCount` UInt32 DEFAULT 0,
    `Origin` LowCardinality(String) DEFAULT '',
    `PrNumbers` Array(UInt32) DEFAULT [],
    `PrUrls` Array(String) DEFAULT [],
    `HookExecutionCount` UInt32 DEFAULT 0,
    `HookDurationMs` UInt64 DEFAULT 0,
    `HookUnreportedCount` UInt32 DEFAULT 0,
    `SlowestHookMs` UInt32 DEFAULT 0,
    `SlowestHookCommand` String DEFAULT ''
)
ENGINE = ReplacingMergeTree(InsertedAt)
ORDER BY (TenantId, AppId, GitRepo, StartedAt, TraceId)
SETTINGS index_granularity = 8192;

CREATE TABLE mcp_tool_use
(
    `TenantId` String,
    `AppId` String,
    `Server` String,
    `Tool` String,
    `Day` Date,
    `TraceId` String,
    `Calls` AggregateFunction(uniqExact, String),
    `LastUsedAt` SimpleAggregateFunction(max, DateTime64(9))
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(Day)
ORDER BY (TenantId, AppId, Server, Tool, Day, TraceId)
SETTINGS index_granularity = 8192;

CREATE TABLE otel_traces
(
    `Timestamp` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    `CreatedAt` DateTime DEFAULT now(),
    `TraceId` String CODEC(ZSTD(1)),
    `SpanId` String CODEC(ZSTD(1)),
    `ParentSpanId` String CODEC(ZSTD(1)),
    `TraceState` String CODEC(ZSTD(1)),
    `SpanName` LowCardinality(String) CODEC(ZSTD(1)),
    `SpanKind` LowCardinality(String) CODEC(ZSTD(1)),
    `ServiceName` LowCardinality(String) CODEC(ZSTD(1)),
    `ResourceAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `SpanAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `Duration` Int64 CODEC(ZSTD(1)),
    `StatusCode` LowCardinality(String) CODEC(ZSTD(1)),
    `StatusMessage` String CODEC(ZSTD(1)),
    `Events.Timestamp` Array(DateTime64(9)) CODEC(ZSTD(1)),
    `Events.Name` Array(LowCardinality(String)) CODEC(ZSTD(1)),
    `Events.Attributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `Links.TraceId` Array(String) CODEC(ZSTD(1)),
    `Links.SpanId` Array(String) CODEC(ZSTD(1)),
    `Links.TraceState` Array(String) CODEC(ZSTD(1)),
    `Links.Attributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `TenantId` String DEFAULT '',
    `AppId` String DEFAULT '',
    `StripeCustomerId` String DEFAULT '',
    `Type` Enum8('SPAN' = 0, 'GENERATION' = 1, 'EVENT' = 2) DEFAULT 'SPAN',
    `EndTime` DateTime64(9) DEFAULT toDateTime64(0, 9),
    `Model` LowCardinality(String) DEFAULT '',
    `InputTokens` UInt32 DEFAULT 0,
    `OutputTokens` UInt32 DEFAULT 0,
    `TotalTokens` UInt32 DEFAULT 0,
    `ReasoningTokens` UInt32 DEFAULT 0,
    `Cost` Float64 DEFAULT 0.,
    `Input` String DEFAULT '' CODEC(ZSTD(3)),
    `Output` String DEFAULT '' CODEC(ZSTD(3)),
    `OutputObject` String DEFAULT '' CODEC(ZSTD(3)),
    `ToolCalls` String DEFAULT '' CODEC(ZSTD(3)),
    `Settings` String DEFAULT '' CODEC(ZSTD(1)),
    `Props` String DEFAULT '' CODEC(ZSTD(3)),
    `FinishReason` LowCardinality(String) DEFAULT '',
    `SessionId` String DEFAULT '',
    `SessionName` LowCardinality(String) DEFAULT '',
    `UserId` String DEFAULT '',
    `TraceName` String DEFAULT '',
    `Metadata` Map(LowCardinality(String), String) DEFAULT map(),
    `CommitSha` String DEFAULT '',
    `Tags` Array(String) DEFAULT [],
    `UpdatedAt` DateTime64(3) DEFAULT now64(3),
    `IsDeleted` UInt8 DEFAULT 0,
    `Environment` String DEFAULT '',
    `EnvironmentVersion` UInt32 DEFAULT 0,
    `TraceSource` String DEFAULT 'production',
    `SourceTreeHash` String DEFAULT '',
    `BlobRefs` String DEFAULT '' CODEC(ZSTD(3)),
    `ActorId` String DEFAULT '' CODEC(ZSTD(1)),
    `CaptureTier` LowCardinality(String) DEFAULT '',
    `AgentType` LowCardinality(String) DEFAULT '',
    `PayloadBytes` UInt64 MATERIALIZED (((length(Input) + length(Output)) + length(toString(SpanAttributes))) + length(toString(ResourceAttributes))) + length(toString(Metadata)),
    INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_span_attr_key mapKeys(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_span_attr_value mapValues(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_duration Duration TYPE minmax GRANULARITY 1,
    INDEX idx_metadata_keys mapKeys(Metadata) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_input_ngram Input TYPE ngrambf_v1(4, 256, 2, 0) GRANULARITY 1,
    INDEX idx_output_ngram Output TYPE ngrambf_v1(4, 256, 2, 0) GRANULARITY 1,
    INDEX idx_tags Tags TYPE bloom_filter GRANULARITY 4,
    INDEX idx_session_id SessionId TYPE bloom_filter GRANULARITY 4,
    INDEX idx_span_kind SpanKind TYPE bloom_filter GRANULARITY 4,
    INDEX idx_actor_id ActorId TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_created_at CreatedAt TYPE minmax GRANULARITY 1,
    PROJECTION proj_hourly
    (
        SELECT
            AppId,
            toDate(Timestamp) AS date,
            toHour(Timestamp) AS hour,
            count() AS requests,
            countIf(StatusCode NOT IN ('2', 'STATUS_CODE_ERROR', 'ERROR', 'Error')) AS successes,
            countIf(StatusCode IN ('2', 'STATUS_CODE_ERROR', 'ERROR', 'Error')) AS errors,
            sum(Cost) AS cost,
            sum(TotalTokens) AS tokens,
            sum(InputTokens) AS input_tokens,
            sum(OutputTokens) AS output_tokens,
            sum(Duration) AS duration_ms,
            uniq(UserId) AS unique_users
        GROUP BY
            AppId,
            date,
            hour
    ),
    PROJECTION proj_by_model
    (
        SELECT
            AppId,
            toDate(Timestamp) AS date,
            toHour(Timestamp) AS hour,
            Model,
            count() AS requests,
            countIf(StatusCode NOT IN ('2', 'STATUS_CODE_ERROR', 'ERROR', 'Error')) AS successes,
            countIf(StatusCode IN ('2', 'STATUS_CODE_ERROR', 'ERROR', 'Error')) AS errors,
            sum(Cost) AS cost,
            sum(TotalTokens) AS tokens,
            sum(InputTokens) AS input_tokens,
            sum(OutputTokens) AS output_tokens,
            sum(Duration) AS duration_ms,
            uniq(UserId) AS unique_users
        GROUP BY
            AppId,
            date,
            hour,
            Model
    ),
    PROJECTION proj_by_user
    (
        SELECT
            AppId,
            toDate(Timestamp) AS date,
            UserId,
            count() AS requests,
            countIf(StatusCode NOT IN ('2', 'STATUS_CODE_ERROR', 'ERROR', 'Error')) AS successes,
            countIf(StatusCode IN ('2', 'STATUS_CODE_ERROR', 'ERROR', 'Error')) AS errors,
            sum(Cost) AS cost,
            sum(TotalTokens) AS tokens,
            sum(InputTokens) AS input_tokens,
            sum(OutputTokens) AS output_tokens,
            sum(Duration) AS duration_ms
        GROUP BY
            AppId,
            date,
            UserId
    ),
    PROJECTION proj_by_status
    (
        SELECT
            AppId,
            toDate(Timestamp) AS date,
            toHour(Timestamp) AS hour,
            StatusCode,
            count() AS requests,
            sum(Cost) AS cost,
            sum(TotalTokens) AS tokens,
            sum(InputTokens) AS input_tokens,
            sum(OutputTokens) AS output_tokens,
            sum(Duration) AS duration_ms,
            uniq(UserId) AS unique_users
        GROUP BY
            AppId,
            date,
            hour,
            StatusCode
    ),
    PROJECTION proj_model_stats
    (
        SELECT
            AppId,
            toDate(Timestamp) AS date,
            Model,
            count() AS requests,
            countIf(StatusCode NOT IN ('2', 'STATUS_CODE_ERROR', 'ERROR', 'Error')) AS successes,
            countIf(StatusCode IN ('2', 'STATUS_CODE_ERROR', 'ERROR', 'Error')) AS errors,
            sum(Cost) AS cost,
            sum(TotalTokens) AS tokens,
            sum(InputTokens) AS input_tokens,
            sum(OutputTokens) AS output_tokens,
            sum(Duration) AS duration_ms
        GROUP BY
            AppId,
            date,
            Model
    )
)
ENGINE = ReplacingMergeTree(UpdatedAt, IsDeleted)
PARTITION BY toDate(Timestamp)
PRIMARY KEY (TenantId, AppId, toUnixTimestamp(Timestamp))
ORDER BY (TenantId, AppId, toUnixTimestamp(Timestamp), TraceId, SpanId)
SETTINGS index_granularity = 8192, deduplicate_merge_projection_mode = 'rebuild', ttl_only_drop_parts = 1;

CREATE TABLE otel_traces_trace_id_ts
(
    `TenantId` String,
    `AppId` String,
    `TraceId` String CODEC(ZSTD(1)),
    `Start` SimpleAggregateFunction(min, DateTime64(9)),
    `End` SimpleAggregateFunction(max, DateTime64(9)),
    `CreatedAt` SimpleAggregateFunction(max, DateTime) DEFAULT now()
)
ENGINE = AggregatingMergeTree
PARTITION BY tuple()
ORDER BY (TenantId, AppId, TraceId)
SETTINGS index_granularity = 8192;

CREATE TABLE scores
(
    `Id` String,
    `TenantId` String,
    `AppId` String,
    `Score` Float64,
    `Label` String,
    `Reason` String,
    `ResourceId` String,
    `Name` String,
    `Type` String DEFAULT '',
    `DataType` String DEFAULT '',
    `Source` String DEFAULT 'eval',
    `UserId` String DEFAULT '',
    `CreatedAt` DateTime64(3) DEFAULT now64(3),
    `UpdatedAt` DateTime64(3) DEFAULT now64(3),
    `IsDeleted` UInt8 DEFAULT 0,
    `Environment` String DEFAULT '',
    `EnvironmentVersion` UInt32 DEFAULT 0,
    `CommitSha` String DEFAULT '',
    INDEX idx_id Id TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_resource_id ResourceId TYPE bloom_filter(0.001) GRANULARITY 1
)
ENGINE = ReplacingMergeTree(UpdatedAt, IsDeleted)
PARTITION BY toYYYYMM(CreatedAt)
PRIMARY KEY (TenantId, AppId, toDate(CreatedAt), Name)
ORDER BY (TenantId, AppId, toDate(CreatedAt), Name, Id)
SETTINGS index_granularity = 8192;

CREATE TABLE skill_activation_by_day
(
    `TenantId` String,
    `AppId` String,
    `Skill` String,
    `Day` Date,
    `Activations` AggregateFunction(uniqExact, String, String, UInt32),
    `Sessions` AggregateFunction(uniqExact, String),
    `LastActivatedAt` SimpleAggregateFunction(max, DateTime64(9))
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(Day)
ORDER BY (TenantId, AppId, Skill, Day)
SETTINGS index_granularity = 8192;

CREATE TABLE skill_activation_sessions
(
    `TenantId` String,
    `AppId` String,
    `Skill` String,
    `Day` Date,
    `TraceId` String,
    `Activations` AggregateFunction(uniqExact, String, UInt32),
    `LastActivatedAt` SimpleAggregateFunction(max, DateTime64(9))
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(Day)
ORDER BY (TenantId, AppId, Skill, Day, TraceId)
SETTINGS index_granularity = 8192;

CREATE TABLE trace_facets
(
    `TenantId` String,
    `AppId` String,
    `Environment` String DEFAULT '',
    `TraceId` String,
    `Facet` LowCardinality(String),
    `Summary` String DEFAULT '',
    `Label` LowCardinality(String) DEFAULT '',
    `Embedding` Array(Float32) DEFAULT [],
    `EmbeddingModel` String DEFAULT '',
    `TopicId` String DEFAULT '',
    `TopicDistance` Float32 DEFAULT 0,
    `MapVersion` UInt32 DEFAULT 0,
    `Status` LowCardinality(String) DEFAULT 'ok',
    `Error` String DEFAULT '',
    `CreatedAt` DateTime64(3) DEFAULT now64(3),
    `UpdatedAt` DateTime64(3) DEFAULT now64(3),
    `IsDeleted` UInt8 DEFAULT 0,
    `ItemIndex` UInt16,
    `ExtractorVersion` UInt16 DEFAULT 0,
    INDEX idx_facets_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_facets_topic_id TopicId TYPE bloom_filter(0.001) GRANULARITY 1
)
ENGINE = ReplacingMergeTree(UpdatedAt, IsDeleted)
PARTITION BY toYYYYMM(CreatedAt)
PRIMARY KEY (TenantId, AppId, Environment, Facet)
ORDER BY (TenantId, AppId, Environment, Facet, TraceId, ItemIndex)
SETTINGS index_granularity = 8192;

CREATE TABLE trace_topic_maps
(
    `TenantId` String,
    `AppId` String,
    `Environment` String DEFAULT '',
    `Facet` LowCardinality(String),
    `MapVersion` UInt32,
    `TopicId` String,
    `Name` String DEFAULT '',
    `Description` String DEFAULT '',
    `Centroid` Array(Float32) DEFAULT [],
    `MemberCount` UInt32 DEFAULT 0,
    `Params` String DEFAULT '',
    `GeneratedAt` DateTime64(3) DEFAULT now64(3),
    `CreatedAt` DateTime64(3) DEFAULT now64(3),
    `UpdatedAt` DateTime64(3) DEFAULT now64(3),
    `IsDeleted` UInt8 DEFAULT 0,
    `ErrorRate` Float64 DEFAULT 0,
    `AvgLatencyMs` Float64 DEFAULT 0,
    `AvgCostUsd` Float64 DEFAULT 0
)
ENGINE = ReplacingMergeTree(UpdatedAt, IsDeleted)
PARTITION BY toYYYYMM(CreatedAt)
PRIMARY KEY (TenantId, AppId, Environment, Facet, MapVersion)
ORDER BY (TenantId, AppId, Environment, Facet, MapVersion, TopicId)
TTL toDateTime(CreatedAt) + toIntervalDay(90)
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW mcp_tool_use_mv TO mcp_tool_use
(
    `TenantId` String,
    `AppId` String,
    `Server` String,
    `Tool` String,
    `Day` Date,
    `TraceId` String,
    `Calls` AggregateFunction(uniqExact, String),
    `LastUsedAt` DateTime64(9)
)
AS SELECT
    TenantId,
    AppId,
    parts[2] AS Server,
    arrayStringConcat(arraySlice(parts, 3), '__') AS Tool,
    toDate(Timestamp) AS Day,
    TraceId,
    uniqExactState(SpanId) AS Calls,
    max(Timestamp) AS LastUsedAt
FROM otel_traces
ARRAY JOIN [splitByString('__', substring(SpanName, 12))] AS parts
WHERE startsWith(SpanName, 'agent.tool.mcp__') AND (length(parts) >= 3) AND ((parts[2]) != '')
GROUP BY
    TenantId,
    AppId,
    Server,
    Tool,
    Day,
    TraceId;

CREATE MATERIALIZED VIEW otel_traces_trace_id_ts_mv TO otel_traces_trace_id_ts
(
    `TenantId` String,
    `AppId` String,
    `TraceId` String,
    `Start` DateTime64(9),
    `End` DateTime64(9)
)
AS SELECT
    TenantId,
    AppId,
    TraceId,
    min(Timestamp) AS Start,
    max(Timestamp) AS End
FROM otel_traces
WHERE IsDeleted = 0
GROUP BY
    TenantId,
    AppId,
    TraceId;

CREATE MATERIALIZED VIEW skill_activation_by_day_mv TO skill_activation_by_day
(
    `TenantId` String,
    `AppId` String,
    `Skill` String,
    `Day` Date,
    `Activations` AggregateFunction(uniqExact, String, String, UInt32),
    `Sessions` AggregateFunction(uniqExact, String),
    `LastActivatedAt` DateTime64(9)
)
AS SELECT
    TenantId,
    AppId,
    eventAttr['skill'] AS Skill,
    toDate(eventTime) AS Day,
    uniqExactState(TraceId, SpanId, eventIdx) AS Activations,
    uniqExactState(TraceId) AS Sessions,
    max(eventTime) AS LastActivatedAt
FROM otel_traces
ARRAY JOIN
    `Events.Name` AS eventName,
    `Events.Timestamp` AS eventTime,
    `Events.Attributes` AS eventAttr,
    arrayEnumerate(`Events.Name`) AS eventIdx
WHERE (SpanName = 'agent.session') AND (eventName = 'skill_activated') AND ((eventAttr['skill']) != '')
GROUP BY
    TenantId,
    AppId,
    Skill,
    Day;

CREATE MATERIALIZED VIEW skill_activation_sessions_mv TO skill_activation_sessions
(
    `TenantId` String,
    `AppId` String,
    `Skill` String,
    `Day` Date,
    `TraceId` String,
    `Activations` AggregateFunction(uniqExact, String, UInt32),
    `LastActivatedAt` DateTime64(9)
)
AS SELECT
    TenantId,
    AppId,
    eventAttr['skill'] AS Skill,
    toDate(eventTime) AS Day,
    TraceId,
    uniqExactState(SpanId, eventIdx) AS Activations,
    max(eventTime) AS LastActivatedAt
FROM otel_traces
ARRAY JOIN
    `Events.Name` AS eventName,
    `Events.Timestamp` AS eventTime,
    `Events.Attributes` AS eventAttr,
    arrayEnumerate(`Events.Name`) AS eventIdx
WHERE (SpanName = 'agent.session') AND (eventName = 'skill_activated') AND ((eventAttr['skill']) != '')
GROUP BY
    TenantId,
    AppId,
    Skill,
    Day,
    TraceId;

