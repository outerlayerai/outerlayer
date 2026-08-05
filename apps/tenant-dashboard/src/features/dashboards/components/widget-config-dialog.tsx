'use client';

/**
 * WidgetConfigDialog Component
 *
 * Dialog form for creating/configuring a widget.
 * Includes: title, metric, visualization, filters, groupBy, timeGranularity.
 * Supports both promoted fields (model, user_id, status) and arbitrary
 * metadata keys (metadata.<key>) for filters and groupBy.
 * Uses react-hook-form + Zod validation.
 */

import { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import Iconify from '@/components/iconify';
import { z } from 'zod';
import { useForm, useFieldArray, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import FormProvider, { RHFTextField, RHFSelect } from '@/components/hook-form';
import { addWidget as addWidgetAction } from '../actions';
import {
  BUILT_IN_METRICS,
  METRIC_LABELS,
  METRIC_DESCRIPTIONS,
  DERIVED_METRICS,
  ALL_METRIC_IDS,
  VISUALIZATION_TYPES,
  MAX_WIDGET_TITLE_LENGTH,
  SCORE_METRICS,
  isScoreMetric,
  isStatOnlyMetric,
} from '../types';
import type {
  VisualizationType,
  TimeGranularity,
  Widget,
} from '../types';
import { useDashboardContext } from './context';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CUSTOM_FIELD_SENTINEL = '__custom__';

const FILTER_FIELD_OPTIONS = [
  { value: 'model', label: 'Model' },
  { value: 'user_id', label: 'User ID' },
  { value: 'status', label: 'Status' },
  { value: CUSTOM_FIELD_SENTINEL, label: 'Custom Property...' },
];

const FILTER_OPERATORS = [
  { value: 'equals', label: 'equals' },
  { value: 'notequals', label: 'not equals' },
  { value: 'contains', label: 'contains' },
  { value: 'notContains', label: 'not contains' },
  { value: 'startsWith', label: 'starts with' },
  { value: 'endsWith', label: 'ends with' },
  { value: 'exists', label: 'exists' },
  { value: 'doesNotExist', label: 'does not exist' },
];

const VALUE_LESS_OPERATORS = new Set(['exists', 'doesNotExist']);

const GROUP_BY_OPTIONS = [
  { value: '', label: 'None' },
  { value: 'model', label: 'Model' },
  { value: 'user_id', label: 'User ID' },
  { value: 'time_period', label: 'Time Period' },
  { value: CUSTOM_FIELD_SENTINEL, label: 'Custom Property...' },
];

const TIME_GRANULARITY_OPTIONS: { value: TimeGranularity; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'hour', label: 'Hourly' },
  { value: 'day', label: 'Daily' },
];

// ---------------------------------------------------------------------------
// Types & Schema
// ---------------------------------------------------------------------------

interface WidgetConfigDialogProps {
  open: boolean;
  onClose: () => void;
  dashboardId: string;
  /** Fires after a successful create with the widget the server returned,
   *  so the caller can append it to the dashboard's cached widget list
   *  without a refetch. */
  onCreated?: (widget: Widget) => void;
}

const dialogSchema = z.object({
  title: z
    .string()
    .min(1, 'Widget title is required')
    .max(MAX_WIDGET_TITLE_LENGTH, `Title must be at most ${MAX_WIDGET_TITLE_LENGTH} characters`),
  // A missing/empty metric isn't a valid enum member, so it fails with the
  // enum message — no separate required check needed.
  metric: z.enum([...ALL_METRIC_IDS] as [string, ...string[]], {
    message: 'Invalid metric type',
  }),
  visualization: z
    .enum([...VISUALIZATION_TYPES] as [VisualizationType, ...VisualizationType[]], {
      message: 'Invalid visualization type',
    })
    .default('line'),
  filters: z
    .array(
      z
        .object({
          field: z.string().min(1, 'Field is required'),
          operator: z.string().min(1, 'Operator is required'),
          value: z.string().optional().default(''),
        })
        // Value is required unless the operator is value-less
        // (exists / doesNotExist).
        .superRefine((row, ctx) => {
          if (!VALUE_LESS_OPERATORS.has(row.operator)) {
            if (!row.value) {
              ctx.addIssue({
                code: 'custom',
                path: ['value'],
                message: 'Value is required',
              });
            }
          }
        })
    )
    .optional()
    .default([]),
  groupBy: z.string().nullable().optional().default(''),
  groupByCustomKey: z.string().optional().default(''),
  timeGranularity: z
    .enum(['hour', 'day', 'auto'] as [TimeGranularity, ...TimeGranularity[]], {
      message: 'Invalid granularity',
    })
    .optional()
    .default('auto'),
  scoreName: z.string().optional().default(''),
  scoreNameB: z.string().optional().default(''),
}).superRefine((data, ctx) => {
  // Mirrors validation.ts's refineStatOnlyVisualization — client-side so the
  // form surfaces the error before a round-trip, not instead of the server check.
  if (isStatOnlyMetric(data.metric) && data.visualization !== 'stat') {
    ctx.addIssue({
      code: 'custom',
      message: `${data.metric} must use the "stat" visualization`,
      path: ['visualization'],
    });
  }
});

// Input (what the form holds / defaultValues satisfy — fields with `.default()`
// are optional) vs output (post-parse, all defaults applied — what `handleSubmit`
// receives). react-hook-form's 3rd generic carries the transformed output type.
type FormInput = z.input<typeof dialogSchema>;
type FormValues = z.output<typeof dialogSchema>;

// ---------------------------------------------------------------------------
// FilterRow sub-component (handles custom metadata field input)
// ---------------------------------------------------------------------------

function FilterRow({
  index,
  methods,
  onRemove,
}: {
  index: number;
  methods: ReturnType<typeof useForm<FormInput, unknown, FormValues>>;
  onRemove: () => void;
}) {
  const fieldValue = useWatch({ control: methods.control, name: `filters.${index}.field` });
  const operatorValue = useWatch({ control: methods.control, name: `filters.${index}.operator` });
  const isCustom = fieldValue === CUSTOM_FIELD_SENTINEL || fieldValue?.startsWith('metadata.');
  const isValueLess = VALUE_LESS_OPERATORS.has(operatorValue ?? '');

  // Track custom key input separately — when user types a key, store field as metadata.<key>
  const [customKey, setCustomKey] = useState(() => {
    if (fieldValue?.startsWith('metadata.')) {
      return fieldValue.slice('metadata.'.length);
    }
    return '';
  });

  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{
        alignItems: "flex-start",
        flexWrap: 'wrap'
      }}>
      <TextField
        select
        size="small"
        label="Field"
        sx={{ minWidth: 140 }}
        value={isCustom ? CUSTOM_FIELD_SENTINEL : (fieldValue || 'model')}
        onChange={(e) => {
          const val = e.target.value;
          if (val === CUSTOM_FIELD_SENTINEL) {
            methods.setValue(`filters.${index}.field`, CUSTOM_FIELD_SENTINEL);
            setCustomKey('');
          } else {
            methods.setValue(`filters.${index}.field`, val);
            setCustomKey('');
          }
        }}
      >
        {FILTER_FIELD_OPTIONS.map((f) => (
          <MenuItem key={f.value} value={f.value}>
            {f.label}
          </MenuItem>
        ))}
      </TextField>
      {isCustom && (
        <TextField
          size="small"
          label="Key"
          placeholder="e.g. environment"
          sx={{ minWidth: 120 }}
          value={customKey}
          onChange={(e) => {
            const key = e.target.value.replace(/[^a-zA-Z0-9_]/g, '');
            setCustomKey(key);
            if (key) {
              methods.setValue(`filters.${index}.field`, `metadata.${key}`);
            }
          }}
        />
      )}
      <TextField
        select
        size="small"
        label="Operator"
        sx={{ minWidth: 110 }}
        {...methods.register(`filters.${index}.operator`)}
        defaultValue="equals"
      >
        {FILTER_OPERATORS.map((op) => (
          <MenuItem key={op.value} value={op.value}>
            {op.label}
          </MenuItem>
        ))}
      </TextField>
      {!isValueLess && (
        <TextField
          size="small"
          label="Value"
          sx={{ flex: 1, minWidth: 80 }}
          {...methods.register(`filters.${index}.value`)}
        />
      )}
      <IconButton size="small" onClick={onRemove} sx={{ mt: 0.5 }}>
        <Iconify icon="eva:trash-2-outline" width={18} />
      </IconButton>
    </Stack>
  );
}

/** Label for a metric id — derived metrics carry their own name. */
function metricLabelFor(metricId: string): string {
  const derived = DERIVED_METRICS.find((d) => d.id === metricId);
  return derived ? derived.name : METRIC_LABELS[metricId] ?? metricId;
}

/** One-line description for a metric id, if we have one. */
function metricDescriptionFor(metricId: string): string | undefined {
  const derived = DERIVED_METRICS.find((d) => d.id === metricId);
  return derived ? derived.description : METRIC_DESCRIPTIONS[metricId];
}

/** MenuItem body: metric label with its description stacked underneath. */
function MetricMenuItemContent({ metricId }: { metricId: string }) {
  const description = metricDescriptionFor(metricId);
  return (
    <Box>
      <Typography variant="body2">{metricLabelFor(metricId)}</Typography>
      {description && (
        <Typography
          variant="caption"
          sx={{ display: 'block', color: 'text.secondary', whiteSpace: 'normal', lineHeight: 1.3 }}
        >
          {description}
        </Typography>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WidgetConfigDialog({ open, onClose, dashboardId, onCreated }: WidgetConfigDialogProps) {
  const { appId } = useDashboardContext();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const methods = useForm<FormInput, unknown, FormValues>({
    resolver: zodResolver(dialogSchema),
    defaultValues: {
      title: '',
      metric: 'request_count',
      visualization: 'line',
      filters: [],
      groupBy: '',
      groupByCustomKey: '',
      timeGranularity: 'auto',
      scoreName: '',
      scoreNameB: '',
    },
  });

  const {
    handleSubmit,
    reset,
    control,
    setValue,
    formState: { isSubmitting },
  } = methods;

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'filters',
  });

  const groupByValue = useWatch({ control, name: 'groupBy' });
  const metricValue = useWatch({ control, name: 'metric' });
  const visualizationValue = useWatch({ control, name: 'visualization' });
  const isCustomGroupBy = groupByValue === CUSTOM_FIELD_SENTINEL || groupByValue?.startsWith('metadata.');

  // Stat-only metrics (active_actor_count, and Agent Fleet Overview's
  // session_count/tool_error_rate) can only render as a stat — force it so
  // the user never has to discover the constraint via a submit error.
  useEffect(() => {
    if (isStatOnlyMetric(metricValue) && visualizationValue !== 'stat') {
      setValue('visualization', 'stat');
    }
  }, [metricValue, visualizationValue, setValue]);
  const isScoreOutcomeMetric =
    metricValue === 'agent_pr_outcome_by_score_merge_rate' ||
    metricValue === 'agent_pr_outcome_by_score_cycle_time' ||
    metricValue === 'agent_pr_outcome_by_score_revert_rate';
  const needsScoreName =
    metricValue === 'score_histogram' ||
    metricValue === 'score_trend' ||
    metricValue === 'score_comparison' ||
    isScoreOutcomeMetric;
  const needsScoreNameB = metricValue === 'score_comparison';

  const handleClose = useCallback(() => {
    reset();
    setSubmitError(null);
    onClose();
  }, [reset, onClose]);

  const onSubmit = useCallback(
    async (data: FormValues) => {
      setSubmitError(null);
      try {
        // Resolve groupBy — if custom sentinel, use metadata.<key>
        let resolvedGroupBy = data.groupBy || null;
        if (resolvedGroupBy === CUSTOM_FIELD_SENTINEL && data.groupByCustomKey) {
          resolvedGroupBy = `metadata.${data.groupByCustomKey}`;
        }

        // Clean up filters — skip sentinel fields without a key
        const resolvedFilters = data.filters
          ?.filter((f) => f.field !== CUSTOM_FIELD_SENTINEL)
          .filter((f) => f.field && (f.value || VALUE_LESS_OPERATORS.has(f.operator)));

        // Widgets always follow the dashboard's header environment. We send no
        // environmentConfig — an absent config persists as NULL, which the
        // renderer resolves to the current header env at query time.
        const payload = {
          title: data.title,
          metric: data.metric,
          visualization: data.visualization,
          groupBy: resolvedGroupBy,
          timeGranularity: data.timeGranularity,
          filters: resolvedFilters?.length ? resolvedFilters : undefined,
          scoreName: data.scoreName || undefined,
          scoreNameB: data.scoreNameB || undefined,
        };

        const result = await addWidgetAction({ appId, dashboardId, ...payload });
        if (!result.ok) throw new Error(result.error.message);
        onCreated?.(result.data);
        handleClose();
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : 'An error occurred');
      }
    },
    [dashboardId, appId, onCreated, handleClose]
  );

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <FormProvider methods={methods} onSubmit={handleSubmit(onSubmit)}>
        <DialogTitle>Add Widget</DialogTitle>
        <DialogContent>
          <Stack spacing={2.5} sx={{ mt: 1 }}>
            {submitError && <Alert severity="error">{submitError}</Alert>}

            {/* Core fields */}
            <RHFTextField name="title" label="Title" />

            <RHFSelect
              name="metric"
              label="Metric"
              // MenuItems stack a description under each label; keep the
              // collapsed control showing just the label, not both lines.
              renderValue={(value) => metricLabelFor(String(value ?? ''))}
            >
              <MenuItem disabled sx={{ opacity: 0.6, fontWeight: 600, fontSize: '0.75rem' }}>
                Built-in Metrics
              </MenuItem>
              {BUILT_IN_METRICS.filter((m) => !isScoreMetric(m)).map((m) => (
                <MenuItem key={m} value={m}>
                  <MetricMenuItemContent metricId={m} />
                </MenuItem>
              ))}
              <MenuItem disabled sx={{ opacity: 0.6, fontWeight: 600, fontSize: '0.75rem', mt: 1 }}>
                Derived Metrics
              </MenuItem>
              {DERIVED_METRICS.map((m) => (
                <MenuItem key={m.id} value={m.id}>
                  <MetricMenuItemContent metricId={m.id} />
                </MenuItem>
              ))}
              <MenuItem disabled sx={{ opacity: 0.6, fontWeight: 600, fontSize: '0.75rem', mt: 1 }}>
                Scores
              </MenuItem>
              {SCORE_METRICS.map((m) => (
                <MenuItem key={m} value={m}>
                  <MetricMenuItemContent metricId={m} />
                </MenuItem>
              ))}
            </RHFSelect>

            {needsScoreName && (
              <RHFTextField
                name="scoreName"
                label="Score Name"
                placeholder="e.g. accuracy"
                helperText={
                  isScoreOutcomeMetric
                    ? 'The predictor score to segment by — e.g. worker.ci_green (first-pass CI), or an assertion/judge/human-verdict score. worker.merged and worker.reverted can’t be used here — they’re the fate this metric measures against, not a predictor of it.'
                    : 'The name of the score to display'
                }
              />
            )}

            {needsScoreNameB && (
              <RHFTextField
                name="scoreNameB"
                label="Score Name B"
                placeholder="e.g. relevance"
                helperText="Second score name for comparison"
              />
            )}

            <RHFSelect name="visualization" label="Visualization">
              {VISUALIZATION_TYPES.map((vis) => (
                <MenuItem key={vis} value={vis}>
                  {vis.charAt(0).toUpperCase() + vis.slice(1)}
                </MenuItem>
              ))}
            </RHFSelect>

            <Divider />

            {/* Group By */}
            <Stack spacing={1}>
              <RHFSelect
                name="groupBy"
                label="Group By"
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  methods.setValue('groupBy', e.target.value);
                  if (e.target.value !== CUSTOM_FIELD_SENTINEL) {
                    methods.setValue('groupByCustomKey', '');
                  }
                }}
              >
                {GROUP_BY_OPTIONS.map((opt) => (
                  <MenuItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </MenuItem>
                ))}
              </RHFSelect>

              {isCustomGroupBy && (
                <RHFTextField
                  name="groupByCustomKey"
                  label="Metadata Key"
                  placeholder="e.g. environment"
                  size="small"
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    const key = e.target.value.replace(/[^a-zA-Z0-9_]/g, '');
                    methods.setValue('groupByCustomKey', key);
                  }}
                />
              )}
            </Stack>

            {/* Time Granularity */}
            <RHFSelect name="timeGranularity" label="Time Granularity">
              {TIME_GRANULARITY_OPTIONS.map((opt) => (
                <MenuItem key={opt.value} value={opt.value}>
                  {opt.label}
                </MenuItem>
              ))}
            </RHFSelect>

            <Divider />

            {/* Filters */}
            <Box>
              <Stack
                direction="row"
                sx={{
                  alignItems: "center",
                  justifyContent: "space-between",
                  mb: 1
                }}>
                <Typography variant="subtitle2">Filters</Typography>
                <Button
                  size="small"
                  startIcon={<Iconify icon="eva:plus-fill" width={16} />}
                  onClick={() => append({ field: 'model', operator: 'equals', value: '' })}
                >
                  Add Filter
                </Button>
              </Stack>

              <Stack spacing={1.5}>
                {fields.map((field, index) => (
                  <FilterRow
                    key={field.id}
                    index={index}
                    methods={methods}
                    onRemove={() => remove(index)}
                  />
                ))}

                {fields.length === 0 && (
                  <Typography variant="body2" sx={{
                    color: "text.secondary"
                  }}>
                    No filters applied
                  </Typography>
                )}
              </Stack>
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" loading={isSubmitting}>
            Add Widget
          </Button>
        </DialogActions>
      </FormProvider>
    </Dialog>
  );
}
