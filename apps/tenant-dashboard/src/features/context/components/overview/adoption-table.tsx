"use client";

/**
 * The Overview's ranked tables — one component parameterized for skills and
 * MCP servers. Top-N with an inline "Show all" expander, never a pager (a
 * rollup you page through stops being a rollup; the rows a pager would hide
 * surface in needs-attention anyway). Row click toggles the side detail
 * panel via the URL param the caller owns.
 *
 * Degraded analytics render usage cells as "—" (unknown ≠ zero) and no
 * status pill is shown before verdicts are available (unknown ≠ never).
 */
import { useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TableSortLabel from "@mui/material/TableSortLabel";
import Typography from "@mui/material/Typography";
import { alpha } from "@mui/material/styles";
import { useTranslate } from "@outerlayer/locales";
import type { ContextOverviewResponse, OverviewMcpRow, OverviewSkillRow } from "../../types";
import { buildTrendSeries } from "../context-skill-drilldown";
import { NeverUsedText, RelativeTimeText, TrendSparkline } from "../context-adoption-widgets";
import {
  mcpStatus,
  skillStatus,
  sortMcpRows,
  sortSkillRows,
  topNSplit,
  verdictsAvailable,
  OVERVIEW_RANGE_DAYS,
  OVERVIEW_TOP_N,
  type OverviewSortDir,
  type OverviewSortKey,
  type OverviewStatus,
} from "./context-overview-model";

const SPARK_WIDTH = 88;

const STATUS_COLOR: Record<OverviewStatus, "success" | "warning" | "error"> = {
  active: "success",
  quiet: "warning",
  never: "error",
};

function StatusPill({ status }: { status: OverviewStatus }) {
  const { t } = useTranslate();
  return (
    <Chip
      size="small"
      variant="outlined"
      color={STATUS_COLOR[status]}
      label={t(`dashboard.context.overview.status.${status}`)}
      data-testid={`overview-status-${status}`}
      sx={{ height: 20 }}
    />
  );
}

function SortHeader({
  label,
  sortKey,
  active,
  dir,
  onSort,
  align,
}: {
  label: string;
  sortKey: OverviewSortKey;
  active: boolean;
  dir: OverviewSortDir;
  onSort: (key: OverviewSortKey) => void;
  align?: "right";
}) {
  return (
    <TableCell align={align} sortDirection={active ? dir : false}>
      <TableSortLabel active={active} direction={active ? dir : "desc"} onClick={() => onSort(sortKey)}>
        {label}
      </TableSortLabel>
    </TableCell>
  );
}

interface AdoptionTableProps {
  kind: "skill" | "mcp";
  response: ContextOverviewResponse;
  /** The open panel's name for this kind, for row highlighting. */
  selectedName: string | null;
  onSelect: (name: string) => void;
  /** `YYYY-MM-DD` "today" for the zero-filled sparklines (timezone-stable). */
  today: string;
}

export function AdoptionTable({ kind, response, selectedName, onSelect, today }: AdoptionTableProps) {
  const { t } = useTranslate();
  const [sortKey, setSortKey] = useState<OverviewSortKey>("activations");
  const [sortDir, setSortDir] = useState<OverviewSortDir>("desc");
  const [expanded, setExpanded] = useState(false);

  const verdicts = verdictsAvailable(response);
  const degraded = response.degraded;
  const rangeDays = OVERVIEW_RANGE_DAYS[response.range];
  const rangeLabel = t(`dashboard.context.overview.range.${response.range}`);

  const onSort = (key: OverviewSortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  const skillRows = useMemo(
    () => (kind === "skill" ? sortSkillRows(response.skills, sortKey, sortDir) : []),
    [kind, response.skills, sortKey, sortDir],
  );
  const mcpRows = useMemo(
    () => (kind === "mcp" ? sortMcpRows(response.mcpServers, sortKey, sortDir) : []),
    [kind, response.mcpServers, sortKey, sortDir],
  );
  const { visible, hiddenCount } =
    kind === "skill" ? topNSplit(skillRows, expanded) : topNSplit(mcpRows, expanded);
  const total = kind === "skill" ? skillRows.length : mcpRows.length;

  const usageCell = (value: number) => (degraded ? "—" : value);

  const renderStatus = (status: OverviewStatus, inRepo: boolean) => {
    if (!inRepo) {
      return (
        <Chip
          size="small"
          variant="outlined"
          label={t("dashboard.context.overview.removedFromRepo")}
          data-testid="overview-removed-chip"
          sx={{ height: 20, color: "text.disabled" }}
        />
      );
    }
    if (!verdicts) return null;
    return <StatusPill status={status} />;
  };

  const lastUsedCell = (lastUsedAt: string | null, status: OverviewStatus, neverTip: string) => {
    if (degraded) {
      return (
        <Typography component="span" variant="caption" sx={{ color: "text.disabled" }}>
          —
        </Typography>
      );
    }
    if (verdicts && status === "never") {
      return <NeverUsedText tip={neverTip} testId="overview-last-used-never" />;
    }
    return <RelativeTimeText value={lastUsedAt} testId="overview-last-used" />;
  };

  const rowSx = (selected: boolean, inRepo: boolean) => ({
    cursor: "pointer",
    ...(inRepo ? {} : { opacity: 0.55 }),
    ...(selected
      ? { bgcolor: (theme: { palette: { primary: { main: string } } }) => alpha(theme.palette.primary.main, 0.08) }
      : {}),
  });

  return (
    <Paper variant="outlined" data-testid={`overview-table-${kind}`}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "baseline", justifyContent: "space-between", px: 2, py: 1.25, borderBottom: "1px solid", borderColor: "divider" }}
      >
        <Typography variant="subtitle2">
          {t(kind === "skill" ? "dashboard.context.overview.skillsTitle" : "dashboard.context.overview.mcpTitle")}
        </Typography>
        <Typography variant="caption" sx={{ color: "text.disabled" }}>
          {t("dashboard.context.overview.tableWindow", { range: rangeLabel })}
        </Typography>
      </Stack>
      <Box sx={{ overflowX: "auto" }}>
        <Table size="small" sx={{ minWidth: 560, "& td": { fontVariantNumeric: "tabular-nums" } }}>
          <TableHead>
            <TableRow>
              <SortHeader
                label={t(kind === "skill" ? "dashboard.context.overview.colSkill" : "dashboard.context.overview.colServer")}
                sortKey="name"
                active={sortKey === "name"}
                dir={sortDir}
                onSort={onSort}
              />
              {kind === "mcp" && (
                <TableCell align="right">{t("dashboard.context.overview.colToolsUsed")}</TableCell>
              )}
              <SortHeader
                label={t(kind === "skill" ? "dashboard.context.overview.colActivations" : "dashboard.context.overview.colCalls")}
                sortKey="activations"
                active={sortKey === "activations"}
                dir={sortDir}
                onSort={onSort}
                align="right"
              />
              <SortHeader
                label={t("dashboard.context.overview.colSessions")}
                sortKey="sessions"
                active={sortKey === "sessions"}
                dir={sortDir}
                onSort={onSort}
                align="right"
              />
              {kind === "skill" && <TableCell>{t("dashboard.context.overview.colTrend")}</TableCell>}
              <TableCell>{t("dashboard.context.overview.colLastUsed")}</TableCell>
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {kind === "skill"
              ? (visible as OverviewSkillRow[]).map((row) => {
                  const status = skillStatus(row);
                  const selected = selectedName === row.skillName;
                  return (
                    <TableRow
                      key={row.skillName}
                      hover
                      onClick={() => onSelect(row.skillName)}
                      data-testid={`overview-skill-row-${row.skillName}`}
                      aria-selected={selected}
                      sx={rowSx(selected, row.inRepo)}
                    >
                      <TableCell>
                        <Typography variant="body2" sx={{ fontSize: 13, fontWeight: 500 }}>
                          {row.skillName}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">{usageCell(row.activations)}</TableCell>
                      <TableCell align="right">{usageCell(row.sessions)}</TableCell>
                      <TableCell>
                        <TrendSparkline
                          series={
                            degraded
                              ? []
                              : buildTrendSeries(
                                  row.trend.map((p) => ({ day: p.day, value: p.activations })),
                                  rangeDays,
                                  today,
                                )
                          }
                          unit="activations"
                          width={SPARK_WIDTH}
                        />
                      </TableCell>
                      <TableCell>
                        {lastUsedCell(row.lastActivatedAt, status, t("dashboard.context.tree.lastUsedNeverSkillTip"))}
                      </TableCell>
                      <TableCell align="right">{renderStatus(status, row.inRepo)}</TableCell>
                    </TableRow>
                  );
                })
              : (visible as OverviewMcpRow[]).map((row) => {
                  const status = mcpStatus(row);
                  const selected = selectedName === row.serverName;
                  return (
                    <TableRow
                      key={row.serverName}
                      hover
                      onClick={() => onSelect(row.serverName)}
                      data-testid={`overview-mcp-row-${row.serverName}`}
                      aria-selected={selected}
                      sx={rowSx(selected, row.inRepo)}
                    >
                      <TableCell>
                        <Typography variant="body2" sx={{ fontSize: 13, fontWeight: 500 }}>
                          {row.serverName}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">{usageCell(row.toolsUsed)}</TableCell>
                      <TableCell align="right">{usageCell(row.calls)}</TableCell>
                      <TableCell align="right">{usageCell(row.sessions)}</TableCell>
                      <TableCell>
                        {lastUsedCell(row.lastUsedAt, status, t("dashboard.context.tree.lastUsedNeverMcpTip"))}
                      </TableCell>
                      <TableCell align="right">{renderStatus(status, row.inRepo)}</TableCell>
                    </TableRow>
                  );
                })}
          </TableBody>
        </Table>
      </Box>
      {(hiddenCount > 0 || expanded) && (
        <Box sx={{ px: 2, py: 1, borderTop: "1px solid", borderColor: "divider" }}>
          <Button
            size="small"
            onClick={() => setExpanded((v) => !v)}
            data-testid={`overview-${kind}-expander`}
          >
            {expanded
              ? t("dashboard.context.overview.showTop", { count: Math.min(total, OVERVIEW_TOP_N) })
              : t("dashboard.context.overview.showAll", { count: total })}
          </Button>
        </Box>
      )}
    </Paper>
  );
}
