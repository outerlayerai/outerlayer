"use client";

/**
 * The Context Overview — the surface's default view. Answers "what context
 * do we have and is it earning its place?" at zero clicks: stat tiles, the
 * ranked skills/MCP tables, and the needs-attention rail; one click opens
 * the non-modal side detail panel (`?skill=` / `?server=`, Esc closes).
 *
 * Deliberately chart-poor: tables and worklists first, trends only inside
 * the detail panel — watching context metrics over time is the dashboards'
 * job, and the moment this page grows a chart grid it has become a second
 * dashboard.
 */
import { useEffect, useMemo, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import { useTranslate } from "@outerlayer/locales";
import { ErrorState } from "@/components/error-state";
import { PageSkeleton } from "@/components/page-skeleton";
import { useContextOverview } from "../../hooks";
import type { ContextOverviewRange, ContextOverviewResponse } from "../../types";
import { isFirstRun } from "./context-overview-model";
import { AdoptionDetailPanel, type AdoptionDetailSelection } from "./adoption-detail-panel";
import { AdoptionTable } from "./adoption-table";
import { NeedsAttentionRail } from "./needs-attention-rail";
import { OverviewInventoryCard, OverviewTopicCard } from "./overview-rail-cards";
import { OverviewStatRow } from "./overview-stat-row";

const RAIL_WIDTH = 264;

interface ContextOverviewProps {
  appId: string;
  /** RSC seed — carries the LANDING range's window only. */
  initialOverview: ContextOverviewResponse | null;
  range: ContextOverviewRange;
  selection: AdoptionDetailSelection | null;
  onSelect: (selection: AdoptionDetailSelection | null) => void;
  /** Switches to the Files view with the given path selected. */
  onOpenFile: (path: string) => void;
}

export function ContextOverview({
  appId,
  initialOverview,
  range,
  selection,
  onSelect,
  onOpenFile,
}: ContextOverviewProps) {
  const { t } = useTranslate();
  const [firstRunDismissed, setFirstRunDismissed] = useState(false);
  const { data, error, isLoading, mutate } = useContextOverview(appId, range, {
    fallbackData:
      initialOverview !== null && initialOverview.range === range ? initialOverview : undefined,
  });

  // Stable per-render "today" for the zero-filled sparklines.
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // Esc closes the panel — it's non-modal, so nothing else traps the key.
  useEffect(() => {
    if (selection === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onSelect(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selection, onSelect]);

  if (isLoading && !data) {
    return <PageSkeleton variant="card-grid" header={false} />;
  }
  if (error || !data) {
    return (
      <Box sx={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Box sx={{ width: 1, maxWidth: 640 }}>
          <ErrorState
            title={t("dashboard.context.overview.loadErrorTitle")}
            description={t("dashboard.context.overview.loadError")}
            onRetry={() => void mutate()}
          />
        </Box>
      </Box>
    );
  }

  const firstRun = isFirstRun(data);

  return (
    <Box
      data-testid="context-overview"
      sx={{ flex: 1, minHeight: 0, overflow: "auto", pb: 2 }}
    >
      {data.degraded && (
        <Alert
          severity="warning"
          sx={{ mb: 1.5 }}
          data-testid="overview-degraded-banner"
          action={
            <Button color="inherit" size="small" onClick={() => void mutate()}>
              {t("dashboard.context.overview.degradedRetry")}
            </Button>
          }
        >
          {t("dashboard.context.overview.degradedBanner")}
        </Alert>
      )}
      {firstRun && !firstRunDismissed && (
        <Alert
          severity="info"
          sx={{ mb: 1.5 }}
          onClose={() => setFirstRunDismissed(true)}
          data-testid="overview-first-run-banner"
        >
          {t("dashboard.context.overview.firstRunBanner")}
        </Alert>
      )}
      <OverviewStatRow response={data} />
      <Stack direction="row" spacing={1.5} sx={{ alignItems: "flex-start" }}>
        <Stack spacing={1.5} sx={{ flexGrow: 1, minWidth: 0 }}>
          <AdoptionTable
            kind="skill"
            response={data}
            selectedName={selection?.kind === "skill" ? selection.name : null}
            onSelect={(name) =>
              onSelect(
                selection?.kind === "skill" && selection.name === name
                  ? null
                  : { kind: "skill", name },
              )
            }
            today={today}
          />
          <AdoptionTable
            kind="mcp"
            response={data}
            selectedName={selection?.kind === "mcp" ? selection.name : null}
            onSelect={(name) =>
              onSelect(
                selection?.kind === "mcp" && selection.name === name ? null : { kind: "mcp", name },
              )
            }
            today={today}
          />
        </Stack>
        <Stack
          spacing={1.5}
          sx={{ width: RAIL_WIDTH, flexShrink: 0, display: { xs: "none", md: "flex" } }}
        >
          <NeedsAttentionRail response={data} onOpenFile={onOpenFile} />
          <OverviewTopicCard response={data} />
          <OverviewInventoryCard response={data} />
        </Stack>
      </Stack>
      {/* The drawer overlays from the right edge (fixed), outside the grid so
          the tables keep their width and stay clickable underneath. */}
      {selection !== null && (
        <AdoptionDetailPanel
          appId={appId}
          response={data}
          selection={selection}
          onClose={() => onSelect(null)}
          onOpenFile={onOpenFile}
          today={today}
        />
      )}
    </Box>
  );
}
