/**
 * Input Validation Schemas
 *
 * Zod schemas for API input validation.
 * Shared constants (enums, limits, field lists) are imported from @repo/api-schemas
 * so the dashboard and gateway reference the same validation rules.
 */

import { z } from 'zod';
import {
  TRACE_STATUS_VALUES,
  SORT_ORDERS,
  DATE_RANGE_PRESETS,
  PERCENTILE_METRICS,
  PAGINATION,
  MAX_DATE_RANGE_DAYS,
  ALLOWED_TRACE_SORT_FIELDS,
  FILTER_CONSTANTS,
} from '@repo/api-schemas';
import type { AnalyticsFilter } from './types';
import { ValidationError } from './errors';

// ============================================================================
// Validation Limits
// ============================================================================

/**
 * Maximum limits for query parameters.
 * Derived from shared constants in @repo/api-schemas.
 */
export const VALIDATION_LIMITS = {
  maxDateRangeDays: MAX_DATE_RANGE_DAYS,
  maxTracesLimit: PAGINATION.maxLimit,
  defaultTracesLimit: PAGINATION.defaultLimit,
  maxSessionsLimit: PAGINATION.maxSessionsLimit,
  defaultSessionsLimit: PAGINATION.defaultSessionsLimit,
  queryTimeoutSeconds: 30,
} as const;

// ============================================================================
// Common Schemas
// ============================================================================

// Internal helpers. These were exported pre-migration but their
// consumers moved to per-resource zod-schemas.ts modules. The ones
// retained below (`dateRangePresetSchema`, `isoDatePattern`,
// `isoDateTimeSchema`) are still referenced inside this file.
const dateRangePresetSchema = z.enum(DATE_RANGE_PRESETS);

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const isoDateTimePattern = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?)?$/;

const isoDateTimeSchema = z.string().regex(isoDateTimePattern, 'DateTime must be in ISO format');

// ============================================================================
// Date range with conditional validation helper
// ============================================================================

/**
 * Builds a schema for endpoints that use date range presets.
 * When range is 'custom', startDate and endDate are required.
 * Also validates that the date range doesn't exceed MAX_DATE_RANGE_DAYS.
 */
function dateRangePresetObject() {
  return z.object({
    range: dateRangePresetSchema,
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  }).superRefine((val, ctx) => {
    if (val.range === 'custom') {
      if (!val.startDate) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Start date is required for custom range', path: ['startDate'] });
      } else if (!isoDatePattern.test(val.startDate)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Date must be in YYYY-MM-DD format', path: ['startDate'] });
      }
      if (!val.endDate) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'End date is required for custom range', path: ['endDate'] });
      } else if (!isoDatePattern.test(val.endDate)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Date must be in YYYY-MM-DD format', path: ['endDate'] });
      }

      if (val.startDate && val.endDate && isoDatePattern.test(val.startDate) && isoDatePattern.test(val.endDate)) {
        const start = new Date(val.startDate);
        const end = new Date(val.endDate);
        const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);

        if (diffDays < 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'End date must be after start date', path: ['endDate'] });
        } else if (diffDays > MAX_DATE_RANGE_DAYS) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Date range cannot exceed ${MAX_DATE_RANGE_DAYS} days`, path: ['endDate'] });
        }
      }
    }
  });
}

// ============================================================================
// Metrics Validation
// ============================================================================

export const metricsParamsSchema = dateRangePresetObject();

export type MetricsParams = z.infer<typeof metricsParamsSchema>;

// ============================================================================
// Sort Validation
// ============================================================================

export const ALLOWED_SORT_FIELDS_TRACES = ALLOWED_TRACE_SORT_FIELDS;

// ============================================================================
// Traces Validation
// ============================================================================

const analyticsFilterSchema = z.object({
  field: z.string(),
  operator: z.string(),
  value: z.union([z.string(), z.array(z.string())]),
});

export const tracesParamsSchema = z.object({
  limit: z.coerce.number().int().min(1, 'Limit must be at least 1').max(PAGINATION.maxLimit, `Limit cannot exceed ${PAGINATION.maxLimit}`).default(PAGINATION.defaultLimit),
  offset: z.coerce.number().int().min(0, 'Offset must be non-negative').default(0),
  startDate: isoDateTimeSchema.optional(),
  endDate: isoDateTimeSchema.optional(),
  model: z.string().optional(),
  userId: z.string().optional(),
  status: z.enum(TRACE_STATUS_VALUES).optional(),
  filters: z.array(analyticsFilterSchema).max(10, 'Cannot apply more than 10 filters').optional(),
  sortBy: z.enum(ALLOWED_TRACE_SORT_FIELDS).optional(),
  sortOrder: z.enum(SORT_ORDERS).optional(),
});

export type TracesParamsValidated = z.infer<typeof tracesParamsSchema>;

// ============================================================================
// Percentiles Validation
// ============================================================================

export const percentilesParamsSchema = dateRangePresetObject().and(
  z.object({
    metric: z.enum(PERCENTILE_METRICS),
  })
);

export type PercentilesParamsValidated = z.infer<typeof percentilesParamsSchema>;

// ============================================================================
// Trace Detail Validation
// ============================================================================

export const traceIdSchema = z.string().min(1, 'Trace ID cannot be empty');

// ============================================================================
// Analytics Filter Parsing
// ============================================================================

export const ALLOWED_FILTER_FIELDS = FILTER_CONSTANTS.allowedFields;

export const ALLOWED_FILTER_OPERATORS = FILTER_CONSTANTS.allowedOperators;

const MAX_FILTER_VALUE_LENGTH = FILTER_CONSTANTS.maxValueLength;
const MAX_FILTERS_COUNT = FILTER_CONSTANTS.maxCount;
export const MIN_TEXT_SEARCH_LENGTH = FILTER_CONSTANTS.minTextSearchLength;

const TEXT_SEARCH_FIELDS = new Set(['input', 'output', 'props']);
const TEXT_SEARCH_OPERATORS = new Set([
  'contains', 'like', 'startswith', 'starts_with',
  'endswith', 'ends_with', 'notcontains', 'not_contains',
]);

/**
 * Parse and validate filters from query string.
 * Expects JSON-encoded array of filter objects.
 *
 * Security features:
 * - Whitelist of allowed field names
 * - Whitelist of allowed operators
 * - Maximum value length enforcement
 * - Maximum filter count enforcement
 *
 * @param filtersParam - JSON string of filters array
 * @returns Parsed and validated filters array
 * @throws ValidationError if filters are invalid
 */
export function parseFilters(filtersParam: string | undefined): AnalyticsFilter[] | undefined {
  if (!filtersParam) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(filtersParam);
  } catch {
    throw new ValidationError('Invalid filters format - must be valid JSON');
  }

  if (!Array.isArray(parsed)) {
    throw new ValidationError('Filters must be an array');
  }

  if (parsed.length > MAX_FILTERS_COUNT) {
    throw new ValidationError(`Maximum ${MAX_FILTERS_COUNT} filters allowed`);
  }

  const validatedFilters: AnalyticsFilter[] = [];
  const allowedFieldsSet = new Set<string>(ALLOWED_FILTER_FIELDS.map(f => f.toLowerCase()));
  const allowedOperatorsSet = new Set<string>(ALLOWED_FILTER_OPERATORS.map(o => o.toLowerCase()));

  for (const filter of parsed) {
    if (!filter || typeof filter !== 'object') {
      continue;
    }

    const field = filter.field;
    const value = filter.value;
    const operator = filter.operator || 'equals';

    if (typeof field !== 'string') {
      continue;
    }

    const fieldLower = field.toLowerCase();
    const isMetadataField = fieldLower.startsWith('metadata.') && /^metadata\.[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(field);
    const isScoreField = fieldLower.startsWith('score__') && /^score__[a-zA-Z_][a-zA-Z0-9_\-]{0,63}$/.test(fieldLower);
    if (!isMetadataField && !isScoreField && !allowedFieldsSet.has(fieldLower)) {
      continue;
    }

    const operatorLower = typeof operator === 'string' ? operator.toLowerCase() : 'equals';
    const validOperator = allowedOperatorsSet.has(operatorLower) ? operatorLower : 'equals';

    const isExistenceOperator = validOperator === 'exists' || validOperator === 'doesnotexist' || validOperator === 'does_not_exist';

    if (!isExistenceOperator && (value === undefined || value === null || value === '')) {
      continue;
    }

    const valueStr = isExistenceOperator ? '' : String(value);
    if (!isExistenceOperator && valueStr.length > MAX_FILTER_VALUE_LENGTH) {
      throw new ValidationError(`Filter value exceeds maximum length of ${MAX_FILTER_VALUE_LENGTH}`);
    }

    if (TEXT_SEARCH_FIELDS.has(fieldLower) && TEXT_SEARCH_OPERATORS.has(operatorLower)) {
      if (valueStr.length < MIN_TEXT_SEARCH_LENGTH) {
        throw new ValidationError(
          `Text search on "${field}" requires at least ${MIN_TEXT_SEARCH_LENGTH} characters`
        );
      }
    }

    validatedFilters.push({
      field: fieldLower,
      operator: validOperator,
      value: valueStr,
    });
  }

  return validatedFilters.length > 0 ? validatedFilters : undefined;
}

// ============================================================================
// Validation Helper
// ============================================================================

/**
 * Validates input against a Zod schema and returns validated data or throws.
 *
 * @param schema - Zod schema to validate against
 * @param data - Input data to validate
 * @returns Validated and transformed data
 * @throws ValidationError if validation fails
 */
export async function validateInput<S extends z.ZodType>(
  schema: S,
  data: unknown
): Promise<z.output<S>> {
  const result = schema.safeParse(data);
  if (result.success) {
    return result.data;
  }

  const details: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const path = issue.path.join('.');
    if (path) {
      details[path] = issue.message;
    }
  }

  const firstIssue = result.error.issues[0];
  const message = firstIssue?.message ?? 'Validation failed';
  const field = firstIssue?.path.join('.') || undefined;

  throw new ValidationError(
    message,
    field,
    Object.keys(details).length > 0 ? details : undefined
  );
}
