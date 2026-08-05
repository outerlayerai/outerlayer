/**
 * Zod schemas for the dashboards domain.
 *
 * Two audiences:
 *   1. `authorizedAction` server actions (`./actions.ts`) — the flat
 *      per-mutation input schemas below extend these field-level schemas
 *      with the `appId`/`dashboardId`/`widgetId` an action's single JS-object
 *      argument carries alongside the body fields.
 *   2. (Future) react-hook-form via `zodResolver`, for forms currently backed
 *      by the Yup schemas in `./validation.ts`. Not part of this slice; Yup
 *      and Zod coexist until that migration is tackled separately.
 *
 * These schemas live in the app (not `@repo/api-schemas`) because the
 * dashboard surface is not a public API — only the dashboard UI consumes it.
 */

import { z } from 'zod';
import { ENV_NAME_PATTERN } from '@repo/environments-service';
import {
  MAX_DASHBOARD_NAME_LENGTH,
  MAX_DASHBOARD_DESCRIPTION_LENGTH,
  MAX_WIDGET_TITLE_LENGTH,
  ALL_METRIC_IDS,
  VISUALIZATION_TYPES,
  PROMOTED_FILTER_FIELDS,
  isStatOnlyMetric,
} from './types';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Matches `metadata.<key>` where `<key>` is 1–64 chars of
 * `[a-zA-Z_][a-zA-Z0-9_]`. Same pattern the Yup schema enforces today.
 */
const METADATA_FIELD_PATTERN = /^metadata\.[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

/** Filter operators that don't require a `value` ("exists" / "doesNotExist"). */
const VALUE_LESS_OPERATORS = new Set([
  'exists',
  'doesNotExist',
  'doesnotexist',
  'does_not_exist',
]);

const WidgetFilterSchema = z
  .object({
    field: z.string().refine(
      (v) =>
        (PROMOTED_FILTER_FIELDS as readonly string[]).includes(v) ||
        METADATA_FIELD_PATTERN.test(v),
      'Filter field must be a promoted field (model, user_id, status) or metadata.<key>',
    ),
    operator: z.string().min(1, 'Filter operator is required'),
    value: z.string().optional().default(''),
  })
  .refine(
    (v) => VALUE_LESS_OPERATORS.has(v.operator) || v.value.length > 0,
    {
      message: 'Filter value is required for this operator',
      path: ['value'],
    },
  );

const GroupBySchema = z
  .string()
  .nullish()
  .refine(
    (v) =>
      v === null ||
      v === undefined ||
      v === '' ||
      ['model', 'user_id', 'time_period'].includes(v) ||
      METADATA_FIELD_PATTERN.test(v),
    'groupBy must be model, user_id, time_period, or metadata.<key>',
  );

const TimeGranularitySchema = z.enum(['hour', 'day', 'auto']);
const MetricIdSchema = z
  .string()
  .refine((v) => ALL_METRIC_IDS.includes(v), 'Invalid metric type');
const VisualizationSchema = z.enum(VISUALIZATION_TYPES);

/**
 * `active_actor_count` (and any future stat-only metric) MUST render as a
 * bare number — see `validation.ts`'s `refineStatOnlyVisualization` for the
 * full rationale (this is the `withApi`-route counterpart of the same rule).
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

/**
 * Widget env config. `inherit` follows the dashboard
 * env; `override` carries a 1..N env-name list (multiple = cross-env
 * comparison). Env names follow `ENV_NAME_PATTERN`,
 * shared from `@repo/environments-service`).
 */
const WidgetEnvironmentConfigSchema = z
  .object({
    mode: z.enum(['inherit', 'override']),
    environments: z.array(z.string().regex(ENV_NAME_PATTERN)).optional(),
  })
  .refine(
    (v) => v.mode === 'inherit' || (v.environments?.length ?? 0) > 0,
    {
      message: 'Override env config must list at least one environment',
      path: ['environments'],
    },
  );

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const CreateDashboardBodySchema = z.object({
  name: z
    .string()
    .min(1, 'Dashboard name is required')
    .max(
      MAX_DASHBOARD_NAME_LENGTH,
      `Dashboard name must be at most ${MAX_DASHBOARD_NAME_LENGTH} characters`,
    ),
  description: z
    .string()
    .max(
      MAX_DASHBOARD_DESCRIPTION_LENGTH,
      `Description must be at most ${MAX_DASHBOARD_DESCRIPTION_LENGTH} characters`,
    )
    .nullish(),
  isDefault: z.boolean().optional(),
  templateId: z.string().optional(),
});

const LayoutItemSchema = z.object({
  widgetId: z.string().min(1),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1),
});

// ---------------------------------------------------------------------------
// Widget request/response schemas
// ---------------------------------------------------------------------------

export const CreateWidgetBodySchema = z.object({
  title: z
    .string()
    .min(1, 'Widget title is required')
    .max(
      MAX_WIDGET_TITLE_LENGTH,
      `Widget title must be at most ${MAX_WIDGET_TITLE_LENGTH} characters`,
    ),
  metric: MetricIdSchema,
  visualization: VisualizationSchema.optional().default('line'),
  filters: z.array(WidgetFilterSchema).optional().default([]),
  groupBy: GroupBySchema,
  timeGranularity: TimeGranularitySchema.optional().default('auto'),
  scoreName: z.string().optional(),
  scoreNameB: z.string().optional(),
  environmentConfig: WidgetEnvironmentConfigSchema.optional(),
}).superRefine(refineStatOnlyVisualization);

const UpdateWidgetBodySchema = z.object({
  title: z.string().max(MAX_WIDGET_TITLE_LENGTH).optional(),
  metric: MetricIdSchema.optional(),
  visualization: VisualizationSchema.optional(),
  filters: z.array(WidgetFilterSchema).optional(),
  groupBy: GroupBySchema,
  timeGranularity: TimeGranularitySchema.optional(),
  scoreName: z.string().optional(),
  scoreNameB: z.string().optional(),
  environmentConfig: WidgetEnvironmentConfigSchema.optional(),
}).superRefine(refineStatOnlyVisualization);

// ---------------------------------------------------------------------------
// Server-action input schemas
//
// One flat object per `authorizedAction` mutation — a server action takes a
// single JS-object argument, so each schema below extends the matching body
// schema above with the `appId` (every action's permission-narrowing target)
// and any path identifier (`dashboardId`/`widgetId`) the body schema alone
// doesn't carry. Reusing `.extend()` on the body schemas keeps one source of
// truth for field-level validation (filters, groupBy, the stat-only
// visualization refinement) shared between the HTTP body and the action input.
// ---------------------------------------------------------------------------

export const CreateDashboardActionInput = CreateDashboardBodySchema.extend({
  appId: z.string().min(1),
});

export const RenameDashboardActionInput = z.object({
  appId: z.string().min(1),
  dashboardId: z.string().min(1),
  name: CreateDashboardBodySchema.shape.name,
});

export const DeleteDashboardActionInput = z.object({
  appId: z.string().min(1),
  dashboardId: z.string().min(1),
});

export const DuplicateDashboardActionInput = z.object({
  appId: z.string().min(1),
  dashboardId: z.string().min(1),
});

export const SetDefaultDashboardActionInput = z.object({
  appId: z.string().min(1),
  dashboardId: z.string().min(1),
});

export const SaveDashboardLayoutActionInput = z.object({
  appId: z.string().min(1),
  dashboardId: z.string().min(1),
  layout: z.array(LayoutItemSchema),
});

export const AddWidgetActionInput = CreateWidgetBodySchema.extend({
  appId: z.string().min(1),
  dashboardId: z.string().min(1),
});

export const UpdateWidgetActionInput = UpdateWidgetBodySchema.extend({
  appId: z.string().min(1),
  dashboardId: z.string().min(1),
  widgetId: z.string().min(1),
});

export const DeleteWidgetActionInput = z.object({
  appId: z.string().min(1),
  dashboardId: z.string().min(1),
  widgetId: z.string().min(1),
});

