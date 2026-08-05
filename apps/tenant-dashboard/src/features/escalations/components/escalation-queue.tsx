"use client";

/**
 * Env-escalation queue.
 *
 * When env-prep's repair ladder exhausts its budget on a repo, the eval
 * worker writes an `env_escalation` row instead of failing silently. This
 * card is that queue's dashboard surface: each unbuildable repo shows as a
 * ticket with the last build error and the producer's suggested next step,
 * and the team moves it open → acked → resolved inline. Renders NOTHING
 * while the actionable set (open + acked) is empty — the queue is an
 * exception surface, not furniture.
 *
 * The queue's rows are read server-side by the benchmarks React Server Component (RSC) and seeded in;
 * the presentational `EscalationQueueView` holds no data logic, and the thin
 * `EscalationQueue` container owns only the transition call + its error state.
 * A successful ack/resolve re-renders the RSC (the action's revalidatePath),
 * which re-seeds the rows — there is no client refetch.
 */

import { useCallback, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  Collapse,
  IconButton,
  Stack,
  Typography,
} from "@mui/material";
import Iconify from "@/components/iconify";
import { LocalDate } from "@/components/local-date";
import type { EnvEscalationRow, EscalationStatus } from "../types";
import { transitionEscalation } from "../actions";

const MUTED = "#64748b";

const STATUS_STYLE: Record<EscalationStatus, { label: string; ink: string; soft: string }> = {
  open: { label: "open", ink: "#b91c1c", soft: "#fef2f2" },
  acked: { label: "acked", ink: "#92400e", soft: "#fffbeb" },
  resolved: { label: "resolved", ink: "#166534", soft: "#f0fdf4" },
};

function EscalationItem({
  escalation,
  onTransition,
}: {
  escalation: EnvEscalationRow;
  onTransition: (id: string, status: "acked" | "resolved") => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const style = STATUS_STYLE[escalation.status];
  const lastError = escalation.last_errors[0];

  return (
    <Box data-testid={`escalation-${escalation.id}`} sx={{ px: 2, py: 1.25, "&:not(:last-child)": { borderBottom: "1px solid #e2e8f0" } }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
        <IconButton
          size="small"
          aria-label={expanded ? "Collapse details" : "Expand details"}
          onClick={() => setExpanded((v) => !v)}
          sx={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 120ms" }}
        >
          <Iconify icon="eva:chevron-down-fill" width={18} />
        </IconButton>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 700 }} noWrap title={escalation.repo}>
            {escalation.repo}
          </Typography>
          <Typography sx={{ fontSize: 11.5, color: MUTED }}>
            <LocalDate value={escalation.created_at} format="numericDateTime" /> · {escalation.attempts} attempt{escalation.attempts === 1 ? "" : "s"} · $
            {Number(escalation.cost_usd).toFixed(2)} spent
          </Typography>
        </Box>
        <Box
          component="span"
          data-testid={`escalation-status-${escalation.id}`}
          sx={{ px: 1, py: 0.25, borderRadius: 1, fontSize: 11.5, fontWeight: 700, color: style.ink, bgcolor: style.soft }}
        >
          {style.label}
        </Box>
        {escalation.status === "open" && (
          <Button size="small" variant="outlined" onClick={() => onTransition(escalation.id, "acked")}>
            Acknowledge
          </Button>
        )}
        <Button size="small" variant="outlined" color="success" onClick={() => onTransition(escalation.id, "resolved")}>
          Resolve
        </Button>
      </Stack>
      <Collapse in={expanded}>
        <Box sx={{ pl: 5.5, pt: 1 }}>
          {lastError && (
            <Box sx={{ mb: 1 }}>
              <Typography sx={{ fontSize: 11.5, fontWeight: 700, color: MUTED }}>
                Last build error{lastError.stage ? ` (${lastError.stage})` : ""}
              </Typography>
              <Typography
                component="pre"
                sx={{ m: 0, fontSize: 11.5, fontFamily: "monospace", whiteSpace: "pre-wrap", color: "#334155", bgcolor: "#f8fafc", p: 1, borderRadius: 1 }}
              >
                {lastError.excerpt ?? "(no excerpt recorded)"}
              </Typography>
            </Box>
          )}
          {escalation.suggested_next_steps && (
            <Box>
              <Typography sx={{ fontSize: 11.5, fontWeight: 700, color: MUTED }}>Suggested next step</Typography>
              <Typography sx={{ fontSize: 12.5, color: "#334155" }}>{escalation.suggested_next_steps}</Typography>
            </Box>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}

/**
 * Presentational queue: renders the seeded rows and reports ack/resolve
 * intents through `onTransition`. Zero data-fetching, zero authorization —
 * both live server-side (the RSC read + the `env_escalation.update` action).
 * Self-hides when there is nothing actionable and no error to show.
 */
export function EscalationQueueView({
  escalations,
  onTransition,
  error,
}: {
  escalations: EnvEscalationRow[];
  onTransition: (id: string, status: "acked" | "resolved") => void;
  error?: string | null;
}) {
  if (escalations.length === 0 && !error) return null;

  return (
    <Card data-testid="escalation-queue" sx={{ p: 0 }}>
      <Box sx={{ px: 2, pt: 1.5, pb: 1 }}>
        <Typography sx={{ fontSize: 13.5, fontWeight: 700 }}>Environment build escalations</Typography>
        <Typography sx={{ fontSize: 12, color: MUTED }}>
          Repos whose eval environment could not be built — evals on them are blocked until the
          setup is fixed or the repo is descoped.
        </Typography>
      </Box>
      {error && (
        <Alert severity="error" sx={{ mx: 2, mb: 1 }}>
          {error}
        </Alert>
      )}
      {escalations.map((e) => (
        <EscalationItem key={e.id} escalation={e} onTransition={onTransition} />
      ))}
    </Card>
  );
}

/**
 * Container: seeds the view from the RSC-read `initialEscalations` and drives
 * the transition through the server action. Success re-seeds via the action's
 * revalidatePath; a failure surfaces inline without dropping the ticket. Only
 * the transition's own failure is state here — the read's failure stays a prop.
 */
export function EscalationQueue({
  appId,
  initialEscalations,
  readError = null,
}: {
  appId: string | undefined;
  initialEscalations: EnvEscalationRow[];
  /** Set when the RSC's queue read failed. Without it the self-hiding view
   *  would render nothing, and a blocked env would look like a clear one.
   *  Read straight through on every render rather than seeded into state —
   *  it is the server's current answer, so a re-render must be able to both
   *  clear a recovered failure and report a fresh one. */
  readError?: string | null;
}) {
  const [transitionError, setTransitionError] = useState<string | null>(null);

  const onTransition = useCallback(
    (escalationId: string, status: "acked" | "resolved") => {
      if (!appId) return;
      void transitionEscalation({ appId, escalationId, status }).then((res) => {
        if (!res.ok) {
          setTransitionError(res.error.message);
          return;
        }
        setTransitionError(res.data.kind === "not_found" ? "Escalation not found" : null);
      });
    },
    [appId],
  );

  return (
    <EscalationQueueView
      escalations={initialEscalations}
      onTransition={onTransition}
      // A failed ack/resolve is the more recent answer to the more recent
      // action, so it takes the slot while it stands.
      error={transitionError ?? readError}
    />
  );
}
