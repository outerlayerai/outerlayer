/**
 * The canonical span shape written to `otel_traces`, plus the message/tool-call
 * types its I/O fields carry. Producers convert their own model into
 * `NormalizedSpan`; `span-converter.ts` turns that into a ClickHouse row.
 */

export enum SpanType {
    SPAN = 'SPAN',
    GENERATION = 'GENERATION',
    EVENT = 'EVENT',
}

/**
 * Standard message content part types
 */
export interface StandardTextContent {
    type: 'text';
    text: string;
}

export interface StandardToolCallContent {
    type: 'tool-call';
    toolCallId: string;
    toolName: string;
    args: Record<string, any>;
}

export interface StandardToolResultContent {
    type: 'tool-result';
    toolCallId: string;
    toolName: string;
    result: any;
}

export type StandardMessageContent =
    | StandardTextContent
    | StandardToolCallContent
    | StandardToolResultContent
    | string;  // Plain string content

/**
 * Content can be:
 * - A plain string
 * - An array of content parts (text, tool-call, tool-result)
 */
export interface Message {
    role: string;
    content: StandardMessageContent | StandardMessageContent[];
}

export interface ToolCall {
    type: string;  // e.g., "tool-call"
    toolCallId: string;
    toolName: string;
    args: Record<string, any>;
    result?: string;  // Tool execution result (JSON string for tool call execution spans)
    providerMetadata?: Record<string, any>;
}

export interface NormalizedSpan {
    // Identity
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    traceState?: string;

    // Core type and classification
    type: SpanType;

    // Timing
    startTime: number; // Unix timestamp in milliseconds
    endTime?: number; // Unix timestamp in milliseconds
    duration: number; // Duration in milliseconds

    // Span metadata
    name: string;
    kind: string;
    semanticKind?: string;
    serviceName?: string;
    statusCode: string;
    statusMessage?: string;

    // Normalized LLM generation fields
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
    cost?: number;

    // I/O fields
    input?: Message[];  // Array of messages passed to the model
    output?: string;     // Plain text or JSON-stringified structured data
    outputObject?: Record<string, any>;  // Structured object output (separate from text)
    toolCalls?: ToolCall[];  // Tool calls from the response
    finishReason?: string;  // Unified finish reason (stop, tool-calls, length, etc.)
    settings?: {  // Model generation settings
        temperature?: number;
        maxTokens?: number;
        topP?: number;
        presencePenalty?: number;
        frequencyPenalty?: number;
    };

    // Trace context fields
    sessionId?: string;
    sessionName?: string;
    userId?: string;
    traceName?: string;

    /** Props/metadata carried through to the row's Props column. */
    props?: string;

    // Version control fields.
    // commitSha: deployed-commit notion (pinned envs override it gateway-side).
    // sourceTreeHash: git tree hash of the code state the run executed against —
    //   distinct from commitSha; the regression gate matches baselines on this.
    commitSha?: string;
    sourceTreeHash?: string;

    // Custom metadata fields (keys from metadata prefixes that don't map to known fields)
    metadata?: Record<string, string>;

    // Raw data for export/debug
    resourceAttributes: Record<string, any>;
    spanAttributes: Record<string, any>;
    events: Array<{ timestamp: number; name: string; attributes: Record<string, any> }>;
    links: Array<{ traceId: string; spanId: string; traceState?: string; attributes?: Record<string, any> }>;
}
