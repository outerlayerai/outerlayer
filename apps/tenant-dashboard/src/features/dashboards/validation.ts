/**
 * Dashboard Validation Schemas
 *
 * Zod schemas for API input validation, matching the constraints
 * defined in the API contracts.
 */

import { z } from 'zod';
import { ENV_NAME_PATTERN } from '@repo/environments-service';
import {
  ALL_METRIC_IDS,
  VISUALIZATION_TYPES,
  PROMOTED_FILTER_FIELDS,
  MAX_DASHBOARD_NAME_LENGTH,
  MAX_DASHBOARD_DESCRIPTION_LENGTH,
  MAX_WIDGET_TITLE_LENGTH,
  isStatOnlyMetric,
} from './types';

/**
 * `active_actor_count` (and any future stat-only metric) MUST render as a
 * bare number — a ranking/bar/line view would invite a per-actor
 * breakdown. Shared by create + update so the two schemas can't drift.
 * Note: this only catches the inconsistency within ONE payload (e.g. a
 * create that sets both fields, or a patch that sets both together) — a
 * patch that changes only `visualization` on an existing
 * `active_actor_count` widget isn't caught here (no DB read at the schema
 * layer). See the privacy constraint test for what IS mechanically enforced.
 */
function refineStatOnlyVisualization(
  data: { metric?: string; visualization?: string },
  ctx: z.RefinementCtx,
): void {
  if (data.metric && isStatOnlyMetric(data.metric) && data.visualization && data.visualization !== 'stat') {
    ctx.addIssue({
      code: 'custom',
      message: `${data.metric} must use the "stat" visualization`,
      path: ['visualization'],
    });
  }
}

// ============================================================================
// Shared Schemas
// ============================================================================

/**
 * Validates filter field: must be a promoted field ('model', 'user_id', 'status')
 * or a metadata key ('metadata.<key>' where key is 1-64 alphanumeric/underscore chars).
 */
const METADATA_FIELD_PATTERN = /^metadata\.[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

const VALUE_LESS_OPERATORS = new Set(['exists', 'doesNotExist', 'doesnotexist', 'does_not_exist']);

/** z.enum needs a non-empty string tuple; the metric/visualization lists are typed `readonly T[]`. */
const asEnumValues = <T extends string>(values: readonly T[]): [T, ...T[]] =>
  values as unknown as [T, ...T[]];

/** Shared groupBy membership check (null/undefined/'' allowed; else a known field or metadata.<key>). */
const isValidGroupBy = (value: string | null | undefined): boolean => {
  if (value === null || value === undefined || value === '') return true;
  if (['model', 'user_id', 'time_period'].includes(value)) return true;
  return METADATA_FIELD_PATTERN.test(value);
};

const widgetFilterSchema = z
  .object({
    field: z
      .string()
      .min(1, 'Filter field is required')
      .refine(
        (value) => {
          if (!value) return false;
          if ((PROMOTED_FILTER_FIELDS as readonly string[]).includes(value)) return true;
          return METADATA_FIELD_PATTERN.test(value);
        },
        { message: 'Filter field must be a promoted field (model, user_id, status) or metadata.<key>' }
      ),
    operator: z.string().min(1, 'Filter operator is required'),
    value: z.string().optional().default(''),
  })
  .superRefine((data, ctx) => {
    // Value is required unless the operator is existence-based (value-less).
    if (!VALUE_LESS_OPERATORS.has(data.operator) && !data.value) {
      ctx.addIssue({ code: 'custom', message: 'Filter value is required', path: ['value'] });
    }
  });

const layoutItemSchema = z.object({
  widgetId: z.string().min(1),
  x: z.number().min(0),
  y: z.number().min(0),
  w: z.number().min(1).max(12),
  h: z.number().min(1),
});

/**
 * Widget env config. `inherit` follows the dashboard
 * env; `override` requires a non-empty env-name list (multiple entries =
 * cross-env comparison widget). `ENV_NAME_PATTERN` is shared from
 * `@repo/environments-service`.
 */
const widgetEnvironmentConfigSchema = z
  .object({
    mode: z.enum(['inherit', 'override'], { message: 'Invalid env mode' }),
    environments: z
      .array(z.string().regex(ENV_NAME_PATTERN, 'Invalid environment name'))
      .optional(),
  })
  .superRefine((data, ctx) => {
    // `override` mode must list at least one environment.
    if (data.mode === 'override' && (!data.environments || data.environments.length < 1)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Override env config must list at least one environment',
        path: ['environments'],
      });
    }
  });

// ============================================================================
// Dashboard Schemas
// ============================================================================

export const createDashboardSchema = z.object({
  name: z
    .string()
    .min(1, 'Dashboard name is required')
    .max(
      MAX_DASHBOARD_NAME_LENGTH,
      `Dashboard name must be at most ${MAX_DASHBOARD_NAME_LENGTH} characters`
    ),
  description: z
    .string()
    .max(
      MAX_DASHBOARD_DESCRIPTION_LENGTH,
      `Description must be at most ${MAX_DASHBOARD_DESCRIPTION_LENGTH} characters`
    )
    .nullable()
    .optional(),
  isDefault: z.boolean().optional(),
  templateId: z.string().optional(),
});

export const updateDashboardSchema = z.object({
  name: z
    .string()
    .max(
      MAX_DASHBOARD_NAME_LENGTH,
      `Dashboard name must be at most ${MAX_DASHBOARD_NAME_LENGTH} characters`
    )
    .optional(),
  description: z
    .string()
    .max(
      MAX_DASHBOARD_DESCRIPTION_LENGTH,
      `Description must be at most ${MAX_DASHBOARD_DESCRIPTION_LENGTH} characters`
    )
    .nullable()
    .optional(),
  isDefault: z.boolean().optional(),
  globalTimeRange: z.string().optional(),
  layout: z.array(layoutItemSchema).optional(),
});

// ============================================================================
// Widget Schemas
// ============================================================================

export const createWidgetSchema = z.object({
  title: z
    .string()
    .min(1, 'Widget title is required')
    .max(
      MAX_WIDGET_TITLE_LENGTH,
      `Widget title must be at most ${MAX_WIDGET_TITLE_LENGTH} characters`
    ),
  metric: z
    .string()
    .min(1, 'Widget metric is required')
    .refine((value) => (ALL_METRIC_IDS as readonly string[]).includes(value), {
      message: 'Invalid metric type',
    }),
  visualization: z
    .enum(asEnumValues(VISUALIZATION_TYPES), { message: 'Invalid visualization type' })
    .optional()
    .default('line'),
  filters: z.array(widgetFilterSchema).optional().default([]),
  groupBy: z
    .string()
    .nullable()
    .optional()
    .default(null)
    .refine(isValidGroupBy, {
      message: 'groupBy must be model, user_id, time_period, or metadata.<key>',
    }),
  timeGranularity: z
    .enum(['hour', 'day', 'auto'], { message: 'Invalid time granularity' })
    .optional()
    .default('auto'),
  scoreName: z.string().optional(),
  scoreNameB: z.string().optional(),
  environmentConfig: widgetEnvironmentConfigSchema.optional(),
}).superRefine(refineStatOnlyVisualization);

export const updateWidgetSchema = z.object({
  title: z
    .string()
    .max(
      MAX_WIDGET_TITLE_LENGTH,
      `Widget title must be at most ${MAX_WIDGET_TITLE_LENGTH} characters`
    )
    .optional(),
  metric: z
    .string()
    .refine((value) => (ALL_METRIC_IDS as readonly string[]).includes(value), {
      message: 'Invalid metric type',
    })
    .optional(),
  visualization: z
    .enum(asEnumValues(VISUALIZATION_TYPES), { message: 'Invalid visualization type' })
    .optional(),
  filters: z.array(widgetFilterSchema).optional(),
  groupBy: z
    .string()
    .nullable()
    .refine(isValidGroupBy, {
      message: 'groupBy must be model, user_id, time_period, or metadata.<key>',
    })
    .optional(),
  timeGranularity: z
    .enum(['hour', 'day', 'auto'], { message: 'Invalid time granularity' })
    .optional(),
  environmentConfig: widgetEnvironmentConfigSchema.optional(),
}).superRefine(refineStatOnlyVisualization);

// ============================================================================
// Widget Data Schema
// ============================================================================

/**
 * A custom range is two parseable instants, in order.
 *
 * Both bounds are converted to a ClickHouse Date downstream by a helper that
 * throws on anything it cannot parse, so a bare `z.string()` here turns a bad
 * request into a 500 instead of the 400 it is. The accepted shapes mirror that
 * helper exactly: a `YYYY-MM-DD` calendar date, or any string `Date` parses.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const toInstant = (value: string): number | null => {
  if (ISO_DATE.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    // Rejects a well-shaped non-date such as 2026-02-30, which `Date` rolls
    // forward rather than refusing.
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      return null;
    }
    return parsed.getTime();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
};

const isParseableInstant = (value: string) => toInstant(value) !== null;

const timeRangeSchema = z
  .object({
    preset: z
      .enum(['24h', '7d', '30d', '90d'], { message: 'Invalid time range preset' })
      .optional(),
    start: z
      .string()
      .refine(isParseableInstant, { message: 'start must be a date or ISO datetime' })
      .optional(),
    end: z
      .string()
      .refine(isParseableInstant, { message: 'end must be a date or ISO datetime' })
      .optional(),
  })
  .refine(
    (value) => {
      if (!value) return false;
      if (value.preset) return true;
      return Boolean(value.start && value.end);
    },
    { message: 'Either preset or both start and end dates are required' }
  )
  .refine(
    (value) => {
      if (!value.start || !value.end) return true;
      const start = toInstant(value.start);
      const end = toInstant(value.end);
      // A shape failure is already reported by the field refinements above.
      if (start === null || end === null) return true;
      return start <= end;
    },
    { message: 'start must not be after end' }
  );

export const widgetDataRequestSchema = z.object({
  metric: z
    .string()
    .min(1, 'Metric is required')
    .refine((value) => (ALL_METRIC_IDS as readonly string[]).includes(value), {
      message: 'Invalid metric type',
    }),
  filters: z.array(widgetFilterSchema).optional().default([]),
  groupBy: z
    .string()
    .nullable()
    .optional()
    .default(null)
    .refine(isValidGroupBy, {
      message: 'groupBy must be model, user_id, time_period, or metadata.<key>',
    }),
  timeGranularity: z
    .enum(['hour', 'day', 'auto'], { message: 'Invalid time granularity' })
    .optional()
    .default('auto'),
  scoreName: z.string().optional(),
  scoreNameB: z.string().optional(),
  // The dashboard view resolves each widget's
  // env scope (inherit vs override) and sends the concrete env name list.
  environments: z
    .array(z.string().regex(ENV_NAME_PATTERN, 'Invalid environment name'))
    .optional(),
  environmentIsDefault: z.boolean().optional(),
  // Fleet/PR query scope: 'app' (default — the app's dominant repo) or 'org'
  // (tenant-wide rollup, the Executive Overview's org toggle). Only widens
  // which of the VERIFIED tenant's rows are swept — never crosses tenants.
  scope: z.enum(['app', 'org']).optional(),
  timeRange: timeRangeSchema,
});
