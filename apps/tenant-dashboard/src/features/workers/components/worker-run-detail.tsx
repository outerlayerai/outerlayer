"use client";

import { useState } from "react";
import { Alert, Box, Button, Card, IconButton, Stack, Typography } from "@mui/material";
import { useSnackbar } from "@/components/snackbar";
import Iconify from "@/components/iconify";
import { ErrorState } from "@/components/error-state";
import { PageSkeleton } from "@/components/page-skeleton";
import { getAgentDescriptor } from "@/lib/worker-agents";
import { WorkerRunStatusChip } from "./worker-run-status-chip";
import { AgentActivity, AgentAvatar, UserChatMessage } from "./worker-chat";
import { cancelWorker } from "../action-adapters";
import {
  formatDuration,
  isTerminalStatus,
  loadErrorMessage,
  useWorkerRun,
  type WorkerRunSummary,
} from "../hooks";

/**
 * The header and the thread share one focal column: a conversation reads better
 * at a bounded width than stretched across the full content frame, and the run's
 * controls belong beside the transcript they act on.
 */
const THREAD_MAX_WIDTH = 1080;

export function WorkerRunDetail({
  orgName,
  appId,
  runId,
  onBack,
}: {
  orgName: string;
  appId: string;
  runId: string;
  onBack: () => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const { run, events, error, isLoading, mutate } = useWorkerRun(orgName, appId, runId);
  const [cancelling, setCancelling] = useState(false);

  const handleCancel = async () => {
    setCancelling(true);
    try {
      const res = await cancelWorker({ appId, runId });
      if (res.error) {
        enqueueSnackbar("Could not cancel the run.", { variant: "error" });
      } else {
        enqueueSnackbar("Worker cancelled.", { variant: "info" });
        await mutate();
      }
    } finally {
      setCancelling(false);
    }
  };

  const live = run ? !isTerminalStatus(run.status) : true;

  return (
    <Stack spacing={2.5} sx={{ maxWidth: THREAD_MAX_WIDTH, mx: "auto" }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
        <IconButton size="small" onClick={onBack} aria-label="Back">
          <Iconify icon="eva:arrow-back-outline" width={20} />
        </IconButton>
        <AgentAvatar />
        <Typography variant="subtitle2">
          {run ? (getAgentDescriptor(run.agent)?.displayName ?? run.agent) : "…"}
        </Typography>
        {run && <WorkerRunStatusChip status={run.status} />}
        <Box sx={{ flexGrow: 1 }} />
        {run && live && (
          <Button size="small" color="error" variant="outlined" onClick={handleCancel} loading={cancelling}>
            Stop
          </Button>
        )}
      </Box>

      {error && !run && (
        <ErrorState
          data-testid="worker-run-error"
          title="Couldn't load this run"
          description={loadErrorMessage(error)}
          onRetry={() => void mutate()}
        />
      )}

      {isLoading && !run && (
        // Mirrors the transcript that follows. The header above is real, so the
        // placeholder brings no header block of its own.
        <PageSkeleton
          variant="table-page"
          header={false}
          filterBar={false}
          pager={false}
          rows={3}
          data-testid="worker-run-skeleton"
        />
      )}

      {run && (
        <>
          <UserChatMessage text={run.task_prompt} attachments={run.attachments} />
          <AgentActivity events={events} live={live} />
          {!live && <RunOutcome run={run} />}
          {!live && (
            <Typography variant="caption" color="text.secondary" sx={{ textAlign: "center" }}>
              {run.agent}
              {run.model ? ` · ${run.model}` : ""} · base {run.base_branch || "default"}
              {typeof run.cost_usd === "number" ? ` · $${run.cost_usd.toFixed(4)}` : ""}
              {typeof run.num_turns === "number" ? ` · ${run.num_turns} turns` : ""}
              {run.duration_ms ? ` · ${formatDuration(run.duration_ms)}` : ""}
            </Typography>
          )}
        </>
      )}
    </Stack>
  );
}

/** Terminal-state footer: PR card, no-changes note, or the failure. */
function RunOutcome({
  run,
}: {
  run: WorkerRunSummary & { base_branch: string; cost_usd: number | null; num_turns: number | null };
}) {
  if (run.pr_url) {
    return (
      <Card variant="outlined" sx={{ p: 2, ml: 5.5 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap" }}>
          <Iconify icon="mdi:source-pull" width={20} sx={{ color: "success.main" }} />
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography variant="subtitle2">Pull request ready</Typography>
            {run.branch_name && (
              <Typography variant="caption" sx={{ fontFamily: "monospace", color: "text.secondary" }}>
                {run.branch_name}
              </Typography>
            )}
          </Box>
          <Button
            size="small"
            variant="contained"
            href={run.pr_url}
            target="_blank"
            rel="noopener"
            endIcon={<Iconify icon="eva:external-link-outline" width={16} />}
          >
            {run.pr_number ? `View pull request #${run.pr_number}` : "View pull request"}
          </Button>
        </Box>
      </Card>
    );
  }
  if (run.status === "completed" && run.outcome === "changes" && run.branch_name) {
    return (
      <Card variant="outlined" sx={{ p: 2, ml: 5.5 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
          <Iconify icon="mdi:source-branch" width={20} sx={{ color: "success.main" }} />
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle2">Changes pushed</Typography>
            <Typography variant="caption" sx={{ fontFamily: "monospace", color: "text.secondary" }}>
              {run.branch_name}
            </Typography>
          </Box>
        </Box>
      </Card>
    );
  }
  if (run.status === "completed" && run.outcome === "no_changes") {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ ml: 5.5 }}>
        The agent finished without making changes.
      </Typography>
    );
  }
  if (run.error_message || run.status === "failed" || run.status === "timed_out") {
    return (
      <Alert severity={run.status === "timed_out" ? "warning" : "error"} sx={{ ml: 5.5 }}>
        {run.failure_code ? `${run.failure_code}: ` : ""}
        {run.error_message ?? "The run did not complete."}
      </Alert>
    );
  }
  return null;
}
