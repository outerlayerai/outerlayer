import { HttpResponse } from 'msw';

type HeaderBearingRequest = {
  headers: {
    get(name: string): string | null;
  };
};

export function getEqParam(url: URL, key: string) {
  const value = url.searchParams.get(key);
  return value?.startsWith('eq.') ? value.slice(3) : value;
}

/**
 * Parse a PostgREST `in.(a,b,c)` list into its member values, tolerating the
 * double quotes supabase-js adds around values containing reserved
 * characters. Returns `null` when `raw` is not an `in.` filter.
 */
function parseInParam(raw: string | null): string[] | null {
  if (!raw?.startsWith('in.(') || !raw.endsWith(')')) return null;
  const body = raw.slice(4, -1);
  if (body === '') return [];
  return body.split(',').map((value) => {
    const trimmed = value.trim();
    return trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed;
  });
}

/**
 * Apply every supplied `?column=eq.<value>` or `?column=in.(<a>,<b>)` filter
 * to `rows`, PostgREST style: an absent param does not filter; a present
 * param must match. Values compare as strings so boolean columns
 * (`is_default=eq.true`) behave the way PostgREST serializes them. Handlers
 * list the columns they honour instead of hand-chaining per-column
 * conditionals.
 *
 * `in.` is honoured because without it a caller that batches with `.in()`
 * silently matched zero rows here (the raw `in.(…)` string was compared as
 * an `eq` value and never equalled a real column), which reads at the call
 * site as "the table is empty" rather than "the mock lacks the filter".
 */
export function filterByEqParams<T extends Record<string, unknown>>(
  url: URL,
  rows: T[],
  columns: ReadonlyArray<keyof T & string>,
): T[] {
  const active = columns
    .map((column) => {
      const raw = url.searchParams.get(column);
      const inValues = parseInParam(raw);
      if (inValues) return [column, { kind: 'in' as const, values: inValues }] as const;
      const eqValue = getEqParam(url, column);
      return eqValue === null
        ? null
        : ([column, { kind: 'eq' as const, value: eqValue }] as const);
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return rows.filter((row) =>
    active.every(([column, filter]) =>
      filter.kind === 'in'
        ? filter.values.includes(String(row[column]))
        : String(row[column]) === filter.value,
    ),
  );
}

export function projectSelectedFields<T extends Record<string, unknown>>(url: URL, row: T) {
  const select = url.searchParams.get('select');
  if (!select) {
    return row;
  }

  const fields = select.split(',').map((field) => field.trim());
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => fields.includes(key)),
  ) as Partial<T>;
}

export function wantsSingle(request: HeaderBearingRequest) {
  const accept = request.headers.get('accept') ?? '';
  return accept.includes('application/vnd.pgrst.object+json');
}

export function buildSingleResponse<T>(request: HeaderBearingRequest, row: T | null) {
  if (!wantsSingle(request)) {
    return HttpResponse.json(row ? [row] : []);
  }

  if (!row) {
    return HttpResponse.json(
      { code: 'PGRST116', message: 'The result contains 0 rows' },
      { status: 406 },
    );
  }

  return HttpResponse.json(row);
}
