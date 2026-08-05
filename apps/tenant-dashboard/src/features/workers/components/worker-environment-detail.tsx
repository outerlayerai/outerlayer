"use client";

/**
 * Persistent worker environment rendered as a chat thread:
 * every turn is a user message + the agent's activity, in order, with a
 * composer pinned at the bottom to continue the session. The agent's session
 * is resumed between turns, so the thread reads as one conversation.
 */

import { useState } from "react";
import { Alert, Box, IconButton, Link, Stack, Typography } from "@mui/material";
import { useSnackbar } from "@/components/snackbar";
import Iconify from "@/components/iconify";
import Label from "@/components/label";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { PageSkeleton } from "@/components/page-skeleton";
import { getAgentDescriptor } from "@/lib/worker-agents";
import { AgentActivity, AgentAvatar, UserChatMessage } from "./worker-chat";
import { WorkerComposer, type ComposerAttachment } from "./worker-composer";
import { runEnvironmentTurn } from "../action-adapters";
import {
  isTerminalStatus,
  loadErrorMessage,
  useWorkerEnvironment,
  useWorkerRun,
  type WorkerEnvironmentStatus,
  type WorkerRunSummary,
} from "../hooks";

/**
 * The header and the thread share one focal column: a conversation reads better
 * at a bounded width than stretched across the full content frame, and the
 * session's identity belongs beside the turns it describes.
 */
const THREAD_MAX_WIDTH = 1080;

function envStatusColor(status: WorkerEnvironmentStatus): "success" | "info" | "default" | "error" {
  if (status === "active") return "info";
  if (status === "suspended") return "default";
  if (status === "destroyed") return "error";
  return "default";
}

export function WorkerEnvironmentDetail({
  orgName,
  appId,
  envId,
  onBack,
}: {
  orgName: string;
  appId: string;
  envId: string;
  onBack: () => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const { environment, turns, error, isLoading, mutate } = useWorkerEnvironment(orgName, appId, envId);
  const [followUp, setFollowUp] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const busy = environment?.current_run_id != null || turns.some((t) => !isTerminalStatus(t.status));
  const ended = environment?.status === "destroyed";

  const handleContinue = async () => {
    if (!followUp.trim()) return;
    setSubmitting(true);
    try {
      const res = await runEnvironmentTurn({
        appId,
        envId,
        taskPrompt: followUp.trim(),
        attachments:
          attachments.length > 0
            ? attachments.map((a) => ({ name: a.name, mime: a.mime, content: a.content }))
            : undefined,
      });
      if (res.busy) {
        enqueueSnackbar("This session is already running a turn.", { variant: "warning" });
        return;
      }
      if (res.error || !res.runId) {
        enqueueSnackbar(res.error ?? "Failed to start turn.", { variant: "error" });
        return;
      }
      setFollowUp("");
      setAttachments([]);
      await mutate();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Stack spacing={2.5} sx={{ maxWidth: THREAD_MAX_WIDTH, mx: "auto" }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap" }}>
        <IconButton size="small" onClick={onBack} aria-label="Back">
          <Iconify icon="eva:arrow-back-outline" width={20} />
        </IconButton>
        <AgentAvatar />
        <Typography variant="subtitle2">
          {environment ? (getAgentDescriptor(environment.agent)?.displayName ?? environment.agent) : "…"}
        </Typography>
        {environment?.model && (
          <Typography variant="caption" sx={{ color: "text.secondary", textTransform: "capitalize" }}>
            {environment.model}
          </Typography>
        )}
        {environment && <Label color={envStatusColor(environment.status)}>{environment.status}</Label>}
        {environment?.work_branch && (
          <Typography variant="caption" sx={{ fontFamily: "monospace", color: "text.secondary" }}>
            {environment.work_branch}
          </Typography>
        )}
      </Box>

      {error && !environment ? (
        // The composer is deliberately absent here: replying would post a turn
        // against a session whose state never loaded.
        <ErrorState
          data-testid="worker-session-error"
          title="Couldn't load this session"
          description={loadErrorMessage(error)}
          onRetry={() => void mutate()}
        />
      ) : isLoading && !environment ? (
        <PageSkeleton
          variant="table-page"
          header={false}
          filterBar={false}
          pager={false}
          rows={3}
          data-testid="worker-session-skeleton"
        />
      ) : (
        <>
          <Stack spacing={2.5}>
            {turns.map((turn) => (
              <TurnExchange key={turn.id} orgName={orgName} appId={appId} turn={turn} />
            ))}
          </Stack>

          {ended ? (
            <EmptyState
              data-testid="worker-session-ended"
              title="This session has ended"
              description="Its workspace is gone, so it can't take more turns. Start a new session to keep working."
            />
          ) : (
            <Box sx={{ position: "sticky", bottom: 16, zIndex: 2 }}>
              <WorkerComposer
                value={followUp}
                onChange={setFollowUp}
                onSubmit={handleContinue}
                busy={submitting || busy}
                placeholder={busy ? "The agent is working…" : "Reply to keep working in this session"}
                attachments={attachments}
                onAttachmentsChange={setAttachments}
                onAttachmentError={(message) => enqueueSnackbar(message, { variant: "warning" })}
              />
            </Box>
          )}
        </>
      )}
    </Stack>
  );
}

/**
 * One turn of the conversation: the user's prompt, then the agent's activity
 * for that run. Each exchange loads its own transcript and keeps polling
 * while the turn is live.
 */
function TurnExchange({
  orgName,
  appId,
  turn,
}: {
  orgName: string;
  appId: string;
  turn: WorkerRunSummary;
}) {
  const { run, events, error, mutate } = useWorkerRun(orgName, appId, turn.id);
  const status = run?.status ?? turn.status;
  const live = !isTerminalStatus(status);
  const prUrl = run?.pr_url ?? turn.pr_url;
  const errorMessage = run?.error_message ?? turn.error_message;
  const failureCode = run?.failure_code ?? turn.failure_code;

  return (
    <Stack spacing={2.5}>
      <UserChatMessage text={turn.task_prompt} attachments={run?.attachments ?? turn.attachments} />
      {error && events.length === 0 ? (
        // A card-sized failure per turn would break the reading flow of the
        // thread, and the turn's own outcome below still renders from the
        // summary — only the transcript is missing, so the notice is sized to
        // what was actually lost.
        <Stack
          direction="row"
          spacing={1}
          sx={{ ml: 5.5, alignItems: "center" }}
          data-testid={`turn-transcript-error-${turn.id}`}
        >
          <Typography variant="caption" color="text.secondary">
            This turn&apos;s transcript didn&apos;t load.
          </Typography>
          <Link component="button" type="button" variant="caption" onClick={() => void mutate()}>
            Retry
          </Link>
        </Stack>
      ) : (
        <AgentActivity events={events} live={live} />
      )}
      {!live && (status === "failed" || status === "timed_out") && (
        <Alert severity={status === "timed_out" ? "warning" : "error"} sx={{ ml: 5.5 }}>
          {failureCode ? `${failureCode}: ` : ""}
          {errorMessage ?? "The turn did not complete."}
        </Alert>
      )}
      {prUrl && (
        <Box sx={{ ml: 5.5 }}>
          <Link href={prUrl} target="_blank" rel="noopener" variant="body2">
            <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
              <Iconify icon="mdi:source-pull" width={16} />
              View pull request
            </Box>
          </Link>
        </Box>
      )}
    </Stack>
  );
}
