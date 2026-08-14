import "server-only";

import { ARTIFACT_KINDS, ARTIFACT_PROVENANCES } from "@outerlayer/session-schema";
import { canonicalPrCommentRepo } from "@repo/gateway-core/lib/pr-comment-repo-key";

import { getAdminDataClient } from "@/lib/system/admin-client";

/**
 * Read layer for the comment's Artifacts evidence: every artifact anchored to
 * `(tenant, repository, pr_number)` that has not aged out. Same admin-client
 * rationale as `read.ts` — the refresh runs from webhook/queue contexts with
 * no user session, so RLS grants cannot be relied on and `tenantId` MUST come
 * from a verified source.
 *
 * PRIVACY: rows carry only what the renderer prints — filename, kind,
 * caption, criterion id, provenance, emit time, and the app/env names the
 * deep link needs. No actor, no session transcript content. Captions are
 * author-supplied free text and are escaped by the renderer, never here.
 */

/** Bounded read — a comment refresh, never a full-table walk. */
const MAX_ARTIFACTS = 200;

/** `kind` and `provenance` are plain text columns at rest; the gateway's
 * write-side allowlist lives in another app and is no boundary here. An
 * unknown value degrades to the WEAKEST member of each vocabulary — never
 * passes through to the renderer, never upgrades to a stronger claim. */
const KNOWN_KINDS = new Set<string>(ARTIFACT_KINDS);
const KNOWN_PROVENANCES = new Set<string>(ARTIFACT_PROVENANCES);

export interface PrArtifactRow {
  id: string;
  filename: string;
  kind: string;
  caption: string;
  /** '' when the artifact was emitted without `--for`. */
  criterionId: string;
  provenance: "session" | "ci" | "local";
  emittedAt: string;
  /** Resolved from `app.name`; falls back to the raw id if the app row is
   * gone (should not happen — `artifact.app_id` cascades). */
  appName: string;
  /** The app's default environment name, for the deep-link `env` segment.
   * Empty string if the app has no default environment row — the renderer
   * then omits the deep link rather than publishing an empty URL segment. */
  envName: string;
}

/**
 * Artifacts anchored to this PR, oldest-emitted first (the renderer applies
 * its own bound-to-criteria-first ordering on top; the emit-time base order
 * is established here so re-renders are byte-identical).
 *
 * `pending` rows are included when they carry this PR's anchor directly — an
 * artifact emitted `--pr N` before the webhook-fed `pull_request` row landed
 * is still this PR's evidence — but ONLY when the emitting app's own GitHub
 * connection names this repository: a pending anchor is caller-claimed and
 * no reconciler has vetted it, so without that check an emit against one
 * app's key claiming another app's repo would surface as evidence on the
 * other repo's world-readable comment for the whole pending grace window.
 * `unmatched` rows never render (their anchor never resolved and their blobs
 * are deleted).
 */
export async function readPrArtifacts(params: {
  tenantId: string;
  repository: string;
  prNumber: number;
}): Promise<PrArtifactRow[]> {
  const { tenantId, repository, prNumber } = params;
  const admin = getAdminDataClient();

  const { data, error } = await admin
    .from("artifact")
    .select(
      "id, app_id, filename, kind, caption, criterion_id, provenance, emitted_at, verification",
    )
    .eq("tenant_id", tenantId)
    .eq("repository", repository)
    .eq("pr_number", prNumber)
    .neq("verification", "unmatched")
    .order("emitted_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(MAX_ARTIFACTS);
  if (error) {
    throw new Error(`artifact read failed: ${error.message}`);
  }
  const anchored = data ?? [];
  if (anchored.length === 0) return [];

  // Pending-row vetting (see the doc comment above). Fails closed: an
  // unreadable connection list drops the pending rows for this refresh
  // rather than rendering an unvetted anchor.
  const pendingAppIds = [
    ...new Set(anchored.filter((r) => r.verification === "pending").map((r) => r.app_id)),
  ];
  let appsConnectedHere = new Set<string>();
  if (pendingAppIds.length > 0) {
    const canonicalTarget = canonicalPrCommentRepo(repository);
    const { data: connections } = await admin
      .from("git_connection")
      .select("app_id, repository")
      .in("app_id", pendingAppIds)
      .eq("provider", "github");
    appsConnectedHere = new Set(
      (connections ?? [])
        .filter(
          (c) =>
            canonicalTarget !== null &&
            canonicalPrCommentRepo(c.repository) === canonicalTarget,
        )
        .map((c) => c.app_id),
    );
  }
  const rows = anchored.filter(
    (r) => r.verification !== "pending" || appsConnectedHere.has(r.app_id),
  );
  if (rows.length === 0) return [];

  const appIds = [...new Set(rows.map((r) => r.app_id))];
  const [{ data: apps }, { data: envs }] = await Promise.all([
    admin.from("app").select("id, name").in("id", appIds),
    admin
      .from("environment")
      .select("app_id, name")
      .in("app_id", appIds)
      .eq("is_default", true),
  ]);
  const appNameById = new Map((apps ?? []).map((row) => [row.id, row.name]));
  const envNameByAppId = new Map((envs ?? []).map((row) => [row.app_id, row.name]));

  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    kind: KNOWN_KINDS.has(r.kind) ? r.kind : "file",
    caption: r.caption,
    criterionId: r.criterion_id,
    provenance: KNOWN_PROVENANCES.has(r.provenance)
      ? (r.provenance as PrArtifactRow["provenance"])
      : "local",
    emittedAt: r.emitted_at,
    appName: appNameById.get(r.app_id) ?? r.app_id,
    envName: envNameByAppId.get(r.app_id) ?? "",
  }));
}
