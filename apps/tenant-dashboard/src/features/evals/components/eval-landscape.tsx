"use client";

/**
 * The agent landscape — resolve rate vs $-per-resolved-task, one point per
 * config, each with its 95% CI as a confidence ellipse, and the Pareto
 * frontier drawn through the non-dominated configs. Real outcome axes
 * (execution-verified resolve rate, cost per resolved task rather than
 * token price) plus visible uncertainty and a legible efficient frontier.
 *
 * Custom SVG (not ApexCharts) so the CI ellipses + frontier are exact.
 */

import { Box, Card, Chip, Stack, Typography } from "@mui/material";
import { paretoFront, type LandscapePoint } from "./landscape";

const W = 640;
const H = 440;
const M = { top: 28, right: 120, bottom: 52, left: 64 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

const COLORS = ["#00A76F", "#2065D1", "#7635DC", "#B76E00", "#FF5630"];

function niceMax(v: number): number {
  const steps = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1];
  return steps.find((s) => s >= v) ?? Math.ceil(v * 10) / 10;
}

export function EvalLandscape({ points, repoLabel }: { points: LandscapePoint[]; repoLabel: string }) {
  const front = paretoFront(points);

  // X = $/resolved-task (left = cheaper = better); Y = resolve rate (up = better).
  const xMax = niceMax(Math.max(...points.map((p) => p.dollarCi95[1])) * 1.1);
  const yMax = niceMax(Math.min(1, Math.max(...points.map((p) => p.resolveCi95[1])) + 0.08));
  const yMin = Math.max(0, Math.min(...points.map((p) => p.resolveCi95[0])) - 0.08);

  const xPx = (d: number) => M.left + (d / xMax) * PLOT_W;
  const yPx = (r: number) => M.top + PLOT_H - ((r - yMin) / (yMax - yMin)) * PLOT_H;

  // Frontier polyline: non-dominated points sorted by cost ascending.
  const frontierPts = points
    .filter((p) => front.has(p.configId))
    .sort((a, b) => a.dollarsPerResolved - b.dollarsPerResolved);

  const xTicks = Array.from({ length: 5 }, (_v, i) => (xMax / 4) * i);
  const yTicks = Array.from({ length: 5 }, (_v, i) => yMin + ((yMax - yMin) / 4) * i);

  return (
    <Card sx={{ p: 3 }} data-testid="eval-landscape">
      <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "flex-start", mb: 1 }}>
        <Box>
          <Typography variant="h6">Agent landscape</Typography>
          <Typography variant="body2" color="text.secondary">
            Resolve rate vs $ per resolved task on {repoLabel} · 84 tasks × 3 trials · rings are
            95% CIs
          </Typography>
        </Box>
        <Chip size="small" color="success" variant="outlined" label="↑ ← better" />
      </Stack>

      <Box component="svg" viewBox={`0 0 ${W} ${H}`} sx={{ width: "100%", maxWidth: W, height: "auto" }}>
        {/* gridlines + axis ticks */}
        {xTicks.map((t) => (
          <g key={`x${t}`}>
            <line x1={xPx(t)} y1={M.top} x2={xPx(t)} y2={M.top + PLOT_H} stroke="#eef0f2" />
            <text x={xPx(t)} y={M.top + PLOT_H + 18} textAnchor="middle" fontSize="11" fill="#919EAB">
              ${t.toFixed(2)}
            </text>
          </g>
        ))}
        {yTicks.map((t) => (
          <g key={`y${t}`}>
            <line x1={M.left} y1={yPx(t)} x2={M.left + PLOT_W} y2={yPx(t)} stroke="#eef0f2" />
            <text x={M.left - 10} y={yPx(t) + 4} textAnchor="end" fontSize="11" fill="#919EAB">
              {Math.round(t * 100)}%
            </text>
          </g>
        ))}

        {/* axis titles */}
        <text x={M.left + PLOT_W / 2} y={H - 12} textAnchor="middle" fontSize="12" fill="#637381" fontWeight="600">
          $ per resolved task
        </text>
        <text
          transform={`translate(16, ${M.top + PLOT_H / 2}) rotate(-90)`}
          textAnchor="middle"
          fontSize="12"
          fill="#637381"
          fontWeight="600"
        >
          Resolve rate
        </text>

        {/* Pareto frontier */}
        {frontierPts.length > 1 && (
          <polyline
            points={frontierPts.map((p) => `${xPx(p.dollarsPerResolved)},${yPx(p.resolveRate)}`).join(" ")}
            fill="none"
            stroke="#00A76F"
            strokeWidth="1.5"
            strokeDasharray="4 3"
            opacity="0.5"
          />
        )}

        {/* points with CI ellipses */}
        {points.map((p, i) => {
          const color = COLORS[i % COLORS.length]!;
          const cx = xPx(p.dollarsPerResolved);
          const cy = yPx(p.resolveRate);
          const rx = Math.max(4, (xPx(p.dollarCi95[1]) - xPx(p.dollarCi95[0])) / 2);
          const ry = Math.max(4, (yPx(p.resolveCi95[0]) - yPx(p.resolveCi95[1])) / 2);
          const onFront = front.has(p.configId);
          return (
            <g key={p.configId} data-testid={`landscape-point-${p.configId}`}>
              <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill={color} fillOpacity={onFront ? 0.12 : 0.06} stroke={color} strokeOpacity={onFront ? 0.5 : 0.25} />
              <circle cx={cx} cy={cy} r={onFront ? 6 : 5} fill={onFront ? color : "#fff"} stroke={color} strokeWidth="2" />
              <text x={cx + rx + 6} y={cy + 4} fontSize="12" fill="#212B36" fontWeight={onFront ? 600 : 400}>
                {p.configId}
                {!onFront && <tspan fill="#919EAB"> · dominated</tspan>}
              </text>
            </g>
          );
        })}
      </Box>

      <Typography variant="caption" color="text.secondary" data-testid="landscape-caption">
        The dashed line is the Pareto frontier — configs where no other is both cheaper AND
        higher-resolving. Dominated configs (hollow) are beaten on both axes. Axes are
        execution-verified resolve rate and measured $/resolved-task, not a quality score or
        token price.
      </Typography>
    </Card>
  );
}
