/**
 * Zod schemas backing the saved-filters Server Actions
 * (`actions.ts`/`read.ts`). Shapes match the `saved_trace_filters` Postgres
 * table.
 */

import { z } from 'zod';

export const FilterPageSchema = z.enum(['traces', 'requests', 'sessions', 'agents-sessions']);

// `filter_config` is a Postgres JSONB with no fixed shape — callers put
// whatever state a given page's filter UI needs. Constrain to a plain
// object (rejecting arrays / primitives) and a 10KB serialized cap.
export const FilterConfigSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (v) => JSON.stringify(v).length <= 10_240,
    { message: 'filter_config exceeds maximum size (10KB)' },
  );

export const SavedFilterSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  filter_config: FilterConfigSchema,
  created_at: z.string(),
  updated_at: z.string().nullable().optional(),
});

export const CreateSavedFilterBodySchema = z.object({
  appId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  filter_config: FilterConfigSchema,
  page: FilterPageSchema.default('traces'),
});
