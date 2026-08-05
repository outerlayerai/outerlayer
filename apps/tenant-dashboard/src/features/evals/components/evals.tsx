"use client";

/**
 * Benchmarks page — the Harness Report Card flow:
 * empty state → run wizard → live trial matrix → the Card.
 *
 * Runs on the seeded fake runner today so the whole flow is demonstrable with
 * no backend; swapping in the real gateway-dispatched runner leaves these
 * components unchanged — they render a CardStats-shaped model.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Alert, Box, Button, Card, Stack, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import type { ReportCard } from "@outerlayer/report-card";
import Iconify from "@/components/iconify";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { useSnackbar } from "@/components/snackbar";
import { EvalWizard } from "./eval-wizard";
import { EvalProgress } from "./eval-progress";
import { EvalCard } from "./eval-card";
import { EvalRunHistory } from "./eval-history";
import { EvalLandscape } from "./eval-landscape";
import { sampleLandscape } from "./landscape";
import {
  buildCardFromCells,
  planTrialCells,
  resolveCell,
  type EvalRunRequest,
  type TrialCell,
} from "./fake-runner";
import {
  isRealRunnerEnabled,
  loadRunDetail,
  refreshRunHistory,
  runRealEval,
  type EvalRunSummary,
} from "./real-runner";
import { EvalRunError } from "./run-error";

type Phase = "idle" | "running" | "done";
type View = "card" | "landscape";

/** How many cells resolve per animation tick (keeps the matrix lively). */
const CELLS_PER_TICK = 6;
const TICK_MS = 120;

/** Shared tail of every refusal caused by the page not knowing which app or org
 *  it is under. Both dispatching a run and opening a past one need a
 *  tenant-scoped URL, so both fail for the same reason and name the same
 *  remedy. */
const MISSING_CONTEXT_CAUSE =
  "this page is missing the app or organization it belongs to. Reload the page and try again.";

/** Human-readable message for anything thrown across this section's seams. */
function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function EvalsSection({
  appId,
  repoLabel = "your linked repo",
  initialRuns = [],
  runsError = null,
  environmentId,
}: {
  /** The app id, resolved server-side by the benchmarks React Server Component (RSC). */
  appId?: string;
  /** The app's linked repo (app.git_connection.repository), resolved
   *  server-side — the eval is always scoped to it; the user never picks a
   *  repo. */
  repoLabel?: string;
  /** Run history read server-side by the benchmarks RSC. */
  initialRuns?: EvalRunSummary[];
  /** Set when the RSC's run-history read failed. An empty `initialRuns` then
   *  means "unknown", not "none" — the two must not render alike. */
  runsError?: string | null;
  /** The env whose Vault env vars supply the agents' keys, resolved
   *  server-side by the benchmarks RSC from its own `[envName]` segment. */
  environmentId?: string;
} = {}) {
  // The org slug the page is under — the canonical run-status route derives its
  // tenant from it, so the poll URL must carry it.
  const { orgName } = useParams<{ orgName?: string }>();
  const router = useRouter();
  const { enqueueSnackbar } = useSnackbar();
  const [phase, setPhase] = useState<Phase>("idle");
  // A run failure snaps the matrix back to idle; without this the page
  // would look exactly as it did before the run was launched. `retryable`
  // gates the Retry action: re-dispatching is only an offer worth making when
  // the same inputs could succeed on a second attempt.
  const [runError, setRunError] = useState<{ message: string; retryable: boolean } | null>(null);
  const [view, setView] = useState<View>("card");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [request, setRequest] = useState<EvalRunRequest | null>(null);
  const [cells, setCells] = useState<TrialCell[]>([]);
  const [spentUsd, setSpentUsd] = useState(0);
  const [card, setCard] = useState<ReportCard | null>(null);
  // Persisted run history, seeded from the RSC read. A launch's revalidatePath
  // re-seeds this on the next render, but a run's terminal status/cost lands
  // later (the worker writes it while the client is mid-poll), so `runRealEval`
  // resolving also triggers an explicit refresh below.
  const [runs, setRuns] = useState<EvalRunSummary[]>(initialRuns);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setRuns(initialRuns);
  }, [initialRuns]);

  const startRun = useCallback((req: EvalRunRequest) => {
    setRequest(req);
    setCard(null);
    setSpentUsd(0);
    setRunError(null);
    // With a runner wired, a dispatch is addressed by both the app and its org
    // — the run-status poll route derives its tenant from the org slug, so
    // neither is optional. Missing either, the run cannot be dispatched, and
    // the seeded demo runner is not a fallback: it would present invented
    // numbers as a real benchmark. Refuse visibly instead.
    if (isRealRunnerEnabled()) {
      if (!appId || !orgName) {
        setCells([]);
        // No Retry: the missing app or org is a property of the page, not of
        // this attempt, so a second dispatch fails identically. Offering it
        // would invite the user to keep pressing past the fix the copy names.
        setRunError({
          message: `Couldn't start the benchmark: ${MISSING_CONTEXT_CAUSE}`,
          retryable: false,
        });
        setPhase("idle");
        return;
      }
      // Mark the matrix live, dispatch the run, render its Report Card.
      setCells(planTrialCells(req).map((c) => ({ ...c, status: "running" as const })));
      setPhase("running");
      void (async () => {
        try {
          const result = await runRealEval(appId, orgName, environmentId, req);
          setCard(result.card);
          setSpentUsd(result.spentUsd);
          setCells((prev) => prev.map((c) => ({ ...c, status: "graded" as const })));
          setPhase("done");
        } catch (err) {
          setRunError({
            message: messageOf(err, "The benchmark run failed."),
            // Only the runner can say whether a second attempt could differ —
            // a refused status read or a denied launch cannot. Anything else
            // reaching here is unclassified, where offering a retry is fair.
            retryable: err instanceof EvalRunError ? err.retryable : true,
          });
          setPhase("idle");
        }
        // Either way the run reached a terminal state — pick up its row (the
        // worker writes it independently of this poll, so the RSC-seeded list
        // can't see it until the next render without this explicit refresh).
        try {
          setRuns(await refreshRunHistory(appId));
        } catch (err) {
          // Toast, not an inline card: the run itself may have succeeded and
          // its Report Card is on screen — a stale history list must not
          // replace what the user is reading.
          enqueueSnackbar(messageOf(err, "Couldn't refresh the run history."), { variant: "error" });
        }
      })();
      return;
    }
    setCells(planTrialCells(req));
    setPhase("running");
  }, [appId, orgName, environmentId, enqueueSnackbar]);

  const retryRun = useCallback(() => {
    if (request) startRun(request);
  }, [request, startRun]);

  /** Open a past succeeded run's Report Card. The history row never carries
   *  the card (the list projection excludes it), so this fetches the single
   *  run's detail on demand rather than reading it off the row. */
  const openRun = useCallback((run: EvalRunSummary) => {
    // A queued, running or failed row has no card to open, and the row itself
    // already shows its status and the backend's error — so there is nothing
    // for a click to add. The history table only wires a click on openable
    // rows, making this a precondition rather than a path users reach.
    if (run.status !== "succeeded") return;
    // The detail read is tenant-scoped, so without the app or org there is no
    // URL to fetch. History rows are seeded server-side and stay clickable
    // regardless, which is what makes this reachable rather than theoretical.
    if (!appId || !orgName) {
      enqueueSnackbar(`Couldn't open that run: ${MISSING_CONTEXT_CAUSE}`, { variant: "error" });
      return;
    }
    // A previous dispatch's failure has nothing to say about the card this
    // click is about to open.
    setRunError(null);
    loadRunDetail(appId, orgName, run.id)
      .then((detail) => {
        if (!detail.card) {
          // The card IS the run's result, so a succeeded run without one is a
          // broken record, not an empty one. Returning quietly here would make
          // the click do nothing at all.
          enqueueSnackbar("That run finished without a Report Card, so there's nothing to open.", {
            variant: "error",
          });
          return;
        }
        setCard(detail.card);
        setSpentUsd(detail.cost_usd);
        setPhase("done");
      })
      .catch((err) => {
        // Toast: the history list the user just clicked stays on screen.
        enqueueSnackbar(messageOf(err, "Couldn't open that run."), { variant: "error" });
      });
  }, [appId, orgName, enqueueSnackbar]);

  // Animate the matrix: resolve cells in batches, then build the card.
  // (Fake-runner demo only — the real backend sets the card from its response.)
  //
  // This is the only thing that can move a fake run out of `running`, so its
  // condition must be the exact complement of the dispatch's: any input state
  // that reaches `running` through the fake path has to reach this animation
  // too, or the matrix stays live with nothing left to resolve it.
  useEffect(() => {
    if (phase !== "running" || !request || isRealRunnerEnabled()) return;
    let cursor = 0;
    timer.current = setInterval(() => {
      setCells((prev) => {
        if (cursor >= prev.length) {
          if (timer.current) clearInterval(timer.current);
          const finished = prev.map((c) => (c.status === "queued" ? resolveCell(request, c) : c));
          setCard(buildCardFromCells(request, finished));
          setPhase("done");
          return finished;
        }
        const next = prev.slice();
        for (let i = 0; i < CELLS_PER_TICK && cursor < next.length; i++, cursor++) {
          const cell = next[cursor];
          if (cell) next[cursor] = resolveCell(request, cell);
        }
        setSpentUsd((s) => Math.min(request.budgetUsd, s + CELLS_PER_TICK * 0.09));
        return next;
      });
    }, TICK_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [phase, request]);

  return (
    // The header owns the spacing beneath it, so the body below it — and only
    // the body — is what the section's own spacing applies to.
    <Box data-testid="evals-page">
      <PageHeader
        title="Benchmarks"
        caption="Compare two agent configs on your repo's execution-verified tasks — paired resolve-rate Δ, $-per-resolved-task, and where it breaks."
        actions={
          <>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={view}
              onChange={(_e, v: View | null) => v && setView(v)}
              aria-label="Benchmarks view"
            >
              <ToggleButton value="card" data-testid="view-card">Head-to-head</ToggleButton>
              <ToggleButton value="landscape" data-testid="view-landscape">Landscape</ToggleButton>
            </ToggleButtonGroup>
            <Button variant="contained" onClick={() => setWizardOpen(true)} data-testid="new-eval">
              New benchmark
            </Button>
          </>
        }
      />

      <Stack spacing={3}>
        {/* Above the view toggle, not inside the card flow: the wizard launches
            from either view, so a dispatch failure in Landscape would otherwise
            set state nothing renders — the same silent-idle outcome the inline
            error exists to prevent. */}
        {runError && (
          <Alert
            severity="error"
            data-testid="eval-run-error"
            action={
              // MUI drops its own close affordance whenever `action` is set, so
              // Dismiss is spelled out here rather than passed as `onClose`.
              <Stack direction="row" spacing={0.5}>
                {request && runError.retryable && (
                  <Button color="inherit" size="small" onClick={retryRun} data-testid="eval-run-retry">
                    Retry
                  </Button>
                )}
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => setRunError(null)}
                  data-testid="eval-run-error-dismiss"
                >
                  Dismiss
                </Button>
              </Stack>
            }
          >
            {runError.message}
          </Alert>
        )}

        {view === "landscape" ? (
          <EvalLandscape points={sampleLandscape()} repoLabel={repoLabel} />
        ) : (
          <CardFlow
            phase={phase}
            request={request}
            cells={cells}
            spentUsd={spentUsd}
            card={card}
            runs={runs}
            runsError={runsError}
            onOpenRun={openRun}
            onRefreshRuns={() => router.refresh()}
            onReset={() => setPhase("idle")}
          />
        )}
      </Stack>

      <EvalWizard open={wizardOpen} onClose={() => setWizardOpen(false)} onRun={startRun} repoLabel={repoLabel} />
    </Box>
  );
}

function CardFlow({
  phase,
  request,
  cells,
  spentUsd,
  card,
  runs,
  runsError,
  onOpenRun,
  onRefreshRuns,
  onReset,
}: {
  phase: Phase;
  request: EvalRunRequest | null;
  cells: TrialCell[];
  spentUsd: number;
  card: ReportCard | null;
  runs: EvalRunSummary[];
  runsError: string | null;
  onOpenRun: (run: EvalRunSummary) => void;
  onRefreshRuns: () => void;
  onReset: () => void;
}) {
  return (
    <>
      {phase === "idle" && runs.length > 0 && (
        <EvalRunHistory runs={runs} onOpen={onOpenRun} />
      )}

      {/* A failed history read with no rows replaces the cold-start card —
          rendering "No benchmarks yet" here would state as fact something the
          page could not determine. */}
      {phase === "idle" && runs.length === 0 && runsError && (
        <Card sx={{ p: 6 }} data-testid="evals-runs-error">
          <Stack spacing={1.5} sx={{ alignItems: "center", textAlign: "center" }}>
            <Typography variant="h6">Couldn&apos;t load run history</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 480 }}>
              {runsError}
            </Typography>
            <Button size="small" onClick={onRefreshRuns} startIcon={<Iconify icon="eva:refresh-fill" />}>
              Retry now
            </Button>
          </Stack>
        </Card>
      )}

      {phase === "idle" && runs.length === 0 && !runsError && (
        <EmptyState
          data-testid="evals-empty"
          title="No benchmarks yet"
          description="Run a Report Card to compare two configs on this repo's validated tasks. Every card shows its verdict tier and the minimum detectable difference — no naked winners."
        />
      )}

      {phase === "running" && request && (
        <EvalProgress cells={cells} configs={[request.configs[0].id, request.configs[1].id]} budgetUsd={request.budgetUsd} spentUsd={spentUsd} />
      )}

      {phase === "done" && card && (
        <Stack spacing={2}>
          <EvalCard card={card} />
          <Button variant="text" onClick={onReset} sx={{ alignSelf: "flex-start" }}>
            ← Back to benchmarks
          </Button>
        </Stack>
      )}
    </>
  );
}
