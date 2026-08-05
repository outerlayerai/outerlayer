import { z } from "zod";

export const enumerateSkillDeletionSchema = z.object({
  appId: z.string().min(1),
  skillDir: z.string().min(1),
});

export const saveContextFileSchema = z.object({
  appId: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
  baseBlobSha: z.string(),
  commitMessage: z.string().optional(),
});

export const createContextFileSchema = z.object({
  appId: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
  commitMessage: z.string().optional(),
});

export const commitContextChangesSchema = z.object({
  appId: z.string().min(1),
  message: z.string().optional(),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string(),
        baseBlobSha: z.string().nullable(),
        delete: z.boolean().optional(),
      }),
    )
    // A folder delete can legitimately stage hundreds of paths; deletes need no
    // blob creation, so the cost of a large batch is one bulk tree listing, not
    // per-file git calls. 1000 is headroom above any realistic folder, not a
    // tuned ceiling.
    .max(1000, "a batch commits at most 1000 files at once"),
});

export type CommitContextChangesParsed = z.infer<typeof commitContextChangesSchema>;

export const readRemoteContextFileSchema = z.object({
  appId: z.string().min(1),
  path: z.string().min(1),
});

export const checkPendingPullRequestsSchema = z.object({
  appId: z.string().min(1),
  prNumbers: z.array(z.number()),
});

export const resyncContextSchema = z.object({
  appId: z.string().min(1),
});
