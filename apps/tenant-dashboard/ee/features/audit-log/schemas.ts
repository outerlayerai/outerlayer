import { z } from "zod";

const actionTypeSchema = z.string().min(1).optional();
const targetTypeSchema = z.string().min(1).optional();

/**
 * `page`/`pageSize` coerce rather than requiring a strict `number` — the
 * table's own client action calls pass real numbers, but the settings page
 * React Server Component (RSC) validates raw `searchParams` strings through this SAME schema (a
 * malformed `?page=` must fail validation, not flow NaN/negative into the
 * pagination offset math), so both input shapes need to type-check.
 */
export const listAuditLogInputSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  actionType: actionTypeSchema,
  targetType: targetTypeSchema,
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const getAuditLogDetailInputSchema = z.object({
  logId: z.string().min(1),
});

export const exportAuditLogInputSchema = z.object({});
