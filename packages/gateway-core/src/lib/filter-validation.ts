/**
 * Semantic validation for structured JSON filters
 * (POST /v1/{traces|spans|scores}/search).
 *
 * The Zod schemas in `@repo/api-schemas` validate SHAPE (leaf vs
 * OR-group, operator enum, value primitive types, size caps). This module
 * validates MEANING against the same allowlist tables the string-DSL parser
 * uses (`@repo/api-schemas`): does the field exist on this resource, is the
 * operator valid for the field's kind, is the value the right shape for the
 * operator. Anything invalid throws {@link FilterParseError} → 400 with a
 * descriptive message — never silently dropped (same contract as the DSL).
 *
 * Output is a normalized `AnalyticsFilterNode[]`: values coerced to
 * `string | string[]` (the internal AST type), datetimes converted to
 * ClickHouse format. The SQL compilers downstream never see unvalidated
 * input from this path.
 */

import type { AnalyticsFilter, AnalyticsFilterNode } from '@repo/api-types';
import type { FilterLeaf, FilterNode } from '@repo/api-schemas';
import { formatISOForClickHouse } from '@repo/observability-service';
import { FilterParseError } from './trace-filter-dsl';
import {
  type CanonicalOp,
  type FieldKind,
  type ScoresFieldKind,
  VALUELESS_OPS,
  STATIC_FIELDS,
  JSON_OPS_BY_KIND,
  SCORES_STATIC_FIELDS,
  SCORES_JSON_OPS_BY_KIND,
  METADATA_KEY_RE,
  SCORE_NAME_RE,
  STATUS_VALUES,
  NUMERIC_VALUE_RE,
  MAX_FILTER_IN_VALUES,
  MAX_FILTER_PREDICATES,
} from '@repo/api-schemas';

export type FilterResource = 'traces' | 'spans' | 'scores';

/**
 * Value kind for validation purposes. Trace/span semantic kinds collapse to
 * how their values are typed; scores add `datetime`.
 */
type ValueKind = 'string' | 'numeric' | 'status' | 'datetime';

// Derived from the allowlists so the hints auto-update with new fields.
const TRACE_FIELD_HINT = [...STATIC_FIELDS.keys(), 'metadata.<key>', 'score__<name>'].join(', ');

const SCORES_FIELD_HINT = [...SCORES_STATIC_FIELDS.keys()].join(', ');

interface ResolvedField {
  /** Operator set to validate against. */
  ops: ReadonlySet<CanonicalOp>;
  /** How values are typed for this field. */
  valueKind: ValueKind;
  /** For error messages. */
  kindLabel: string;
}

function resolveField(field: string, resource: FilterResource): ResolvedField {
  if (resource === 'scores') {
    const kind: ScoresFieldKind | undefined = SCORES_STATIC_FIELDS.get(field.toLowerCase());
    if (!kind) {
      throw new FilterParseError(
        `Unknown scores filter field "${field}". Allowed fields: ${SCORES_FIELD_HINT}.`,
      );
    }
    return {
      ops: SCORES_JSON_OPS_BY_KIND[kind],
      valueKind: kind === 'datetime' ? 'datetime' : kind,
      kindLabel: kind,
    };
  }

  const lower = field.toLowerCase();
  if (lower.startsWith('metadata.')) {
    const key = field.slice('metadata.'.length);
    if (!METADATA_KEY_RE.test(key)) {
      throw new FilterParseError(
        `Invalid metadata key "${key}" — keys must match ${METADATA_KEY_RE.source}.`,
      );
    }
    return { ops: JSON_OPS_BY_KIND.metadata, valueKind: 'string', kindLabel: 'metadata' };
  }
  if (lower.startsWith('score__')) {
    const name = field.slice('score__'.length);
    if (!name || !SCORE_NAME_RE.test(name)) {
      throw new FilterParseError(
        `Invalid score name "${name}" — names must match ${SCORE_NAME_RE.source}.`,
      );
    }
    return { ops: JSON_OPS_BY_KIND.score, valueKind: 'numeric', kindLabel: 'score' };
  }

  const kind: FieldKind | undefined = STATIC_FIELDS.get(lower);
  if (!kind) {
    throw new FilterParseError(
      `Unknown filter field "${field}". Allowed fields: ${TRACE_FIELD_HINT}.`,
    );
  }
  const valueKind: ValueKind =
    kind === 'numeric' ? 'numeric' : kind === 'status' ? 'status' : 'string';
  return { ops: JSON_OPS_BY_KIND[kind], valueKind, kindLabel: kind };
}

function assertScalar(field: string, operator: CanonicalOp, value: unknown): string {
  if (value === undefined || Array.isArray(value)) {
    throw new FilterParseError(
      `Operator "${operator}" on "${field}" expects a single value${
        Array.isArray(value) ? ', not a list' : ''
      }.`,
    );
  }
  return String(value);
}

function checkValueKind(field: string, valueKind: ValueKind, raw: string): string {
  switch (valueKind) {
    case 'numeric':
      if (!NUMERIC_VALUE_RE.test(raw)) {
        throw new FilterParseError(`Field "${field}" expects a numeric value but got "${raw}".`);
      }
      return raw;
    case 'status':
      if (!STATUS_VALUES.has(raw.toUpperCase())) {
        throw new FilterParseError(`Invalid status value "${raw}". Allowed: OK, ERROR.`);
      }
      return raw;
    case 'datetime': {
      if (isNaN(new Date(raw).getTime())) {
        throw new FilterParseError(
          `Field "${field}" expects an ISO-8601 datetime value but got "${raw}".`,
        );
      }
      // The scores compiler binds DateTime64 params; ClickHouse wants
      // 'YYYY-MM-DD HH:mm:ss.SSS', not ISO with the trailing Z.
      return formatISOForClickHouse(raw);
    }
    default:
      return raw;
  }
}

function validateLeaf(leaf: FilterLeaf, resource: FilterResource): AnalyticsFilter {
  const { field } = leaf;
  const operator = leaf.operator as CanonicalOp;
  const resolved = resolveField(field, resource);

  if (!resolved.ops.has(operator)) {
    throw new FilterParseError(
      `Operator "${operator}" is not valid for ${resolved.kindLabel} field "${field}". ` +
        `Allowed: ${[...resolved.ops].join(', ')}.`,
    );
  }

  // exists / doesNotExist take no value.
  if (VALUELESS_OPS.has(operator)) {
    if (leaf.value !== undefined && leaf.value !== '') {
      throw new FilterParseError(`Operator "${operator}" on "${field}" takes no value.`);
    }
    return { field, operator, value: '' };
  }

  if (operator === 'in' || operator === 'notIn') {
    if (!Array.isArray(leaf.value) || leaf.value.length === 0) {
      throw new FilterParseError(
        `Operator "${operator}" on "${field}" expects a non-empty list of values.`,
      );
    }
    if (leaf.value.length > MAX_FILTER_IN_VALUES) {
      throw new FilterParseError(
        `Too many values for "${operator}" on "${field}" (max ${MAX_FILTER_IN_VALUES}).`,
      );
    }
    const values = leaf.value.map((v) => checkValueKind(field, resolved.valueKind, String(v)));
    return { field, operator, value: values };
  }

  if (operator === 'between') {
    if (!Array.isArray(leaf.value) || leaf.value.length !== 2) {
      throw new FilterParseError(
        `Operator "between" on "${field}" expects exactly [min, max].`,
      );
    }
    const values = leaf.value.map((v) => checkValueKind(field, resolved.valueKind, String(v)));
    return { field, operator, value: values };
  }

  const raw = assertScalar(field, operator, leaf.value);
  if (raw === '') {
    throw new FilterParseError(`Empty value for "${field}".`);
  }
  return { field, operator, value: checkValueKind(field, resolved.valueKind, raw) };
}

/**
 * Validate + normalize a JSON filter list for `resource`. Throws
 * {@link FilterParseError} on the first semantic problem (the route turns it
 * into a 400 with the message). The MAX_FILTER_PREDICATES cap counts every
 * leaf, grouped or not — same rule as the string DSL.
 */
export function validateSearchFilters(
  nodes: FilterNode[] | undefined,
  resource: FilterResource,
): AnalyticsFilterNode[] | undefined {
  if (!nodes || nodes.length === 0) return undefined;

  let leafCount = 0;
  const countLeaf = () => {
    leafCount++;
    if (leafCount > MAX_FILTER_PREDICATES) {
      throw new FilterParseError(`Too many filter predicates (max ${MAX_FILTER_PREDICATES}).`);
    }
  };

  return nodes.map((node): AnalyticsFilterNode => {
    if ('or' in node) {
      const members = node.or.map((leaf) => {
        countLeaf();
        return validateLeaf(leaf, resource);
      });
      return members.length === 1 ? members[0]! : { or: members };
    }
    countLeaf();
    return validateLeaf(node, resource);
  });
}

// ---------------------------------------------------------------------------
// Search time-window guardrails
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1_000;
/** Lookback applied when a search body specifies no start_date. */
const DEFAULT_SEARCH_LOOKBACK_MS = 7 * DAY_MS;
/** Hard cap on the searchable window per request. */
export const MAX_SEARCH_WINDOW_DAYS = 90;

/**
 * Resolve the [start, end] window for a search request. Unlike the GET list
 * endpoints (whose unbounded-range behavior is a frozen wire contract), the
 * search endpoints are a new surface and get guardrails from day one:
 * default 7-day lookback, hard 90-day maximum window — an unbounded
 * ClickHouse scan should be an explicit choice the API never makes on a
 * caller's behalf.
 *
 * Inputs are ISO-8601 (already shape-validated by the body schema); output
 * is ISO-8601 for the service layer, which formats for ClickHouse.
 *
 * @throws {FilterParseError} on an inverted or oversized window.
 */
export function resolveSearchWindow(
  startDate?: string,
  endDate?: string,
): { startDate: string; endDate: string } {
  const end = endDate ? Date.parse(endDate) : Date.now();
  const start = startDate ? Date.parse(startDate) : end - DEFAULT_SEARCH_LOOKBACK_MS;
  if (start > end) {
    throw new FilterParseError('start_date must not be after end_date.');
  }
  if (end - start > MAX_SEARCH_WINDOW_DAYS * DAY_MS) {
    throw new FilterParseError(
      `Search window too large (max ${MAX_SEARCH_WINDOW_DAYS} days). Narrow start_date/end_date.`,
    );
  }
  return {
    startDate: new Date(start).toISOString(),
    endDate: new Date(end).toISOString(),
  };
}
