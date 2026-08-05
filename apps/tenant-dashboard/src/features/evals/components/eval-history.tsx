"use client";

/**
 * Persisted run history for the Evals page.
 *
 * The page dispatches runs fire-and-forget and the worker writes the Report
 * Card to `eval_run` — so history is the only way a completed run is visible
 * after a reload. Succeeded runs open their card via an on-demand fetch;
 * failed runs surface the backend's error inline (never a silent hole in the
 * list).
 */

import {
  Box,
  Card,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { verdictLabel } from "@outerlayer/report-card";
import { LocalDate } from "@/components/local-date";
import { VERDICT_STYLE } from "./eval-card";
import type { EvalRunSummary } from "./real-runner";

const MUTED = "#64748b";

const money = (n: number) => (Number.isFinite(n) ? `$${n.toFixed(2)}` : "—");

function comparison(run: EvalRunSummary): string {
  const ids = run.request.configs?.map((c) => c.id) ?? [];
  return ids.length === 2 ? `${ids[0]} vs ${ids[1]}` : ids.join(" vs ") || "—";
}

function scale(run: EvalRunSummary): string {
  const { taskCount, trialsPerTask } = run.request;
  return taskCount && trialsPerTask ? `${taskCount} × ${trialsPerTask}` : "—";
}

/** Verdict pill for succeeded runs; status text (with the error) otherwise. */
function Outcome({ run }: { run: EvalRunSummary }) {
  if (run.status === "succeeded" && run.card) {
    const v = VERDICT_STYLE[run.card.verdict];
    return (
      <Box
        component="span"
        data-testid={`run-verdict-${run.id}`}
        sx={{
          px: 1,
          py: 0.25,
          borderRadius: 1,
          fontSize: 12,
          fontWeight: 700,
          color: v.ink,
          bgcolor: v.soft,
          border: `1px solid ${v.border}`,
        }}
      >
        {verdictLabel(run.card.verdict)}
      </Box>
    );
  }
  return (
    <Stack spacing={0.25}>
      <Typography sx={{ fontSize: 12.5, fontWeight: 600, color: run.status === "failed" ? "#b91c1c" : MUTED }}>
        {run.status}
      </Typography>
      {run.error && (
        <Typography sx={{ fontSize: 11.5, color: MUTED, maxWidth: 360 }} noWrap title={run.error}>
          {run.error}
        </Typography>
      )}
    </Stack>
  );
}

export function EvalRunHistory({
  runs,
  onOpen,
}: {
  runs: EvalRunSummary[];
  /** Called with a succeeded run to fetch and render its Report Card — the
   *  row itself never carries the card. */
  onOpen: (run: EvalRunSummary) => void;
}) {
  return (
    <Card data-testid="eval-history">
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>When</TableCell>
            <TableCell>Comparison</TableCell>
            <TableCell>Tasks × trials</TableCell>
            <TableCell>Outcome</TableCell>
            <TableCell align="right">Cost</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {runs.map((run) => {
            const openable = run.status === "succeeded";
            return (
              <TableRow
                key={run.id}
                hover={openable}
                data-testid={`eval-run-${run.id}`}
                onClick={openable ? () => onOpen(run) : undefined}
                sx={openable ? { cursor: "pointer" } : undefined}
              >
                <TableCell sx={{ whiteSpace: "nowrap" }}>
                  <LocalDate value={run.created_at} format="numericDateTime" />
                </TableCell>
                <TableCell sx={{ fontWeight: 600 }}>{comparison(run)}</TableCell>
                <TableCell>{scale(run)}</TableCell>
                <TableCell>
                  <Outcome run={run} />
                </TableCell>
                <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {money(run.cost_usd)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
