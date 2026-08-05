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
 * Apply every supplied `?column=eq.<value>` filter to `rows`, PostgREST
 * style: an absent param does not filter; a present param must match.
 * Values compare as strings so boolean columns (`is_default=eq.true`)
 * behave the way PostgREST serializes them. Handlers list the columns they
 * honour instead of hand-chaining per-column conditionals.
 */
export function filterByEqParams<T extends Record<string, unknown>>(
  url: URL,
  rows: T[],
  columns: ReadonlyArray<keyof T & string>,
): T[] {
  const active = columns
    .map((column) => [column, getEqParam(url, column)] as const)
    .filter(([, value]) => value !== null);

  return rows.filter((row) =>
    active.every(([column, value]) => String(row[column]) === value),
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
