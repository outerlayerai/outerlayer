"use client";

import { useCallback, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Box,
  Card,
  Collapse,
  IconButton,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useSnackbar } from "@/components/snackbar";
import Iconify from "@/components/iconify";
import Label from "@/components/label";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { PageSkeleton } from "@/components/page-skeleton";
import { useBoolean } from "@/hooks/use-boolean";
import { useOptionalEnvContext } from "@/context/env-context";
import type { EntitlementDeniedInfo } from "@/config/entitlements";
import { UpgradePrompt } from "@/components/upgrade-prompt/upgrade-prompt";
import { WORKER_AGENTS, getAgentDescriptor } from "@/lib/worker-agents";
import { WorkerComposer, type ComposerAttachment } from "./worker-composer";
import { WorkerRunList } from "./worker-run-list";
import { WorkerRunDetail } from "./worker-run-detail";
import { WorkerEnvironmentDetail } from "./worker-environment-detail";
import { createEnvironment, launchWorker } from "../action-adapters";
import {
  loadErrorMessage,
  useWorkerEnvironments,
  useWorkerRuns,
  type WorkerEnvironmentSummary,
  type WorkerRunSummary,
} from "../hooks";

const CAP_OPTIONS = [
  { label: "15 minutes", value: 900 },
  { label: "30 minutes", value: 1800 },
  { label: "60 minutes", value: 3600 },
];

export function WorkersSection({ orgName, appId }: { orgName: string; appId: string }) {
  const env = useOptionalEnvContext();
  const environmentId = env?.selectedEnv.id ?? null;

  const { enqueueSnackbar } = useSnackbar();
  // Selection lives in the URL (?run= / ?session=) so every run and session
  // has a shareable deep link — the same links the /v1 API hands back — and
  // a refresh keeps your place.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedRunId = searchParams.get("run");
  const selectedEnvId = searchParams.get("session");
  const setSelectedRunId = useCallback(
    (id: string | null) => router.replace(id ? `${pathname}?run=${id}` : pathname, { scroll: false }),
    [router, pathname],
  );
  const setSelectedEnvId = useCallback(
    (id: string | null) => router.replace(id ? `${pathname}?session=${id}` : pathname, { scroll: false }),
    [router, pathname],
  );
  const { runs, error: runsError, isLoading: runsLoading, mutate: mutateRuns } = useWorkerRuns(orgName, appId);
  const {
    environments,
    error: envsError,
    isLoading: envsLoading,
    mutate: mutateEnvs,
  } = useWorkerEnvironments(orgName, appId);

  const [agent, setAgent] = useState(WORKER_AGENTS[0]?.id ?? "claude-code");
  const [model, setModel] = useState<string | undefined>(WORKER_AGENTS[0]?.models?.default);
  const agentModels = getAgentDescriptor(agent)?.models ?? null;
  const [taskPrompt, setTaskPrompt] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [baseBranch, setBaseBranch] = useState("");
  const [wallClockCapS, setWallClockCapS] = useState(1800);
  const [persistent, setPersistent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [denied, setDenied] = useState<EntitlementDeniedInfo | null>(null);
  const optionsOpen = useBoolean(false);

  const handleSubmit = async () => {
    if (!appId || !taskPrompt.trim()) return;
    setSubmitting(true);
    setDenied(null);
    const attachmentInputs =
      attachments.length > 0
        ? attachments.map((a) => ({ name: a.name, mime: a.mime, content: a.content }))
        : undefined;
    try {
      if (persistent) {
        const res = await createEnvironment({
          appId,
          agent,
          model,
          taskPrompt: taskPrompt.trim(),
          attachments: attachmentInputs,
          baseBranch: baseBranch.trim() || undefined,
        });
        if (res.entitlement) {
          setDenied(res.entitlement);
          return;
        }
        if (res.error || !res.environmentId) {
          enqueueSnackbar(res.error ?? "Failed to create environment.", { variant: "error" });
          return;
        }
        setTaskPrompt("");
        setAttachments([]);
        void mutateEnvs();
        setSelectedEnvId(res.environmentId);
        return;
      }

      const res = await launchWorker({
        appId,
        agent,
        model,
        taskPrompt: taskPrompt.trim(),
        attachments: attachmentInputs,
        baseBranch: baseBranch.trim() || undefined,
        // Omit when the env context hasn't resolved — the server falls back to
        // the app's default environment.
        environmentId: environmentId ?? undefined,
        wallClockCapS,
      });
      if (res.entitlement) {
        setDenied(res.entitlement);
        return;
      }
      if (res.error || !res.runId) {
        enqueueSnackbar(res.error ?? "Failed to launch worker.", { variant: "error" });
        return;
      }
      setTaskPrompt("");
      setAttachments([]);
      void mutateRuns();
      setSelectedRunId(res.runId);
    } catch (err) {
      enqueueSnackbar(err instanceof Error ? err.message : "Failed to launch worker.", { variant: "error" });
    } finally {
      setSubmitting(false);
    }
  };

  if (selectedEnvId) {
    return <WorkerEnvironmentDetail orgName={orgName} appId={appId} envId={selectedEnvId} onBack={() => setSelectedEnvId(null)} />;
  }
  if (selectedRunId) {
    return <WorkerRunDetail orgName={orgName} appId={appId} runId={selectedRunId} onBack={() => setSelectedRunId(null)} />;
  }

  return (
    <Stack spacing={3}>
      {/* The heading is the composer's label, not a page title: it asks for
          input, carries no actions or entity identity, and is centered over the
          field it introduces. `PageHeader` would left-align it away from that
          column for no typographic gain — it is already an h4 over a secondary
          body2 line, which is that component's whole anatomy. */}
      <Box sx={{ textAlign: "center", pt: 2 }}>
        <Typography variant="h4">What should the agent work on?</Typography>
        <Typography variant="body2" color="text.secondary">
          It clones your repo on a managed machine, does the task, and opens a pull request.
        </Typography>
      </Box>

      <Box>
        {denied && (
          <Box sx={{ mb: 2 }}>
            <UpgradePrompt info={denied} variant="inline" />
          </Box>
        )}
        <WorkerComposer
          value={taskPrompt}
          onChange={setTaskPrompt}
          onSubmit={handleSubmit}
          busy={submitting}
          autoFocus
          placeholder="Describe a task, e.g. Add a /version endpoint that returns the package version"
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          onAttachmentError={(message) => enqueueSnackbar(message, { variant: "warning" })}
          controls={
            <>
              <TextField
                select
                size="small"
                value={agent}
                onChange={(e) => {
                  const next = e.target.value;
                  setAgent(next);
                  // Reset the model to the new agent's default (its options differ).
                  setModel(getAgentDescriptor(next)?.models?.default);
                }}
                variant="standard"
                slotProps={{ input: { disableUnderline: true } }}
                sx={{ minWidth: 120, "& .MuiSelect-select": { typography: "body2", color: "text.secondary" } }}
                aria-label="Agent"
              >
                {WORKER_AGENTS.map((a) => (
                  <MenuItem key={a.id} value={a.id}>
                    {a.displayName}
                    {a.experimental ? " (experimental)" : ""}
                  </MenuItem>
                ))}
              </TextField>
              {agentModels && (
                <TextField
                  select
                  size="small"
                  value={model ?? agentModels.default}
                  onChange={(e) => setModel(e.target.value)}
                  variant="standard"
                  slotProps={{ input: { disableUnderline: true } }}
                  sx={{ minWidth: 90, "& .MuiSelect-select": { typography: "body2", color: "text.secondary" } }}
                  aria-label="Model"
                >
                  {agentModels.options.map((m) => (
                    <MenuItem key={m.id} value={m.id}>
                      {m.label}
                    </MenuItem>
                  ))}
                </TextField>
              )}
              <Tooltip title="Keep the workspace warm and continue the conversation across turns.">
                <Box sx={{ display: "flex", alignItems: "center" }}>
                  <Switch size="small" checked={persistent} onChange={(e) => setPersistent(e.target.checked)} />
                  <Typography variant="body2" color="text.secondary">
                    Persistent session
                  </Typography>
                </Box>
              </Tooltip>
              <Tooltip title="Options">
                <IconButton size="small" onClick={optionsOpen.onToggle} aria-label="Options">
                  <Iconify icon="eva:options-2-outline" width={18} />
                </IconButton>
              </Tooltip>
            </>
          }
        />
        <Collapse in={optionsOpen.value}>
          <Box sx={{ display: "flex", gap: 2, mt: 2, flexWrap: "wrap" }}>
            <TextField
              label="Base branch"
              size="small"
              placeholder="defaults to the app's tracked branch"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              sx={{ minWidth: 280 }}
            />
            {!persistent && (
              <TextField
                select
                label="Time limit"
                size="small"
                value={wallClockCapS}
                onChange={(e) => setWallClockCapS(Number(e.target.value))}
                sx={{ minWidth: 160 }}
              >
                {CAP_OPTIONS.map((o) => (
                  <MenuItem key={o.value} value={o.value}>
                    {o.label}
                  </MenuItem>
                ))}
              </TextField>
            )}
          </Box>
        </Collapse>
      </Box>

      <WorkerHistory
        runs={runs}
        environments={environments}
        runsError={runsError}
        envsError={envsError}
        loading={runsLoading || envsLoading}
        onRetryRuns={() => void mutateRuns()}
        onRetryEnvs={() => void mutateEnvs()}
        onSelectRun={setSelectedRunId}
        onSelectEnv={setSelectedEnvId}
      />
    </Stack>
  );
}

/**
 * The sessions and runs history below the composer.
 *
 * Each list resolves error before empty: a failed poll yields an empty array, so
 * deciding emptiness first would report a transient failure as an account with
 * no work in it. One list failing never blanks the other.
 */
function WorkerHistory({
  runs,
  environments,
  runsError,
  envsError,
  loading,
  onRetryRuns,
  onRetryEnvs,
  onSelectRun,
  onSelectEnv,
}: {
  runs: WorkerRunSummary[];
  environments: WorkerEnvironmentSummary[];
  runsError: unknown;
  envsError: unknown;
  loading: boolean;
  onRetryRuns: () => void;
  onRetryEnvs: () => void;
  onSelectRun: (id: string) => void;
  onSelectEnv: (id: string) => void;
}) {
  if (loading) {
    // Shaped like the runs table it precedes. No header block — the composer's
    // heading already rendered above it — and neither list carries a filter bar
    // or a pager, so reserving either would reflow the page on the very axis a
    // placeholder exists to hold still.
    return (
      <PageSkeleton
        variant="table-page"
        header={false}
        filterBar={false}
        pager={false}
        rows={4}
        data-testid="workers-history-skeleton"
      />
    );
  }

  if (runsError && envsError) {
    return (
      <ErrorState
        data-testid="workers-history-error"
        title="Couldn't load your workers"
        description={loadErrorMessage(runsError)}
        onRetry={() => {
          onRetryRuns();
          onRetryEnvs();
        }}
      />
    );
  }

  if (!runsError && !envsError && environments.length === 0 && runs.length === 0) {
    return (
      <EmptyState
        variant="dashed"
        data-testid="workers-history-empty"
        title="No runs or sessions yet"
        description="Send a task above and it shows up here — one-shot work under Runs, and anything started as a persistent session under Sessions."
      />
    );
  }

  return (
    <>
      <Box>
        <Typography variant="overline" color="text.secondary">
          Sessions
        </Typography>
        <Box sx={{ mt: 1 }}>
          {envsError ? (
            <ErrorState
              data-testid="workers-sessions-error"
              title="Couldn't load sessions"
              description={loadErrorMessage(envsError)}
              onRetry={onRetryEnvs}
            />
          ) : environments.length === 0 ? (
            <EmptyState
              data-testid="workers-sessions-empty"
              title="No persistent sessions"
              description="Turn on Persistent session before sending a task to keep the workspace warm and reply across turns."
            />
          ) : (
            <Stack spacing={1}>
              {environments.map((e) => (
                <EnvironmentRow key={e.id} environment={e} onSelect={() => onSelectEnv(e.id)} />
              ))}
            </Stack>
          )}
        </Box>
      </Box>

      <Box>
        <Typography variant="overline" color="text.secondary">
          Runs
        </Typography>
        <Box sx={{ mt: 1 }}>
          {runsError ? (
            <ErrorState
              data-testid="workers-runs-error"
              title="Couldn't load runs"
              description={loadErrorMessage(runsError)}
              onRetry={onRetryRuns}
            />
          ) : runs.length === 0 ? (
            <EmptyState
              data-testid="workers-runs-empty"
              title="No worker runs yet"
              description="Send a task above to have a coding agent implement it against your repo."
            />
          ) : (
            <WorkerRunList runs={runs} onSelect={onSelectRun} />
          )}
        </Box>
      </Box>
    </>
  );
}

function EnvironmentRow({
  environment,
  onSelect,
}: {
  environment: WorkerEnvironmentSummary;
  onSelect: () => void;
}) {
  return (
    <Card variant="outlined" onClick={onSelect} sx={{ p: 1.5, cursor: "pointer" }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
        <Iconify icon="eva:message-circle-outline" width={20} sx={{ color: "text.secondary" }} />
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="body2" noWrap>
            {environment.work_branch ?? environment.id}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {environment.agent} · {environment.substrate}
          </Typography>
        </Box>
        {environment.current_run_id ? (
          <Label color="info">running</Label>
        ) : (
          <Label color={environment.status === "suspended" ? "default" : "success"}>{environment.status}</Label>
        )}
      </Box>
    </Card>
  );
}
