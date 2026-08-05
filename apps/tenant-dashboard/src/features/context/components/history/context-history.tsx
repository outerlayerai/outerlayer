"use client";

/**
 * Context › History view — the full-width event list that replaces the Files
 * two-pane area when the Context tab's view switch is on "History". Single
 * source: the `context_sync_event` ledger (link/push/resync attempts),
 * newest-first, realtime-subscribed. Failed rows expand to reveal the full
 * error text.
 */
import { useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Collapse from "@mui/material/Collapse";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import TablePagination from "@mui/material/TablePagination";
import Typography from "@mui/material/Typography";
import { formatDistanceToNow } from "date-fns";
import { useTranslate } from "@outerlayer/locales";
import Iconify from "@/components/iconify";
import {
  HISTORY_PAGE_SIZE_OPTIONS,
  useContextSyncHistory,
} from "./use-context-sync-history";
import { formatDuration, type SyncHistoryRow } from "./sync-history-model";

const TRIGGER_LABEL_KEY: Record<SyncHistoryRow["trigger"], string> = {
  link: "dashboard.context.history.triggerLink",
  push: "dashboard.context.history.triggerPush",
  resync: "dashboard.context.history.triggerResync",
};

function relativeTime(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "";
  }
}

function StatusIcon({ status }: { status: SyncHistoryRow["status"] }) {
  const synced = status === "synced";
  return (
    <Iconify
      icon={synced ? "mdi:check-circle" : "mdi:close-circle"}
      width={20}
      sx={{ color: synced ? "success.main" : "error.main", flexShrink: 0 }}
      aria-label={synced ? "synced" : "failed"}
    />
  );
}

function SyncHistoryItem({ row }: { row: SyncHistoryRow }) {
  const { t } = useTranslate();
  const [expanded, setExpanded] = useState(false);
  const canExpand = row.status === "failed" && row.error !== null;
  const duration = formatDuration(row.durationMs);

  return (
    <Box
      component="li"
      sx={{ listStyle: "none", borderBottom: "1px solid", borderColor: "divider" }}
    >
      <Stack
        direction="row"
        spacing={1.5}
        sx={{ alignItems: "center", px: 2, py: 1.25, minWidth: 0 }}
      >
        <StatusIcon status={row.status} />
        <Typography
          variant="body2"
          sx={{ flexGrow: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={row.primaryText}
        >
          {row.primaryText}
        </Typography>
        {/* Fixed-width trailing columns so the metadata aligns vertically
            across rows instead of zigzagging with each row's content. */}
        <Box sx={{ width: 76, flexShrink: 0, display: "flex", justifyContent: "flex-start" }}>
          <Chip size="small" variant="outlined" label={t(TRIGGER_LABEL_KEY[row.trigger])} />
        </Box>
        <Typography
          variant="caption"
          sx={{ width: 64, flexShrink: 0, fontFamily: "monospace", color: "text.secondary" }}
        >
          {row.shortSha ?? "—"}
        </Typography>
        <Stack
          direction="row"
          spacing={0.5}
          sx={{ width: 96, flexShrink: 0, alignItems: "center", color: "text.secondary" }}
        >
          <Iconify icon="mdi:source-branch" width={14} />
          <Typography variant="caption" noWrap>
            {row.branch}
          </Typography>
        </Stack>
        <Typography
          variant="caption"
          sx={{ width: 128, flexShrink: 0, color: "text.secondary", textAlign: "right" }}
        >
          {relativeTime(row.createdAt)}
        </Typography>
        <Typography
          variant="caption"
          sx={{
            width: 52,
            flexShrink: 0,
            color: "text.secondary",
            textAlign: "right",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {duration ?? ""}
        </Typography>
        {canExpand ? (
          <IconButton
            size="small"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? "Hide error" : "Show error"}
            aria-expanded={expanded}
          >
            <Iconify icon={expanded ? "mdi:chevron-up" : "mdi:chevron-down"} width={18} />
          </IconButton>
        ) : (
          // Keep the trailing column aligned with expandable rows.
          <Box sx={{ width: 30, flexShrink: 0 }} />
        )}
      </Stack>
      {canExpand && (
        <Collapse in={expanded} unmountOnExit>
          <Box sx={{ px: 2, pb: 1.5, pl: 6 }}>
            <Typography
              variant="caption"
              component="pre"
              sx={{
                m: 0,
                fontFamily: "monospace",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: "error.main",
              }}
              data-testid="sync-history-error"
            >
              {row.error}
            </Typography>
          </Box>
        </Collapse>
      )}
    </Box>
  );
}

function HistoryLoading() {
  return (
    <Stack spacing={0} sx={{ p: 2 }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} variant="text" height={40} />
      ))}
    </Stack>
  );
}

/** Column labels mirroring SyncHistoryItem's fixed trailing widths exactly —
 *  drift between the two shows up as misaligned labels, so keep them in sync. */
function HistoryHeader() {
  const { t } = useTranslate();
  const label = { variant: "overline", sx: { color: "text.secondary", lineHeight: 1.5 } } as const;
  return (
    <Stack
      direction="row"
      spacing={1.5}
      sx={{
        alignItems: "center",
        px: 2,
        py: 0.75,
        borderBottom: "1px solid",
        borderColor: "divider",
        bgcolor: "background.neutral",
      }}
    >
      <Box sx={{ width: 20, flexShrink: 0 }} />
      <Typography {...label} sx={{ ...label.sx, flexGrow: 1, minWidth: 0 }}>
        {t("dashboard.context.history.colSync")}
      </Typography>
      <Typography {...label} sx={{ ...label.sx, width: 76, flexShrink: 0 }}>
        {t("dashboard.context.history.colTrigger")}
      </Typography>
      <Typography {...label} sx={{ ...label.sx, width: 64, flexShrink: 0 }}>
        {t("dashboard.context.history.colCommit")}
      </Typography>
      <Typography {...label} sx={{ ...label.sx, width: 96, flexShrink: 0 }}>
        {t("dashboard.context.history.colBranch")}
      </Typography>
      <Typography {...label} sx={{ ...label.sx, width: 128, flexShrink: 0, textAlign: "right" }}>
        {t("dashboard.context.history.colWhen")}
      </Typography>
      <Typography {...label} sx={{ ...label.sx, width: 52, flexShrink: 0, textAlign: "right" }}>
        {t("dashboard.context.history.colTook")}
      </Typography>
      <Box sx={{ width: 30, flexShrink: 0 }} />
    </Stack>
  );
}

function HistoryEmpty() {
  const { t } = useTranslate();
  return (
    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", flexGrow: 1, p: 4 }}>
      <Typography variant="body2" sx={{ color: "text.secondary", textAlign: "center" }}>
        {t("dashboard.context.history.empty")}
      </Typography>
    </Box>
  );
}

export function ContextHistory({ appId }: { appId: string }) {
  const { t } = useTranslate();
  const { rows, total, page, pageSize, setPage, setPageSize, isLoading, error } =
    useContextSyncHistory(appId);

  return (
    // Fills the PageFrame column: column header + pager stay pinned; only the
    // row list scrolls. The page itself never scrolls in the History view.
    <Paper
      variant="outlined"
      sx={{ flexGrow: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}
      data-testid="context-history"
    >
      {isLoading ? (
        <HistoryLoading />
      ) : error ? (
        <Box sx={{ p: 2 }}>
          <Alert severity="error">{t("dashboard.context.history.loadError")}</Alert>
        </Box>
      ) : rows.length === 0 ? (
        <HistoryEmpty />
      ) : (
        <>
          <HistoryHeader />
          <Box component="ul" sx={{ m: 0, p: 0, flexGrow: 1, minHeight: 0, overflow: "auto" }}>
            {rows.map((row) => (
              <SyncHistoryItem key={row.id} row={row} />
            ))}
          </Box>
          <TablePagination
            component="div"
            count={total}
            page={page}
            rowsPerPage={pageSize}
            rowsPerPageOptions={[...HISTORY_PAGE_SIZE_OPTIONS]}
            onPageChange={(_e, next) => setPage(next)}
            onRowsPerPageChange={(e) => setPageSize(Number(e.target.value))}
            sx={{ borderTop: "1px solid", borderColor: "divider", flexShrink: 0 }}
          />
        </>
      )}
    </Paper>
  );
}
