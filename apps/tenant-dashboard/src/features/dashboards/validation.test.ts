vi.mock('server-only', () => ({}));

import {
  createDashboardSchema,
  updateDashboardSchema,
  createWidgetSchema,
  updateWidgetSchema,
  widgetDataRequestSchema,
} from './validation';
import {
  MAX_DASHBOARD_NAME_LENGTH,
  MAX_DASHBOARD_DESCRIPTION_LENGTH,
  MAX_WIDGET_TITLE_LENGTH,
} from './types';

// ---------------------------------------------------------------------------
// createDashboardSchema
// ---------------------------------------------------------------------------
describe('createDashboardSchema', () => {
  it('should validate successfully when name is provided', async () => {
    const input = { name: 'My Dashboard' };
    const result = await createDashboardSchema.parseAsync(input);
    expect(result.name).toBe('My Dashboard');
  });

  it('should reject when name is missing', async () => {
    await expect(createDashboardSchema.parseAsync({})).rejects.toThrow(
      'Invalid input: expected string, received undefined'
    );
  });

  it('should reject when name is an empty string', async () => {
    await expect(
      createDashboardSchema.parseAsync({ name: '' })
    ).rejects.toThrow('Dashboard name is required');
  });

  it('should accept when name is exactly at the max length', async () => {
    const name = 'a'.repeat(MAX_DASHBOARD_NAME_LENGTH);
    const result = await createDashboardSchema.parseAsync({ name });
    expect(result.name).toHaveLength(MAX_DASHBOARD_NAME_LENGTH);
  });

  it('should reject when name exceeds the max length by one character', async () => {
    const name = 'a'.repeat(MAX_DASHBOARD_NAME_LENGTH + 1);
    await expect(
      createDashboardSchema.parseAsync({ name })
    ).rejects.toThrow(
      `Dashboard name must be at most ${MAX_DASHBOARD_NAME_LENGTH} characters`
    );
  });

  it('should accept when description is provided within the limit', async () => {
    const input = { name: 'Dash', description: 'A useful dashboard' };
    const result = await createDashboardSchema.parseAsync(input);
    expect(result.description).toBe('A useful dashboard');
  });

  it('should accept when description is omitted', async () => {
    const result = await createDashboardSchema.parseAsync({ name: 'Dash' });
    expect(result.description).toBeUndefined();
  });

  it('should accept when description is null', async () => {
    const result = await createDashboardSchema.parseAsync({
      name: 'Dash',
      description: null,
    });
    expect(result.description).toBeNull();
  });

  it('should accept when description is exactly at the max length', async () => {
    const description = 'b'.repeat(MAX_DASHBOARD_DESCRIPTION_LENGTH);
    const result = await createDashboardSchema.parseAsync({
      name: 'Dash',
      description,
    });
    expect(result.description).toHaveLength(MAX_DASHBOARD_DESCRIPTION_LENGTH);
  });

  it('should reject when description exceeds the max length by one character', async () => {
    const description = 'b'.repeat(MAX_DASHBOARD_DESCRIPTION_LENGTH + 1);
    await expect(
      createDashboardSchema.parseAsync({ name: 'Dash', description })
    ).rejects.toThrow(
      `Description must be at most ${MAX_DASHBOARD_DESCRIPTION_LENGTH} characters`
    );
  });

  it('should strip unknown fields when stripUnknown option is enabled', async () => {
    const input = {
      name: 'Dash',
      unknownField: 'should be removed',
    };
    const result = await createDashboardSchema.parseAsync(input);
    expect(Object.keys(result)).toEqual(expect.arrayContaining(['name']));
    expect(Object.keys(result)).not.toContain('unknownField');
  });

  it('should accept isDefault when provided as boolean', async () => {
    const result = await createDashboardSchema.parseAsync({
      name: 'Dash',
      isDefault: true,
    });
    expect(result.isDefault).toBe(true);
  });

  it('should accept templateId when provided as string', async () => {
    const result = await createDashboardSchema.parseAsync({
      name: 'Dash',
      templateId: 'agent-fleet-overview',
    });
    expect(result.templateId).toBe('agent-fleet-overview');
  });
});

// ---------------------------------------------------------------------------
// updateDashboardSchema
// ---------------------------------------------------------------------------
describe('updateDashboardSchema', () => {
  it('should validate successfully when all fields are omitted', async () => {
    const result = await updateDashboardSchema.parseAsync({});
    expect(result).toEqual({});
  });

  it('should accept name when provided as a valid string', async () => {
    const result = await updateDashboardSchema.parseAsync({
      name: 'Renamed',
    });
    expect(result.name).toBe('Renamed');
  });

  it('should reject when name exceeds the max length', async () => {
    const name = 'x'.repeat(MAX_DASHBOARD_NAME_LENGTH + 1);
    await expect(
      updateDashboardSchema.parseAsync({ name })
    ).rejects.toThrow(
      `Dashboard name must be at most ${MAX_DASHBOARD_NAME_LENGTH} characters`
    );
  });

  it('should accept description when set to null', async () => {
    const result = await updateDashboardSchema.parseAsync({
      description: null,
    });
    expect(result.description).toBeNull();
  });

  it('should reject when description exceeds the max length', async () => {
    const description = 'z'.repeat(MAX_DASHBOARD_DESCRIPTION_LENGTH + 1);
    await expect(
      updateDashboardSchema.parseAsync({ description })
    ).rejects.toThrow(
      `Description must be at most ${MAX_DASHBOARD_DESCRIPTION_LENGTH} characters`
    );
  });

  it('should accept layout when provided as a valid array', async () => {
    const layout = [{ widgetId: 'w1', x: 0, y: 0, w: 6, h: 4 }];
    const result = await updateDashboardSchema.parseAsync({ layout });
    expect(result.layout).toEqual(layout);
  });

  it('should reject layout item when w exceeds 12', async () => {
    const layout = [{ widgetId: 'w1', x: 0, y: 0, w: 13, h: 4 }];
    await expect(
      updateDashboardSchema.parseAsync({ layout })
    ).rejects.toThrow();
  });

  it('should reject layout item when w is less than 1', async () => {
    const layout = [{ widgetId: 'w1', x: 0, y: 0, w: 0, h: 4 }];
    await expect(
      updateDashboardSchema.parseAsync({ layout })
    ).rejects.toThrow();
  });

  it('should reject layout item when x is negative', async () => {
    const layout = [{ widgetId: 'w1', x: -1, y: 0, w: 6, h: 4 }];
    await expect(
      updateDashboardSchema.parseAsync({ layout })
    ).rejects.toThrow();
  });

  it('should accept globalTimeRange when provided as a valid string', async () => {
    const result = await updateDashboardSchema.parseAsync({
      globalTimeRange: '7d',
    });
    expect(result.globalTimeRange).toBe('7d');
  });
});

// ---------------------------------------------------------------------------
// createWidgetSchema
// ---------------------------------------------------------------------------
describe('createWidgetSchema', () => {
  const validWidget = {
    title: 'Requests over time',
    metric: 'request_count',
  };

  it('should validate successfully when minimal required fields are provided', async () => {
    const result = await createWidgetSchema.parseAsync(validWidget);
    expect(result.title).toBe('Requests over time');
    expect(result.metric).toBe('request_count');
  });

  it('should apply default visualization of line when omitted', async () => {
    const result = await createWidgetSchema.parseAsync(validWidget);
    expect(result.visualization).toBe('line');
  });

  it('should apply default timeGranularity of auto when omitted', async () => {
    const result = await createWidgetSchema.parseAsync(validWidget);
    expect(result.timeGranularity).toBe('auto');
  });

  it('should apply default empty filters array when omitted', async () => {
    const result = await createWidgetSchema.parseAsync(validWidget);
    expect(result.filters).toEqual([]);
  });

  it('should apply default null groupBy when omitted', async () => {
    const result = await createWidgetSchema.parseAsync(validWidget);
    expect(result.groupBy).toBeNull();
  });

  it('should reject when title is missing', async () => {
    await expect(
      createWidgetSchema.parseAsync({ metric: 'request_count' })
    ).rejects.toThrow('Invalid input: expected string, received undefined');
  });

  it('should reject when title is an empty string', async () => {
    await expect(
      createWidgetSchema.parseAsync({ title: '', metric: 'request_count' })
    ).rejects.toThrow('Widget title is required');
  });

  it('should accept when title is exactly at the max length', async () => {
    const title = 't'.repeat(MAX_WIDGET_TITLE_LENGTH);
    const result = await createWidgetSchema.parseAsync({
      ...validWidget,
      title,
    });
    expect(result.title).toHaveLength(MAX_WIDGET_TITLE_LENGTH);
  });

  it('should reject when title exceeds the max length by one character', async () => {
    const title = 't'.repeat(MAX_WIDGET_TITLE_LENGTH + 1);
    await expect(
      createWidgetSchema.parseAsync({ ...validWidget, title })
    ).rejects.toThrow(
      `Widget title must be at most ${MAX_WIDGET_TITLE_LENGTH} characters`
    );
  });

  // Both bounds reach a ClickHouse Date conversion that throws on an
  // unparseable string, so the schema has to be the thing that rejects one.
  it.each([
    ['not a date at all', 'banana'],
    ['a shape that is not a calendar date', '2026-02-30'],
    ['an empty string', ''],
  ])('rejects a custom range whose start is %s', async (_label, start) => {
    await expect(
      widgetDataRequestSchema.parseAsync({
        metric: 'total_cost',
        timeRange: { start, end: '2026-03-01' },
      }),
    ).rejects.toThrow();
  });

  it('rejects a custom range whose end is unparseable', async () => {
    await expect(
      widgetDataRequestSchema.parseAsync({
        metric: 'total_cost',
        timeRange: { start: '2026-03-01', end: 'whenever' },
      }),
    ).rejects.toThrow();
  });

  it('rejects a custom range that runs backwards', async () => {
    await expect(
      widgetDataRequestSchema.parseAsync({
        metric: 'total_cost',
        timeRange: { start: '2026-03-10', end: '2026-03-01' },
      }),
    ).rejects.toThrow(/start must not be after end/);
  });

  it('accepts a date-only custom range, and one that starts and ends the same day', async () => {
    const range = await widgetDataRequestSchema.parseAsync({
      metric: 'total_cost',
      timeRange: { start: '2026-03-01', end: '2026-03-31' },
    });
    expect(range.timeRange.start).toBe('2026-03-01');

    const sameDay = await widgetDataRequestSchema.parseAsync({
      metric: 'total_cost',
      timeRange: { start: '2026-03-01', end: '2026-03-01' },
    });
    expect(sameDay.timeRange.end).toBe('2026-03-01');
  });

  it('compares mixed date and datetime bounds by instant, not by string order', async () => {
    // '2026-03-02' sorts after '2026-03-01T23:00:00Z' as a string too, but the
    // reverse pairing is the one a lexicographic check gets wrong.
    await expect(
      widgetDataRequestSchema.parseAsync({
        metric: 'total_cost',
        timeRange: { start: '2026-03-02', end: '2026-03-01T23:00:00Z' },
      }),
    ).rejects.toThrow(/start must not be after end/);
  });

  it('should reject when metric is missing', async () => {
    await expect(
      createWidgetSchema.parseAsync({ title: 'W' })
    ).rejects.toThrow('Invalid input: expected string, received undefined');
  });

  it('should reject when metric is an invalid string', async () => {
    await expect(
      createWidgetSchema.parseAsync({ title: 'W', metric: 'not_a_metric' })
    ).rejects.toThrow('Invalid metric type');
  });

  it('should accept metric when provided as a derived metric id', async () => {
    const result = await createWidgetSchema.parseAsync({
      title: 'CPR',
      metric: 'cost_per_request',
    });
    expect(result.metric).toBe('cost_per_request');
  });

  it('should accept metric when provided as any built-in metric id', async () => {
    const builtInIds = [
      'request_count',
      'total_cost',
      'avg_cost',
      'total_tokens',
      'avg_tokens',
      'unique_users',
      'error_count',
      'error_rate',
      'avg_latency',
      'p50_latency',
      'p95_latency',
      'p99_latency',
      'top_models',
    ];
    for (const metricId of builtInIds) {
      const result = await createWidgetSchema.parseAsync({
        title: 'W',
        metric: metricId,
      });
      expect(result.metric).toBe(metricId);
    }
  });

  it('should accept metric when provided as any derived metric id', async () => {
    const derivedIds = [
      'cost_per_request',
      'tokens_per_request',
      'cost_per_token',
      'cost_per_error',
      'success_rate',
      'requests_per_user',
      'cost_per_user',
      'tokens_per_user',
      'errors_per_user',
      'latency_cost_ratio',
    ];
    for (const metricId of derivedIds) {
      const result = await createWidgetSchema.parseAsync({
        title: 'W',
        metric: metricId,
      });
      expect(result.metric).toBe(metricId);
    }
  });

  it('should accept visualization when provided as a valid type', async () => {
    for (const viz of ['line', 'bar', 'stat'] as const) {
      const result = await createWidgetSchema.parseAsync({
        ...validWidget,
        visualization: viz,
      });
      expect(result.visualization).toBe(viz);
    }
  });

  it('should reject visualization when provided as an invalid type', async () => {
    await expect(
      createWidgetSchema.parseAsync({
        ...validWidget,
        visualization: 'pie',
      })
    ).rejects.toThrow('Invalid visualization type');
  });

  it('should accept timeGranularity when provided as a valid value', async () => {
    for (const tg of ['hour', 'day', 'auto'] as const) {
      const result = await createWidgetSchema.parseAsync({
        ...validWidget,
        timeGranularity: tg,
      });
      expect(result.timeGranularity).toBe(tg);
    }
  });

  it('should reject timeGranularity when provided as an invalid value', async () => {
    await expect(
      createWidgetSchema.parseAsync({
        ...validWidget,
        timeGranularity: 'minute',
      })
    ).rejects.toThrow('Invalid time granularity');
  });

  it('should accept filters when fields are promoted fields', async () => {
    const filters = [
      { field: 'model', operator: 'eq', value: 'gpt-4' },
      { field: 'user_id', operator: 'eq', value: 'u1' },
      { field: 'status', operator: 'eq', value: 'success' },
    ];
    const result = await createWidgetSchema.parseAsync({
      ...validWidget,
      filters,
    });
    expect(result.filters).toEqual(filters);
  });

  it('should accept filters when fields are metadata fields', async () => {
    const filters = [
      { field: 'metadata.environment', operator: 'eq', value: 'prod' },
    ];
    const result = await createWidgetSchema.parseAsync({
      ...validWidget,
      filters,
    });
    expect(result.filters).toEqual(filters);
  });

  it('should reject filters when field names are invalid', async () => {
    const filters = [
      { field: 'invalid_field', operator: 'eq', value: 'x' },
    ];
    await expect(
      createWidgetSchema.parseAsync({ ...validWidget, filters })
    ).rejects.toThrow(
      'Filter field must be a promoted field (model, user_id, status) or metadata.<key>'
    );
  });

  it('should reject filters when metadata field has invalid key characters', async () => {
    const filters = [
      { field: 'metadata.has-dashes', operator: 'eq', value: 'x' },
    ];
    await expect(
      createWidgetSchema.parseAsync({ ...validWidget, filters })
    ).rejects.toThrow();
  });

  it('should accept groupBy when provided as a promoted value', async () => {
    for (const groupBy of ['model', 'user_id', 'time_period']) {
      const result = await createWidgetSchema.parseAsync({
        ...validWidget,
        groupBy,
      });
      expect(result.groupBy).toBe(groupBy);
    }
  });

  it('should accept groupBy when provided as a valid metadata field', async () => {
    const result = await createWidgetSchema.parseAsync({
      ...validWidget,
      groupBy: 'metadata.customer_tier',
    });
    expect(result.groupBy).toBe('metadata.customer_tier');
  });

  it('should reject groupBy when provided as an invalid value', async () => {
    await expect(
      createWidgetSchema.parseAsync({
        ...validWidget,
        groupBy: 'invalid_group',
      })
    ).rejects.toThrow(
      'groupBy must be model, user_id, time_period, or metadata.<key>'
    );
  });

  it('should accept groupBy when set to null', async () => {
    const result = await createWidgetSchema.parseAsync({
      ...validWidget,
      groupBy: null,
    });
    expect(result.groupBy).toBeNull();
  });

  it('should strip unknown fields when stripUnknown option is enabled', async () => {
    const result = await createWidgetSchema.parseAsync({ ...validWidget, bogus: 'field' });
    expect(result.title).toBe(validWidget.title);
    expect(result.metric).toBe(validWidget.metric);
    expect(Object.keys(result)).not.toContain('bogus');
  });
});

// ---------------------------------------------------------------------------
// updateWidgetSchema
// ---------------------------------------------------------------------------
describe('updateWidgetSchema', () => {
  it('should validate successfully when all fields are omitted', async () => {
    const result = await updateWidgetSchema.parseAsync({});
    expect(result).toEqual({});
  });

  it('should accept title when provided as a valid string', async () => {
    const result = await updateWidgetSchema.parseAsync({ title: 'Updated' });
    expect(result.title).toBe('Updated');
  });

  it('should reject when title exceeds the max length', async () => {
    const title = 'u'.repeat(MAX_WIDGET_TITLE_LENGTH + 1);
    await expect(updateWidgetSchema.parseAsync({ title })).rejects.toThrow(
      `Widget title must be at most ${MAX_WIDGET_TITLE_LENGTH} characters`
    );
  });

  it('should accept metric when provided as a valid value', async () => {
    const result = await updateWidgetSchema.parseAsync({
      metric: 'total_cost',
    });
    expect(result.metric).toBe('total_cost');
  });

  it('should reject metric when provided as an invalid value', async () => {
    await expect(
      updateWidgetSchema.parseAsync({ metric: 'bad_metric' })
    ).rejects.toThrow('Invalid metric type');
  });

  it('should accept visualization when provided as a valid value', async () => {
    const result = await updateWidgetSchema.parseAsync({
      visualization: 'bar',
    });
    expect(result.visualization).toBe('bar');
  });

  it('should reject visualization when provided as an invalid value', async () => {
    await expect(
      updateWidgetSchema.parseAsync({ visualization: 'scatter' })
    ).rejects.toThrow('Invalid visualization type');
  });

  it('should accept timeGranularity when provided as a valid value', async () => {
    const result = await updateWidgetSchema.parseAsync({
      timeGranularity: 'hour',
    });
    expect(result.timeGranularity).toBe('hour');
  });

  it('should reject timeGranularity when provided as an invalid value', async () => {
    await expect(
      updateWidgetSchema.parseAsync({ timeGranularity: 'week' })
    ).rejects.toThrow('Invalid time granularity');
  });

  it('should accept metric when provided as a derived metric id', async () => {
    const result = await updateWidgetSchema.parseAsync({
      metric: 'success_rate',
    });
    expect(result.metric).toBe('success_rate');
  });

  it('should accept groupBy when provided as a metadata field', async () => {
    const result = await updateWidgetSchema.parseAsync({
      groupBy: 'metadata.env',
    });
    expect(result.groupBy).toBe('metadata.env');
  });

  it('should reject groupBy when provided as an invalid value', async () => {
    await expect(
      updateWidgetSchema.parseAsync({ groupBy: 'something_else' })
    ).rejects.toThrow(
      'groupBy must be model, user_id, time_period, or metadata.<key>'
    );
  });
});

// ---------------------------------------------------------------------------
// widgetDataRequestSchema
// ---------------------------------------------------------------------------
describe('widgetDataRequestSchema', () => {
  const validRequest = {
    metric: 'request_count',
    timeRange: { preset: '24h' as const },
  };

  it('should validate successfully when a preset time range is provided', async () => {
    const result = await widgetDataRequestSchema.parseAsync(validRequest);
    expect(result.metric).toBe('request_count');
    expect(result.timeRange.preset).toBe('24h');
  });

  it('should validate successfully when custom start and end dates are provided', async () => {
    const result = await widgetDataRequestSchema.parseAsync({
      metric: 'total_cost',
      timeRange: {
        start: '2025-01-01T00:00:00Z',
        end: '2025-01-31T23:59:59Z',
      },
    });
    expect(result.timeRange.start).toBe('2025-01-01T00:00:00Z');
    expect(result.timeRange.end).toBe('2025-01-31T23:59:59Z');
  });

  it('should reject when metric is missing', async () => {
    await expect(
      widgetDataRequestSchema.parseAsync({ timeRange: { preset: '7d' } })
    ).rejects.toThrow('Invalid input: expected string, received undefined');
  });

  it('should reject when metric is invalid', async () => {
    await expect(
      widgetDataRequestSchema.parseAsync({
        metric: 'fake_metric',
        timeRange: { preset: '7d' },
      })
    ).rejects.toThrow('Invalid metric type');
  });

  it('should reject when timeRange is missing', async () => {
    await expect(
      widgetDataRequestSchema.parseAsync({ metric: 'request_count' })
    ).rejects.toThrow();
  });

  it('should reject when timeRange has neither preset nor start/end', async () => {
    await expect(
      widgetDataRequestSchema.parseAsync({
        metric: 'request_count',
        timeRange: {},
      })
    ).rejects.toThrow(
      'Either preset or both start and end dates are required'
    );
  });

  it('should reject when timeRange has start but no end', async () => {
    await expect(
      widgetDataRequestSchema.parseAsync({
        metric: 'request_count',
        timeRange: { start: '2025-01-01T00:00:00Z' },
      })
    ).rejects.toThrow(
      'Either preset or both start and end dates are required'
    );
  });

  it('should reject when timeRange has end but no start', async () => {
    await expect(
      widgetDataRequestSchema.parseAsync({
        metric: 'request_count',
        timeRange: { end: '2025-01-31T23:59:59Z' },
      })
    ).rejects.toThrow(
      'Either preset or both start and end dates are required'
    );
  });

  it('should reject time range preset when provided as an invalid value', async () => {
    await expect(
      widgetDataRequestSchema.parseAsync({
        metric: 'request_count',
        timeRange: { preset: '1y' },
      })
    ).rejects.toThrow('Invalid time range preset');
  });

  it('should accept time range preset when provided as any valid value', async () => {
    for (const preset of ['24h', '7d', '30d', '90d'] as const) {
      const result = await widgetDataRequestSchema.parseAsync({
        metric: 'request_count',
        timeRange: { preset },
      });
      expect(result.timeRange.preset).toBe(preset);
    }
  });

  it('should apply default groupBy of null when omitted', async () => {
    const result = await widgetDataRequestSchema.parseAsync(validRequest);
    expect(result.groupBy).toBeNull();
  });

  it('should apply default timeGranularity of auto when omitted', async () => {
    const result = await widgetDataRequestSchema.parseAsync(validRequest);
    expect(result.timeGranularity).toBe('auto');
  });

  it('should apply default empty filters array when omitted', async () => {
    const result = await widgetDataRequestSchema.parseAsync(validRequest);
    expect(result.filters).toEqual([]);
  });

  it('should accept metric when provided as a derived metric id', async () => {
    const result = await widgetDataRequestSchema.parseAsync({
      metric: 'latency_cost_ratio',
      timeRange: { preset: '30d' },
    });
    expect(result.metric).toBe('latency_cost_ratio');
  });

  it('should accept filters when provided as valid filter objects', async () => {
    const result = await widgetDataRequestSchema.parseAsync({
      ...validRequest,
      filters: [{ field: 'model', operator: 'eq', value: 'gpt-4o' }],
    });
    expect(result.filters).toHaveLength(1);
  });

  it('should accept groupBy when provided as a valid value', async () => {
    const result = await widgetDataRequestSchema.parseAsync({
      ...validRequest,
      groupBy: 'model',
    });
    expect(result.groupBy).toBe('model');
  });

  it('should reject groupBy when provided as an invalid value', async () => {
    await expect(
      widgetDataRequestSchema.parseAsync({
        ...validRequest,
        groupBy: 'bad_field',
      })
    ).rejects.toThrow(
      'groupBy must be model, user_id, time_period, or metadata.<key>'
    );
  });

  // L252: timeGranularity enum — accept a valid value, reject an invalid one.
  it('should accept timeGranularity when provided as a valid value', async () => {
    const result = await widgetDataRequestSchema.parseAsync({
      ...validRequest,
      timeGranularity: 'day',
    });
    expect(result.timeGranularity).toBe('day');
  });

  it('should reject timeGranularity when provided as an invalid value', async () => {
    await expect(
      widgetDataRequestSchema.parseAsync({
        ...validRequest,
        timeGranularity: 'month',
      })
    ).rejects.toThrow('Invalid time granularity');
  });
});

// ---------------------------------------------------------------------------
// isValidGroupBy: empty-string branch (L38)
// ---------------------------------------------------------------------------
describe('groupBy empty-string handling', () => {
  const validWidget = { title: 'W', metric: 'request_count' };

  it('should accept groupBy when set to an empty string (createWidgetSchema)', async () => {
    const result = await createWidgetSchema.parseAsync({
      ...validWidget,
      groupBy: '',
    });
    expect(result.groupBy).toBe('');
  });

  it('should accept groupBy when set to an empty string (widgetDataRequestSchema)', async () => {
    const result = await widgetDataRequestSchema.parseAsync({
      metric: 'request_count',
      timeRange: { preset: '24h' },
      groupBy: '',
    });
    expect(result.groupBy).toBe('');
  });
});

// ---------------------------------------------------------------------------
// layoutItemSchema y-coordinate bound (L69)
// ---------------------------------------------------------------------------
describe('layout item y bound', () => {
  it('should accept a layout item when y is exactly zero', async () => {
    const layout = [{ widgetId: 'w1', x: 0, y: 0, w: 6, h: 4 }];
    const result = await updateDashboardSchema.parseAsync({ layout });
    expect(result.layout).toEqual(layout);
  });

  it('should reject a layout item when y is negative', async () => {
    const layout = [{ widgetId: 'w1', x: 0, y: -1, w: 6, h: 4 }];
    await expect(
      updateDashboardSchema.parseAsync({ layout })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// widgetFilterSchema value-required superRefine (L61, L62)
// ---------------------------------------------------------------------------
describe('widget filter value-required rule', () => {
  const base = { title: 'W', metric: 'request_count' };

  it('should accept a filter when a value-based operator carries a value', async () => {
    const filters = [{ field: 'model', operator: 'eq', value: 'gpt-4' }];
    const result = await createWidgetSchema.parseAsync({ ...base, filters });
    expect(result.filters).toEqual(filters);
  });

  it('should reject a filter when a value-based operator has no value, at path filters.0.value', () => {
    const parsed = createWidgetSchema.safeParse({
      ...base,
      filters: [{ field: 'model', operator: 'eq' }],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('expected safeParse to fail');
    const issue = parsed.error.issues.find(
      (i) => i.message === 'Filter value is required'
    );
    // Asserting the exact path also pins existence: a missing issue makes
    // `issue?.path` undefined, which fails this toEqual.
    expect(issue?.path).toEqual(['filters', 0, 'value']);
  });

  it('should reject a filter when a value-based operator has an empty-string value', () => {
    const parsed = createWidgetSchema.safeParse({
      ...base,
      filters: [{ field: 'model', operator: 'eq', value: '' }],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('expected safeParse to fail');
    expect(
      parsed.error.issues.some((i) => i.message === 'Filter value is required')
    ).toBe(true);
  });

  it.each(['exists', 'doesNotExist', 'doesnotexist', 'does_not_exist'])(
    'should accept the value-less operator %s with no value',
    async (operator) => {
      const result = await createWidgetSchema.parseAsync({
        ...base,
        filters: [{ field: 'model', operator }],
      });
      expect(result.filters[0]).toEqual({ field: 'model', operator, value: '' });
    }
  );

  it('should still require a value for a non-value-less operator like gt', () => {
    const parsed = createWidgetSchema.safeParse({
      ...base,
      filters: [{ field: 'model', operator: 'gt' }],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('expected safeParse to fail');
    expect(
      parsed.error.issues.some((i) => i.message === 'Filter value is required')
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// widgetEnvironmentConfigSchema (L81, L82, L89, L90, L93)
// Exercised through createWidgetSchema.environmentConfig.
// ---------------------------------------------------------------------------
describe('widget environmentConfig', () => {
  const base = { title: 'W', metric: 'request_count' };

  it('should accept inherit mode without an environments list', async () => {
    const result = await createWidgetSchema.parseAsync({
      ...base,
      environmentConfig: { mode: 'inherit' },
    });
    expect(result.environmentConfig).toEqual({ mode: 'inherit' });
  });

  it('should accept override mode with a non-empty environments list', async () => {
    const result = await createWidgetSchema.parseAsync({
      ...base,
      environmentConfig: { mode: 'override', environments: ['dev', 'prod'] },
    });
    expect(result.environmentConfig).toEqual({
      mode: 'override',
      environments: ['dev', 'prod'],
    });
  });

  it('should reject an invalid mode value', () => {
    const parsed = createWidgetSchema.safeParse({
      ...base,
      environmentConfig: { mode: 'sync' },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('expected safeParse to fail');
    expect(
      parsed.error.issues.some((i) => i.message === 'Invalid env mode')
    ).toBe(true);
  });

  it('should reject when mode is missing entirely', () => {
    const parsed = createWidgetSchema.safeParse({
      ...base,
      environmentConfig: { environments: ['dev'] },
    });
    expect(parsed.success).toBe(false);
  });

  it('should reject an invalid environment name', () => {
    const parsed = createWidgetSchema.safeParse({
      ...base,
      environmentConfig: { mode: 'override', environments: ['Prod'] },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('expected safeParse to fail');
    expect(
      parsed.error.issues.some((i) => i.message === 'Invalid environment name')
    ).toBe(true);
  });

  it('should reject override mode when environments is omitted, at path environmentConfig.environments', () => {
    const parsed = createWidgetSchema.safeParse({
      ...base,
      environmentConfig: { mode: 'override' },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('expected safeParse to fail');
    const issue = parsed.error.issues.find(
      (i) =>
        i.message === 'Override env config must list at least one environment'
    );
    // The exact-path assertion also pins existence (undefined path → fails).
    expect(issue?.path).toEqual(['environmentConfig', 'environments']);
  });

  it('should reject override mode when environments is an empty array', () => {
    const parsed = createWidgetSchema.safeParse({
      ...base,
      environmentConfig: { mode: 'override', environments: [] },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('expected safeParse to fail');
    expect(
      parsed.error.issues.some(
        (i) =>
          i.message === 'Override env config must list at least one environment'
      )
    ).toBe(true);
  });

  it('should accept inherit mode even with an empty environments array (no override requirement)', async () => {
    const result = await createWidgetSchema.parseAsync({
      ...base,
      environmentConfig: { mode: 'inherit', environments: [] },
    });
    expect(result.environmentConfig).toEqual({
      mode: 'inherit',
      environments: [],
    });
  });

  it('should accept inherit mode with environments omitted (override requirement does not apply)', async () => {
    const result = await createWidgetSchema.parseAsync({
      ...base,
      environmentConfig: { mode: 'inherit' },
    });
    expect(result.environmentConfig?.environments).toBeUndefined();
  });
});
