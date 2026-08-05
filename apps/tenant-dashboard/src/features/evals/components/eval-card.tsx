"use client";

/**
 * The Harness Report Card, rendered in MUI from the @outerlayer/report-card
 * model. The verdict chip and the MDE line are ALWAYS in the
 * JSX — the integrity rule ("never a naked winner") holds structurally, and
 * eval-card.test.tsx asserts the chip + MDE render for every tier. "Export
 * HTML" hands off to the package's self-contained renderer, so the dashboard
 * card and the CLI/forwardable card are one source of truth.
 */

import {
  Box,
  Button,
  Card,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { renderCardHtml, verdictLabel, type ReportCard, type Verdict } from "@outerlayer/report-card";

// Explicit, high-contrast palette per verdict — the theme's `secondary`/muted
// tones rendered gray-on-gray and were unreadable. Every value here is chosen
// for legibility on white (ink) or as a solid pill fill (main + #fff text).
export const VERDICT_STYLE: Record<Verdict, { main: string; ink: string; soft: string; border: string }> = {
  clear: { main: "#16a34a", ink: "#15803d", soft: "#f0fdf4", border: "#bbf7d0" },
  directional: { main: "#d97706", ink: "#b45309", soft: "#fffbeb", border: "#fde68a" },
  underpowered: { main: "#475569", ink: "#334155", soft: "#f8fafc", border: "#e2e8f0" },
};

const INK = "#0f172a";
const MUTED = "#64748b";
const HAIRLINE = "#e5e7eb";
const A_COLOR = "#4f46e5"; // config A — indigo
const B_COLOR = "#0891b2"; // config B — cyan

const signedPp = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}pp`;
const pctCi = (rate: number, ci: [number, number]) =>
  `${(rate * 100).toFixed(0)}% [${(ci[0] * 100).toFixed(0)}–${(ci[1] * 100).toFixed(0)}]`;
const money = (n: number) => (Number.isFinite(n) ? `$${n.toFixed(2)}` : "—");

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <Typography
      sx={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.7, textTransform: "uppercase", color: MUTED, mb: 1 }}
    >
      {children}
    </Typography>
  );
}

/** Horizontal resolve-rate bar — makes 100% vs 40% obvious at a glance. */
function ResolveBar({ label, rate, ci, color }: { label: string; rate: number; ci: [number, number]; color: string }) {
  return (
    <Box>
      <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "baseline", mb: 0.5 }}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
          <Box sx={{ width: 9, height: 9, borderRadius: "50%", bgcolor: color }} />
          <Typography sx={{ fontSize: 13.5, fontWeight: 600, color: INK }}>{label}</Typography>
        </Stack>
        <Typography sx={{ fontSize: 13, color: MUTED, fontVariantNumeric: "tabular-nums" }}>
          {pctCi(rate, ci)}
        </Typography>
      </Stack>
      <Box sx={{ height: 8, borderRadius: 4, bgcolor: "#eef2f6", overflow: "hidden" }}>
        <Box sx={{ width: `${Math.max(0, Math.min(1, rate)) * 100}%`, height: "100%", bgcolor: color, borderRadius: 4 }} />
      </Box>
    </Box>
  );
}

export function EvalCard({ card }: { card: ReportCard }) {
  const s = card.stats;
  const [aId, bId] = s.configs;
  const v = VERDICT_STYLE[card.verdict];

  const onExport = () => {
    const blob = new Blob([renderCardHtml(card)], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `report-card-${card.repoLabel.replace(/[^a-z0-9]+/gi, "-")}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card
      data-testid="eval-card"
      sx={{ borderRadius: 3, border: `1px solid ${HAIRLINE}`, overflow: "hidden", boxShadow: "0 1px 2px rgba(15,23,42,0.06)" }}
    >
      {/* Verdict accent strip */}
      <Box sx={{ height: 4, bgcolor: v.main }} />

      <Box sx={{ p: { xs: 2.5, md: 3 } }}>
        {/* Header: verdict pill + repo + headline conclusion + export */}
        <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "flex-start" }} spacing={2}>
          <Stack spacing={1.25} sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
              <Box
                data-testid="verdict-chip"
                sx={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 0.75,
                  px: 1.25,
                  py: 0.5,
                  borderRadius: 5,
                  bgcolor: v.main,
                  color: "#fff",
                  fontSize: 11.5,
                  fontWeight: 700,
                  letterSpacing: 0.4,
                  textTransform: "uppercase",
                }}
              >
                <Box sx={{ width: 6, height: 6, borderRadius: "50%", bgcolor: "#fff", opacity: 0.85 }} />
                {verdictLabel(card.verdict)}
              </Box>
              <Typography sx={{ fontSize: 13, color: MUTED, fontWeight: 500 }}>{card.repoLabel}</Typography>
            </Stack>
            <Typography data-testid="conclusion" sx={{ fontSize: 17, fontWeight: 600, color: INK, lineHeight: 1.4 }}>
              {card.conclusion}
            </Typography>
          </Stack>
          <Button
            variant="outlined"
            size="small"
            onClick={onExport}
            data-testid="export-html"
            sx={{ flexShrink: 0, borderColor: HAIRLINE, color: INK, textTransform: "none", fontWeight: 600 }}
          >
            Export HTML
          </Button>
        </Stack>

        {/* The MDE line — ALWAYS present, no card renders a winner without it. */}
        <Box
          data-testid="mde-line"
          sx={{
            mt: 2.5,
            px: 2,
            py: 1.25,
            borderRadius: 2,
            bgcolor: v.soft,
            border: `1px solid ${v.border}`,
            color: v.ink,
            fontSize: 13.5,
            fontWeight: 500,
            display: "flex",
            alignItems: "center",
            gap: 1,
          }}
        >
          <Box
            component="span"
            sx={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, px: 0.75, py: 0.25, borderRadius: 1, bgcolor: v.main, color: "#fff" }}
          >
            POWER
          </Box>
          {card.mdeLine}
        </Box>

        {/* Metrics: Δ hero + resolve bars, and economics */}
        <Stack direction={{ xs: "column", md: "row" }} spacing={{ xs: 3, md: 5 }} sx={{ mt: 3 }}>
          <Box sx={{ flex: 1.3, minWidth: 0 }}>
            <SectionLabel>Primary — paired Δ resolve rate</SectionLabel>
            <Stack direction="row" spacing={1.5} sx={{ alignItems: "baseline", mb: 2 }}>
              <Typography sx={{ fontSize: 42, fontWeight: 800, color: INK, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
                {signedPp(s.pairedDelta.est)}
              </Typography>
              <Typography sx={{ fontSize: 13, color: MUTED, fontVariantNumeric: "tabular-nums" }}>
                95% CI {signedPp(s.pairedDelta.ci95[0])} … {signedPp(s.pairedDelta.ci95[1])}
              </Typography>
            </Stack>
            <Stack spacing={1.5}>
              <ResolveBar label={aId} rate={s.resolveRate.a.rate} ci={s.resolveRate.a.ci95} color={A_COLOR} />
              <ResolveBar label={bId} rate={s.resolveRate.b.rate} ci={s.resolveRate.b.ci95} color={B_COLOR} />
            </Stack>
          </Box>

          <Box sx={{ flex: 1, minWidth: 0 }}>
            <SectionLabel>Economics — $ / resolved task</SectionLabel>
            <Stack direction="row" spacing={4}>
              {[
                { id: aId, val: s.dollarsPerResolved.a, color: A_COLOR },
                { id: bId, val: s.dollarsPerResolved.b, color: B_COLOR },
              ].map((e) => (
                <Box key={e.id}>
                  <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", mb: 0.25 }}>
                    <Box sx={{ width: 9, height: 9, borderRadius: "50%", bgcolor: e.color }} />
                    <Typography sx={{ fontSize: 12.5, color: MUTED }}>{e.id}</Typography>
                  </Stack>
                  <Typography sx={{ fontSize: 24, fontWeight: 700, color: INK, fontVariantNumeric: "tabular-nums" }}>
                    {money(e.val)}
                  </Typography>
                </Box>
              ))}
            </Stack>
            <Typography sx={{ fontSize: 12.5, color: MUTED, mt: 1.5 }}>
              total run cost <strong style={{ color: INK }}>{money(s.totalCostUsd)}</strong>
            </Typography>
          </Box>
        </Stack>

        {/* Where it breaks */}
        <Box sx={{ mt: 3, pt: 3, borderTop: `1px solid ${HAIRLINE}` }}>
          <SectionLabel>Where it breaks</SectionLabel>
          <Stack spacing={0.5}>
            {card.taxonomy.map((tax) => {
              const parts = Object.entries(tax.counts).filter(([, c]) => c > 0);
              return (
                <Typography key={tax.configId} sx={{ fontSize: 13.5, color: INK }}>
                  <strong>{tax.configId}</strong>:{" "}
                  <Box component="span" sx={{ color: parts.length ? "#b91c1c" : "#16a34a" }}>
                    {parts.length ? parts.map(([k, c]) => `${k}=${c}`).join("  ") : "no non-graded failures"}
                  </Box>
                </Typography>
              );
            })}
            {card.divergent.length > 0 && (
              <Typography sx={{ fontSize: 13, color: MUTED, mt: 0.5 }}>
                divergent tasks (resolved by exactly one): {card.divergent.map((d) => d.taskId).join(", ")}
              </Typography>
            )}
          </Stack>
        </Box>

        {/* Per-task table */}
        {card.perTask.length > 0 && (
          <Box sx={{ mt: 2.5, border: `1px solid ${HAIRLINE}`, borderRadius: 2, overflow: "hidden" }}>
            <Table size="small" data-testid="per-task-table">
              <TableHead>
                <TableRow sx={{ "& th": { bgcolor: "#f8fafc", fontWeight: 700, fontSize: 12, color: MUTED, borderColor: HAIRLINE } }}>
                  <TableCell>Task</TableCell>
                  <TableCell align="center">{aId}</TableCell>
                  <TableCell align="center">{bId}</TableCell>
                  <TableCell align="right">${aId}</TableCell>
                  <TableCell align="right">${bId}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {card.perTask.map((row, i) => {
                  const cell = (resolved: number, trials: number) => (
                    <Box
                      component="span"
                      sx={{
                        display: "inline-block",
                        minWidth: 40,
                        px: 1,
                        py: 0.25,
                        borderRadius: 1,
                        fontSize: 12.5,
                        fontWeight: 600,
                        fontVariantNumeric: "tabular-nums",
                        color: resolved > 0 ? "#166534" : "#991b1b",
                        bgcolor: resolved > 0 ? "#dcfce7" : "#fee2e2",
                      }}
                    >
                      {resolved}/{trials}
                    </Box>
                  );
                  return (
                    <TableRow key={row.taskId} sx={{ "& td": { borderColor: HAIRLINE, fontSize: 13 }, bgcolor: i % 2 ? "#fbfcfd" : "#fff" }}>
                      <TableCell sx={{ fontFamily: "ui-monospace, monospace", color: INK }}>{row.taskId}</TableCell>
                      <TableCell align="center">{cell(row.aResolved, row.trials)}</TableCell>
                      <TableCell align="center">{cell(row.bResolved, row.trials)}</TableCell>
                      <TableCell align="right" sx={{ color: MUTED, fontVariantNumeric: "tabular-nums" }}>{money(row.aCostUsd)}</TableCell>
                      <TableCell align="right" sx={{ color: MUTED, fontVariantNumeric: "tabular-nums" }}>{money(row.bCostUsd)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Box>
        )}

        {/* Disclosures */}
        <Typography
          data-testid="disclosures"
          sx={{ display: "block", mt: 2.5, fontSize: 11.5, lineHeight: 1.6, color: "#94a3b8" }}
        >
          {s.nTasks} tasks × {s.trialsPerTask} trials · verdict rule: {s.verdictRules}
          {card.requestedTasks != null && card.requestedTasks > s.nTasks &&
            ` · requested ${card.requestedTasks} tasks, ran ${s.nTasks} (capped to the available task set)`}
          {s.exclusions.length > 0 &&
            ` · exclusions: ${s.exclusions.map((e) => `${e.taskId} (${e.reason})`).join(", ")} (excluding them ${
              s.sensitivity.excludedFlippedConclusion ? "flips" : "does not change"
            } the conclusion)`}
          {" · "}one primary metric (paired resolve-rate Δ); everything else secondary · schema v{card.schemaVersion}
        </Typography>
      </Box>
    </Card>
  );
}
