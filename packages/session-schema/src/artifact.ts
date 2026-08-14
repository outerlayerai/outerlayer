// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Artifact contract shared by the CLI (emit + spool + sync upload) and the
 * gateway (ingest). An artifact is an exhibit — a screenshot, recording,
 * report, or log emitted as proof that a change works — anchored to a pull
 * request either directly or through the session that produced it.
 *
 * Two invariants live here because both ends must agree on them:
 *
 *   - `kind` is derived from the media type by an exact allowlist. An
 *     unrecognized type is `file` — never guessed into a stronger kind, so a
 *     renderer can trust that "video" really was video/webm or video/mp4.
 *   - provenance (`session` / `ci` / `local`) is NEVER part of the wire
 *     payload. The server derives it from how the artifact arrived; a caller
 *     cannot claim it.
 */
import { z } from "zod";

export const ARTIFACT_KINDS = ["video", "screenshot", "report", "log", "file"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ARTIFACT_PROVENANCES = ["session", "ci", "local"] as const;
export type ArtifactProvenance = (typeof ARTIFACT_PROVENANCES)[number];

/** Exact media-type → kind allowlist. Parameters (`; charset=…`) are ignored;
 * anything not listed is `file`. */
const KIND_BY_MEDIA_TYPE: Record<string, ArtifactKind> = {
  "video/webm": "video",
  "video/mp4": "video",
  "image/png": "screenshot",
  "image/jpeg": "screenshot",
  "text/html": "report",
  "application/pdf": "report",
  "text/plain": "log",
};

export function inferArtifactKind(mediaType: string): ArtifactKind {
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  return KIND_BY_MEDIA_TYPE[normalized] ?? "file";
}

/** Extension → media type for `emit artifact <file>`. The kind allowlist
 * above keys off media type, so this is the only place a filename is
 * interpreted. Unknown extensions upload as octet-stream (kind `file`). */
const MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  webm: "video/webm",
  mp4: "video/mp4",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  html: "text/html",
  htm: "text/html",
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
};

export function mediaTypeForArtifactPath(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "application/octet-stream";
  const ext = base.slice(dot + 1).toLowerCase();
  return MEDIA_TYPE_BY_EXTENSION[ext] ?? "application/octet-stream";
}

/** Criterion ids are acceptance-file ids (`AC-084-04`) today, but the shape
 * stays permissive-yet-inert: id characters only, so a stored value can never
 * carry markdown, spaces, or HTML into a rendered surface. */
export const ArtifactCriterionIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);

export const ARTIFACT_MAX_CAPTION_LENGTH = 500;
export const ARTIFACT_MAX_FILENAME_LENGTH = 120;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** One line of `~/.outerlayer/spool/artifacts.jsonl` — written by
 * `emit artifact` inside a recorded session, consumed by `sync`, which
 * uploads it bound to the session (and turn) it was emitted from. Bytes are
 * spooled separately under `artifact-blobs/<sha256>` because the source file
 * may be deleted or rewritten between emit and sync. */
export const ArtifactSpoolRecordSchema = z.looseObject({
  rec: z.literal("artifact"),
  artifactId: z.string().min(1).max(64),
  t: z.string(),
  sessionId: z.string().min(1),
  cwd: z.string(),
  gitRepo: z.string().optional(),
  gitBranch: z.string().optional(),
  commitSha: z.string().optional(),
  prNumber: z.number().int().positive().optional(),
  filename: z.string().min(1).max(ARTIFACT_MAX_FILENAME_LENGTH),
  mediaType: z.string().min(1).max(100),
  bytes: z.number().int().nonnegative(),
  sha256: Sha256Schema,
  caption: z.string().max(ARTIFACT_MAX_CAPTION_LENGTH),
  criterionId: ArtifactCriterionIdSchema.optional(),
});
export type ArtifactSpoolRecord = z.infer<typeof ArtifactSpoolRecordSchema>;

/** Request body of `POST /v1/artifacts`. `session` is only ever attached by
 * the sync path (spool merge); `ci` marks CI-environment context and is
 * advisory — the server downgrades it unless the API key shape agrees. */
export interface EmitArtifactRequest {
  schemaVersion: 1;
  artifact: {
    clientArtifactId: string;
    filename: string;
    mediaType: string;
    bytes: number;
    sha256: string;
    caption: string;
    criterionId?: string;
    emittedAt: string;
    ci?: boolean;
    prNumber?: number;
    repository?: string;
    gitRepo?: string;
    gitBranch?: string;
    commitSha?: string;
    session?: { sessionId: string; turnIndex?: number };
  };
  blob: { data: string };
}
