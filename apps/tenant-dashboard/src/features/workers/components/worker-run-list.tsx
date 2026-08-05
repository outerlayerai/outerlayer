"use client";

import {
  Box,
  Card,
  Link,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import Iconify from "@/components/iconify";
import { WorkerRunStatusChip } from "./worker-run-status-chip";
import { formatDuration, type WorkerRunSummary } from "../hooks";

export function WorkerRunList({
  runs,
  onSelect,
}: {
  runs: WorkerRunSummary[];
  onSelect: (runId: string) => void;
}) {
  // The empty case belongs to the caller, which owns the section around this
  // table and the difference between "no runs yet" and "the runs failed to
  // load" — a second empty card here would only drift from that one.
  return (
    <Card>
      <Box sx={{ overflowX: "auto" }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Task</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Result</TableCell>
              <TableCell>Duration</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {runs.map((run) => (
              <TableRow
                key={run.id}
                hover
                sx={{ cursor: "pointer" }}
                onClick={() => onSelect(run.id)}
              >
                <TableCell sx={{ maxWidth: 360 }}>
                  <Typography variant="body2" noWrap title={run.task_prompt}>
                    {run.task_prompt}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {run.agent}
                    {run.model ? ` · ${run.model}` : ""}
                  </Typography>
                </TableCell>
                <TableCell>
                  <WorkerRunStatusChip status={run.status} />
                </TableCell>
                <TableCell>
                  {run.pr_url ? (
                    <Link
                      href={run.pr_url}
                      target="_blank"
                      rel="noopener"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
                        <Iconify icon="eva:external-link-outline" width={16} />
                        <span>{run.pr_number ? `PR #${run.pr_number}` : "Pull request"}</span>
                      </Box>
                    </Link>
                  ) : run.outcome === "no_changes" ? (
                    <Typography variant="caption" color="text.secondary">
                      No changes
                    </Typography>
                  ) : run.error_message ? (
                    <Typography variant="caption" color="error.main" noWrap title={run.error_message}>
                      {run.failure_code ?? "error"}
                    </Typography>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell>{formatDuration(run.duration_ms)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>
    </Card>
  );
}
