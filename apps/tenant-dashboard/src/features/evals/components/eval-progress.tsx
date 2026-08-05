"use client";

/**
 * Live trial matrix — task × config × trial cells that flip queued →
 * running → graded/failed as the runner resolves them, with a streaming
 * cost meter vs budget. Driven by the seeded fake runner here; the same
 * view renders real trial telemetry when the backend lands.
 */

import { Box, Card, LinearProgress, Stack, Tooltip, Typography } from "@mui/material";
import type { TrialCell } from "./fake-runner";

const CELL_COLOR: Record<TrialCell["status"], string> = {
  queued: "#d0d7de",
  running: "#54aeff",
  graded: "#2ea043",
  agent_error: "#cf222e",
  timeout: "#bf8700",
};

export function EvalProgress({
  cells,
  configs,
  budgetUsd,
  spentUsd,
}: {
  cells: TrialCell[];
  configs: [string, string];
  budgetUsd: number;
  spentUsd: number;
}) {
  const done = cells.filter((c) => c.status !== "queued" && c.status !== "running").length;
  const total = cells.length;
  const resolvedCount = cells.filter((c) => c.status === "graded" && c.resolved).length;

  return (
    <Card sx={{ p: 3 }} data-testid="eval-progress">
      <Stack direction="row" sx={{ justifyContent: "space-between", mb: 1 }}>
        <Typography variant="subtitle1">Running — {done}/{total} trials</Typography>
        <Typography variant="body2" color="text.secondary">
          ${spentUsd.toFixed(2)} / ${budgetUsd} · {resolvedCount} resolved
        </Typography>
      </Stack>
      <LinearProgress variant="determinate" value={total > 0 ? (done / total) * 100 : 0} sx={{ mb: 2 }} />

      <Stack direction="row" spacing={4}>
        {configs.map((configId) => {
          const configCells = cells.filter((c) => c.configId === configId);
          return (
            <Box key={configId}>
              <Typography variant="caption" color="text.secondary">{configId}</Typography>
              <Box
                sx={{
                  mt: 0.5,
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, 12px)",
                  gap: "3px",
                  maxWidth: 360,
                }}
              >
                {configCells.map((cell) => (
                  <Tooltip key={`${cell.taskId}-${cell.trialIndex}`} title={`${cell.taskId} · trial ${cell.trialIndex + 1} · ${cell.status}`}>
                    <Box
                      sx={{
                        width: 12,
                        height: 12,
                        borderRadius: "2px",
                        bgcolor: CELL_COLOR[cell.status],
                        transition: "background-color 200ms",
                      }}
                    />
                  </Tooltip>
                ))}
              </Box>
            </Box>
          );
        })}
      </Stack>

      <Stack direction="row" spacing={2} sx={{ mt: 2 }}>
        {(["graded", "running", "agent_error", "timeout"] as const).map((status) => (
          <Stack key={status} direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
            <Box sx={{ width: 10, height: 10, borderRadius: "2px", bgcolor: CELL_COLOR[status] }} />
            <Typography variant="caption" color="text.secondary">{status}</Typography>
          </Stack>
        ))}
      </Stack>
    </Card>
  );
}
