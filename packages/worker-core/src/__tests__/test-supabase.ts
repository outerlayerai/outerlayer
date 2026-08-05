/**
 * In-memory Supabase test double scoped to worker-core's query surface:
 * `from("worker_run").select().eq().eq().maybeSingle()`,
 * `from("worker_run").update().eq().eq().not("status","in",…).neq().select()`,
 * and `rpc(insert_secret | delete_secret)`.
 *
 * Unlike a call recorder, `update()` here EVALUATES its filters against the
 * seeded rows and mutates them on match — so the terminal-state guard and
 * replay idempotency are exercised for real: a second callback sees the row
 * the first one mutated. Anything outside this surface throws loudly.
 */

import type { SupabaseClientType } from "../types";

interface RecordedUpdate {
  table: string;
  payload: Record<string, unknown>;
  matched: number;
}

interface RecordedRpc {
  fn: string;
  params: unknown;
}

export interface WorkerTestSupabase {
  client: SupabaseClientType;
  rows: Record<string, Array<Record<string, unknown>>>;
  updates: RecordedUpdate[];
  rpcs: RecordedRpc[];
  updatesFor(table: string): RecordedUpdate[];
}

interface Filter {
  kind: "eq" | "neq" | "not-in";
  column: string;
  values: unknown[];
}

function rowMatches(row: Record<string, unknown>, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.kind === "eq") return row[f.column] === f.values[0];
    if (f.kind === "neq") return row[f.column] !== f.values[0];
    return !f.values.includes(row[f.column]);
  });
}

/** Parse the PostgREST-style `"(a,b,c)"` list used by `.not(col, "in", …)`. */
function parseInList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    return value.replace(/^\(/, "").replace(/\)$/, "").split(",");
  }
  throw new Error(`unmodelled in-list: ${String(value)}`);
}

export function createWorkerTestSupabase(
  seed: Record<string, Array<Record<string, unknown>>> = {},
  opts: { rpcError?: (fn: string) => string | null } = {},
): WorkerTestSupabase {
  const rows = seed;
  const updates: RecordedUpdate[] = [];
  const rpcs: RecordedRpc[] = [];

  function makeSelectBuilder(table: string) {
    const filters: Filter[] = [];
    const builder: Record<string, unknown> = {
      eq(column: string, value: unknown) {
        filters.push({ kind: "eq", column, values: [value] });
        return builder;
      },
      async maybeSingle() {
        const match = (rows[table] ?? []).find((r) => rowMatches(r, filters));
        return { data: match ?? null, error: null };
      },
    };
    return builder;
  }

  function makeUpdateBuilder(table: string, payload: Record<string, unknown>) {
    const filters: Filter[] = [];
    const run = () => {
      const matched = (rows[table] ?? []).filter((r) => rowMatches(r, filters));
      for (const row of matched) Object.assign(row, payload);
      updates.push({ table, payload, matched: matched.length });
      return { data: matched.map((r) => ({ id: r.id })), error: null };
    };
    const builder: Record<string, unknown> = {
      eq(column: string, value: unknown) {
        filters.push({ kind: "eq", column, values: [value] });
        return builder;
      },
      neq(column: string, value: unknown) {
        filters.push({ kind: "neq", column, values: [value] });
        return builder;
      },
      not(column: string, operator: string, value: unknown) {
        if (operator !== "in") throw new Error(`unmodelled not-${operator}`);
        filters.push({ kind: "not-in", column, values: parseInList(value) });
        return builder;
      },
      select() {
        return {
          then(resolve: (v: unknown) => void) {
            resolve(run());
          },
        };
      },
      then(resolve: (v: unknown) => void) {
        resolve(run());
      },
    };
    return builder;
  }

  const client = {
    from(table: string) {
      return {
        select: () => makeSelectBuilder(table),
        update: (payload: Record<string, unknown>) =>
          makeUpdateBuilder(table, payload),
      };
    },
    async rpc(fn: string, params: unknown) {
      rpcs.push({ fn, params });
      const message = opts.rpcError?.(fn) ?? null;
      return message ? { data: null, error: { message } } : { data: null, error: null };
    },
  };

  return {
    client: client as unknown as SupabaseClientType,
    rows,
    updates,
    rpcs,
    updatesFor: (table) => updates.filter((u) => u.table === table),
  };
}

export function createNoopLogger() {
  const scoped = {
    info: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
  };
  return {
    info: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
    withAppId: vi.fn().mockReturnValue(scoped),
  };
}
