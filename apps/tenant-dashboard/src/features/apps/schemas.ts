import { z } from "zod";

/** Matches `CreateAppBodySchema`'s name bound (`@repo/api-schemas`) — the
 *  gateway is the source of truth; this only rejects obviously-bad input
 *  before a round trip. */
export const createAppInput = z.object({
  name: z.string().min(1).max(100),
  displayName: z.string().max(100).optional(),
});

/** `displayName: null` clears the override so the app falls back to its
 *  identifier — distinct from omitting the field. */
export const renameAppInput = z.object({
  appId: z.uuid(),
  displayName: z.string().max(100).nullable(),
});

export const deleteAppInput = z.object({
  appId: z.uuid(),
});

export const linkRepositoryInput = z.object({
  appId: z.uuid(),
  repository: z.string().min(1),
  branch: z.string().min(1),
});

export const fetchRepositoriesInput = z.object({
  appId: z.uuid(),
});

export const fetchBranchesInput = z.object({
  appId: z.uuid(),
  repository: z.string().min(1),
});
