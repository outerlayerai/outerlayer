/**
 * DORA Metrics - Validation Schemas
 *
 * Zod schemas for DORA metrics API input validation.
 */

import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

/** Valid time range presets for DORA queries. */
const DORA_TIME_RANGES = ['7d', '30d', '90d'] as const;

/** Valid sort-by columns for the rankings endpoint. */
const DORA_SORT_BY_FIELDS = [
  'deploymentFrequency',
  'leadTime',
  'changeFailureRate',
  'mttr',
] as const;

/** Valid sort orders. */
const DORA_SORT_ORDERS = ['asc', 'desc'] as const;

/** Pattern for service filter values (alphanumeric, hyphens, underscores). */
const SERVICE_FILTER_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Milliseconds per day. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ============================================================================
// Query Schemas
// ============================================================================

/**
 * Schema for DORA metrics summary and trends endpoint query params.
 *
 * - `timeRange`: optional, defaults to '30d', must be one of '7d' | '30d' | '90d'
 * - `appId`: optional, nullable; when provided must be a valid service name
 */
export const doraMetricsQuerySchema = z.object({
  timeRange: z
    .enum(DORA_TIME_RANGES, { message: 'timeRange must be one of 7d, 30d, 90d' })
    .optional()
    .default('30d'),
  appId: z
    .string()
    .nullable()
    .optional()
    .refine(
      (value) => {
        if (value === null || value === undefined || value === '') return true;
        return SERVICE_FILTER_PATTERN.test(value);
      },
      { message: 'appId must be a valid service name (alphanumeric, hyphens, underscores)' }
    ),
});

/**
 * Schema for DORA rankings endpoint query params.
 *
 * - `timeRange`: optional, defaults to '30d', must be one of '7d' | '30d' | '90d'
 * - `sortBy`: optional, defaults to 'deploymentFrequency'
 * - `sortOrder`: optional, defaults to 'desc'
 */
export const doraRankingsQuerySchema = z.object({
  timeRange: z
    .enum(DORA_TIME_RANGES, { message: 'timeRange must be one of 7d, 30d, 90d' })
    .optional()
    .default('30d'),
  sortBy: z
    .enum(DORA_SORT_BY_FIELDS, {
      message: 'sortBy must be one of deploymentFrequency, leadTime, changeFailureRate, mttr',
    })
    .optional()
    .default('deploymentFrequency'),
  sortOrder: z
    .enum(DORA_SORT_ORDERS, { message: 'sortOrder must be one of asc, desc' })
    .optional()
    .default('desc'),
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Converts URLSearchParams to a plain object for schema validation.
 *
 * Only includes the first value for each key, matching the schema's flat-object shape.
 *
 * @param searchParams - The URLSearchParams to convert
 * @returns A plain object with string values
 */
export function parseSearchParams(searchParams: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = {};

  searchParams.forEach((value, key) => {
    // Only take the first occurrence of each key
    if (!(key in result)) {
      result[key] = value;
    }
  });

  return result;
}

/**
 * Resolves a time range string into concrete date boundaries for both the
 * current period and the previous comparison period.
 *
 * - `end` is the next UTC midnight (the exclusive upper bound of today).
 * - `start` is `end` minus N days.
 * - `previousEnd` equals `start`.
 * - `previousStart` is `previousEnd` minus N days.
 *
 * @param timeRange - One of '7d', '30d', '90d'
 * @returns Object with start, end, previousStart, previousEnd dates
 */
export function resolveTimeRange(timeRange: string): {
  start: Date;
  end: Date;
  previousStart: Date;
  previousEnd: Date;
} {
  const daysMap: Record<string, number> = {
    '7d': 7,
    '30d': 30,
    '90d': 90,
  };

  const days = daysMap[timeRange];
  if (days === undefined) {
    throw new Error(`Invalid time range: ${timeRange}. Must be one of 7d, 30d, 90d`);
  }

  const rangeMs = days * MS_PER_DAY;

  // End is the start of the NEXT day UTC so the current (partial) day is
  // included — a deploy recorded five minutes ago must show up now, not
  // after the next UTC midnight. (Caught in local e2e: with end at the
  // current day's start, freshly ingested events were invisible all day.)
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

  const start = new Date(end.getTime() - rangeMs);
  const previousEnd = new Date(start.getTime());
  const previousStart = new Date(previousEnd.getTime() - rangeMs);

  return { start, end, previousStart, previousEnd };
}
