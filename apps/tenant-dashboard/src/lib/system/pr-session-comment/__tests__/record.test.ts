/**
 * recordEvidenceEvaluation: the append-only evaluation record behind the
 * verdict (AC-082-08's write path). Driven directly, against the PostgREST
 * fake, so the change gate's exact semantics are pinned: dedupe must be
 * insensitive to jsonb key reordering (Postgres reorders keys at rest) and
 * sensitive to everything that means a different evaluation — including
 * array order, which is PR commit order.
 */
import { describe, it, expect, vi } from "vitest";

import {
  seedPrEvidenceEvaluationMswState,
  getPrEvidenceEvaluationRows,
} from "@/test-helpers/msw-handlers";
import { server } from "@/test-helpers/msw-server";
import { http, HttpResponse } from "msw";

const mockLoggerError = vi.fn();
vi.mock("@/lib/observability/server-logger", () => ({
  serverLogger: {
    info: vi.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

import { getAdminDataClient } from "@/lib/system/admin-client";
import type { EvidenceEvaluation } from "../evaluate";
import { recordEvidenceEvaluation } from "../record";

const SUPABASE_URL = "http://localhost:54321";
const PARAMS = { tenantId: "tenant-1", repository: "acme/api", prNumber: 812 };

/** A flagged single-fact evaluation, the richest shape the gate compares. */
function flaggedEvaluation(): EvidenceEvaluation {
  return {
    verdict: "flag",
    flaggedCount: 1,
    pendingLinkCount: 0,
    facts: [
      {
        id: "commits-from-sessions",
        status: "flag",
        class: "amber",
        matchedCommitCount: 1,
        totalCommitCount: 3,
        unrecordedShas: ["aaaa111", "bbbb222"],
      },
    ],
  };
}

/** The same fact as stored jsonb would return it — keys in a DIFFERENT
 * order, which is exactly what Postgres jsonb does at rest. */
function storedFactReordered() {
  return {
    unrecordedShas: ["aaaa111", "bbbb222"],
    totalCommitCount: 3,
    status: "flag",
    matchedCommitCount: 1,
    id: "commits-from-sessions",
    class: "amber",
  };
}

function seedLatest(over: Partial<Parameters<typeof seedPrEvidenceEvaluationMswState>[0][0]> = {}) {
  seedPrEvidenceEvaluationMswState([
    {
      tenant_id: PARAMS.tenantId,
      repository: PARAMS.repository,
      pr_number: PARAMS.prNumber,
      verdict: "flag",
      facts: [storedFactReordered()],
      pending_link_count: 0,
      evaluated_at: "2026-08-13T00:00:00.000Z",
      ...over,
    },
  ]);
}

describe("recordEvidenceEvaluation", () => {
  // AC-082-08: the first evaluation of a PR is stored verbatim.
  it("inserts the evaluation's verdict, facts, and pending count on first record", async () => {
    await recordEvidenceEvaluation(getAdminDataClient(), PARAMS, flaggedEvaluation());

    expect(getPrEvidenceEvaluationRows()).toEqual([
      expect.objectContaining({
        tenant_id: PARAMS.tenantId,
        repository: PARAMS.repository,
        pr_number: PARAMS.prNumber,
        verdict: "flag",
        pending_link_count: 0,
        facts: flaggedEvaluation().facts,
      }),
    ]);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  // AC-082-08 + AC-082-07: an identical evaluation appends nothing — even
  // though jsonb hands the stored facts back with keys in a different order.
  it("does not append when the latest stored row is identical, regardless of jsonb key order", async () => {
    seedLatest();

    await recordEvidenceEvaluation(getAdminDataClient(), PARAMS, flaggedEvaluation());

    expect(getPrEvidenceEvaluationRows()).toHaveLength(1);
  });

  it("appends when the verdict changed", async () => {
    seedLatest({ verdict: "pass" });

    await recordEvidenceEvaluation(getAdminDataClient(), PARAMS, flaggedEvaluation());

    expect(getPrEvidenceEvaluationRows()).toHaveLength(2);
  });

  it("appends when the pending link count changed", async () => {
    seedLatest({ pending_link_count: 2 });

    await recordEvidenceEvaluation(getAdminDataClient(), PARAMS, flaggedEvaluation());

    expect(getPrEvidenceEvaluationRows()).toHaveLength(2);
  });

  it("appends when a fact's value changed", async () => {
    seedLatest({ facts: [{ ...storedFactReordered(), matchedCommitCount: 2 }] });

    await recordEvidenceEvaluation(getAdminDataClient(), PARAMS, flaggedEvaluation());

    expect(getPrEvidenceEvaluationRows()).toHaveLength(2);
  });

  // Array order is meaning (unrecorded commits are listed in PR order), so
  // reordered shas are a DIFFERENT evaluation, not a jsonb artifact.
  it("appends when the unrecorded shas are the same set in a different order", async () => {
    seedLatest({
      facts: [{ ...storedFactReordered(), unrecordedShas: ["bbbb222", "aaaa111"] }],
    });

    await recordEvidenceEvaluation(getAdminDataClient(), PARAMS, flaggedEvaluation());

    expect(getPrEvidenceEvaluationRows()).toHaveLength(2);
  });

  it("appends when the stored fact list is longer or shorter than the evaluation's", async () => {
    seedLatest({ facts: [storedFactReordered(), storedFactReordered()] });

    await recordEvidenceEvaluation(getAdminDataClient(), PARAMS, flaggedEvaluation());

    expect(getPrEvidenceEvaluationRows()).toHaveLength(2);
  });

  // A stored fact from an older code version can carry a different field
  // set; that is a different evaluation, not an equal one.
  it("appends when the stored fact carries a different field set of the same size", async () => {
    const stored = storedFactReordered() as Record<string, unknown>;
    delete stored.class;
    stored.severity = "amber";
    seedLatest({ facts: [stored] });

    await recordEvidenceEvaluation(getAdminDataClient(), PARAMS, flaggedEvaluation());

    expect(getPrEvidenceEvaluationRows()).toHaveLength(2);
  });

  // The gate compares against the LATEST row, not the first: history where
  // an old row matches but the newest differs must still append.
  it("compares against the newest stored row, not an older matching one", async () => {
    seedPrEvidenceEvaluationMswState([
      {
        tenant_id: PARAMS.tenantId,
        repository: PARAMS.repository,
        pr_number: PARAMS.prNumber,
        verdict: "flag",
        facts: [storedFactReordered()],
        pending_link_count: 0,
        evaluated_at: "2026-08-12T00:00:00.000Z",
      },
      {
        tenant_id: PARAMS.tenantId,
        repository: PARAMS.repository,
        pr_number: PARAMS.prNumber,
        verdict: "pass",
        facts: [],
        pending_link_count: 0,
        evaluated_at: "2026-08-13T00:00:00.000Z",
      },
    ]);

    await recordEvidenceEvaluation(getAdminDataClient(), PARAMS, flaggedEvaluation());

    expect(getPrEvidenceEvaluationRows()).toHaveLength(3);
  });

  it("only dedupes against this PR's own rows", async () => {
    seedLatest({ pr_number: 999 });

    await recordEvidenceEvaluation(getAdminDataClient(), PARAMS, flaggedEvaluation());

    expect(getPrEvidenceEvaluationRows()).toHaveLength(2);
  });

  // Best-effort contract: a recording failure is logged as its own event
  // and never propagated — the comment must not be lost to telemetry.
  it("logs record_failed and does not throw when the latest-row read fails", async () => {
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/pr_evidence_evaluation`, () =>
        HttpResponse.json({ message: "boom" }, { status: 500 }),
      ),
    );

    await expect(
      recordEvidenceEvaluation(getAdminDataClient(), PARAMS, flaggedEvaluation()),
    ).resolves.toBeUndefined();

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        event: "pr_evidence_evaluation.record_failed",
        tenantId: PARAMS.tenantId,
        repository: PARAMS.repository,
        prNumber: PARAMS.prNumber,
      }),
    );
  });

  it("logs record_failed and does not throw when the insert fails", async () => {
    server.use(
      http.post(`${SUPABASE_URL}/rest/v1/pr_evidence_evaluation`, () =>
        HttpResponse.json({ message: "boom" }, { status: 500 }),
      ),
    );

    await expect(
      recordEvidenceEvaluation(getAdminDataClient(), PARAMS, flaggedEvaluation()),
    ).resolves.toBeUndefined();

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ event: "pr_evidence_evaluation.record_failed" }),
    );
  });
});
