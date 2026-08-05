"use client";

/**
 * The sessions filter bar — a converged filter pattern:
 *
 *   [search] [time ▾] [+ Filter]  dim: value ×  dim: value ×  Clear all
 *
 * One idiom for every facet dimension: `+ Filter` opens a typeahead picker
 * over the DATA-driven facet values (dimensions and their values both come
 * from the server response — the UI enumerates nothing); an active filter is
 * a removable token. Search and the time range stay as dedicated,
 * always-visible controls (search-first + a pinned time picker are the two
 * observability-toolbar conventions worth keeping).
 *
 * One value per dimension — matches the list API's filter params; re-picking
 * a dimension replaces its token.
 */
import { useMemo, useState } from "react";
import {
  Box,
  Button,
  Chip,
  Divider,
  InputAdornment,
  ListSubheader,
  Menu,
  MenuItem,
  Select,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import Iconify from "@/components/iconify";
import { TIME_RANGES } from "../session-list-shared";
import { Stack } from "./agent-ui";
import { agentColor } from "./agent-format";
import { fNumber } from "@/utils/format-number";

const mono = { fontFamily: "monospace", fontSize: 12.5 } as const;

/** Run-origin segments. Value is the API `origin` param (a comma-set of
 * tokens); "" lists every origin. People covers interactive runs, legacy
 * pre-Origin rows, AND worker runs — a worker run is a user dispatching work
 * to the cloud, so it belongs with human sessions. Agent fan-outs get their
 * own segment so they never drown the list. */
const ORIGIN_SEGMENTS = [
  { key: "interactive,worker", label: "People" },
  { key: "agent", label: "Agents" },
  { key: "", label: "All" },
] as const;

interface OriginCounts {
  interactive: number;
  agent: number;
  worker: number;
}

/** Segment badge count: what the list's total would be under that segment. */
const segmentCount = (key: string, counts: OriginCounts): number =>
  key === ""
    ? counts.interactive + counts.agent + counts.worker
    : key.split(",").reduce((n, t) => n + (counts[t as keyof OriginCounts] ?? 0), 0);

export interface FilterDimension {
  /** Param key — also the token prefix. */
  key: "agent" | "branch" | "developer" | "model" | "source" | "signal";
  label: string;
  values: string[];
  /** Optional value → display-name map (e.g. membership id → developer name).
   * Display only — the underlying value stays the filter param. */
  labels?: Record<string, string>;
}

export type ActiveFilters = Partial<Record<FilterDimension["key"], string>>;

/** Long opaque values (membership UUIDs) shorten for display only. */
const shortValue = (v: string): string => (v.length > 20 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v);

/** Mapped display name when the dimension has one; shortened raw value otherwise. */
const displayValue = (v: string, labels?: Record<string, string>): string => labels?.[v] ?? shortValue(v);

const tokenColor = (dim: FilterDimension["key"], value: string): string | undefined =>
  dim === "agent" ? agentColor(value) : undefined;

interface SavedViewItem {
  id: string;
  name: string;
}

export function SessionFilterBar({
  search,
  onSearch,
  range,
  onRange,
  origin,
  onOrigin,
  originCounts,
  dimensions,
  active,
  onChange,
  views,
  canSaveView,
  onSaveView,
  onApplyView,
  onDeleteView,
}: {
  search: string;
  onSearch: (v: string) => void;
  range: string;
  onRange: (key: string) => void;
  /** Run-origin segment value — one of ORIGIN_SEGMENTS keys ("" = every origin). */
  origin: string;
  onOrigin: (key: string) => void;
  /** Per-origin totals for the segment badges; absent = plain labels. */
  originCounts?: OriginCounts;
  dimensions: FilterDimension[];
  active: ActiveFilters;
  onChange: (next: ActiveFilters) => void;
  /** Saved views for this surface (name → stored query). */
  views: SavedViewItem[];
  /** True when the current state is worth saving (any filter/search/sort active). */
  canSaveView: boolean;
  onSaveView: (name: string) => void;
  onApplyView: (id: string) => void;
  onDeleteView: (id: string) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const [viewsAnchor, setViewsAnchor] = useState<HTMLElement | null>(null);
  const [savingName, setSavingName] = useState<string | null>(null);

  const tokens = dimensions
    .filter((d) => active[d.key])
    .map((d) => ({ dim: d, value: active[d.key]! }));

  // The picker is one flat, typeahead-filtered list grouped by dimension —
  // matching on the value or the dimension name ("bran ma" finds branches).
  const pickerGroups = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    return dimensions
      .map((d) => ({
        dim: d,
        values: d.values
          .filter((v) => v !== active[d.key])
          .filter(
            (v) =>
              !q ||
              v.toLowerCase().includes(q) ||
              (d.labels?.[v] ?? "").toLowerCase().includes(q) ||
              d.label.toLowerCase().includes(q),
          )
          .slice(0, 8),
      }))
      .filter((g) => g.values.length > 0);
  }, [dimensions, active, pickerQuery]);

  const closePicker = () => {
    setAnchor(null);
    setPickerQuery("");
  };

  return (
    <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: "wrap", rowGap: 1 }} alignItems="center">
      <TextField
        size="small"
        placeholder="Search titles…"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        slotProps={{
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <Iconify icon="eva:search-fill" sx={{ width: 16, color: "text.disabled" }} />
              </InputAdornment>
            ),
          },
        }}
        sx={{ minWidth: 240, "& input": { ...mono, py: 0.75 } }}
      />

      <Select
        size="small"
        value={range}
        onChange={(e) => onRange(e.target.value)}
        renderValue={(key) => (
          <Stack direction="row" spacing={0.75} alignItems="center">
            <Iconify icon="mdi:clock-outline" sx={{ width: 14, color: "text.secondary" }} />
            <span>{TIME_RANGES.find((r) => r.key === key)?.label ?? "All time"}</span>
          </Stack>
        )}
        displayEmpty
        sx={{ ...mono, minWidth: 150, "& .MuiSelect-select": { py: 0.55 } }}
      >
        {TIME_RANGES.map((r) => (
          <MenuItem key={r.key || "all"} value={r.key} sx={mono}>
            {r.label}
          </MenuItem>
        ))}
      </Select>

      <ToggleButtonGroup
        exclusive
        size="small"
        value={origin}
        onChange={(_, key: string | null) => {
          // Exclusive groups emit null on a re-click of the active segment —
          // one segment is always active, so that's a no-op.
          if (key !== null) onOrigin(key);
        }}
        aria-label="Origin"
        sx={{
          "& .MuiToggleButton-root": {
            ...mono,
            textTransform: "none",
            px: 1.25,
            py: 0.55,
            color: "text.secondary",
            borderColor: "#E4E0D6",
            "&.Mui-selected": { color: "text.primary" },
          },
        }}
      >
        {ORIGIN_SEGMENTS.map((s) => (
          <ToggleButton key={s.key || "all"} value={s.key} aria-label={s.label}>
            {originCounts ? `${s.label} (${fNumber(segmentCount(s.key, originCounts))})` : s.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      <Button
        size="small"
        variant="outlined"
        color="inherit"
        onClick={(e) => setAnchor(e.currentTarget)}
        startIcon={<Iconify icon="mingcute:add-line" sx={{ width: 14 }} />}
        sx={{ textTransform: "none", ...mono, borderColor: "#E4E0D6", color: "text.secondary", px: 1.25 }}
      >
        Filter
      </Button>

      {tokens.map(({ dim, value }) => {
        const color = tokenColor(dim.key, value);
        return (
          <Chip
            key={dim.key}
            size="small"
            label={`${dim.label.toLowerCase()}: ${displayValue(value, dim.labels)}`}
            onDelete={() => onChange({ ...active, [dim.key]: undefined })}
            title={value}
            style={color ? { backgroundColor: `${color}18`, color } : undefined}
            sx={{ ...mono, fontSize: 12, "& .MuiChip-deleteIcon": { fontSize: 15, ...(color ? { color } : {}) } }}
          />
        );
      })}

      {tokens.length > 0 && (
        <Button size="small" onClick={() => onChange({})} sx={{ textTransform: "none", fontSize: 12, color: "text.secondary" }}>
          Clear all
        </Button>
      )}

      <Box sx={{ flexGrow: 1 }} />

      {savingName !== null ? (
        <Stack direction="row" spacing={0.75} alignItems="center">
          <TextField
            size="small"
            autoFocus
            placeholder="View name…"
            value={savingName}
            onChange={(e) => setSavingName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && savingName.trim()) {
                onSaveView(savingName.trim());
                setSavingName(null);
              }
              if (e.key === "Escape") setSavingName(null);
            }}
            sx={{ width: 180, "& input": { ...mono, py: 0.6 } }}
          />
          <Button
            size="small"
            disabled={!savingName.trim()}
            onClick={() => {
              onSaveView(savingName.trim());
              setSavingName(null);
            }}
            sx={{ textTransform: "none", fontSize: 12 }}
          >
            Save
          </Button>
        </Stack>
      ) : (
        canSaveView && (
          <Button
            size="small"
            onClick={() => setSavingName("")}
            startIcon={<Iconify icon="mdi:bookmark-plus-outline" sx={{ width: 15 }} />}
            sx={{ textTransform: "none", fontSize: 12, color: "text.secondary" }}
          >
            Save view
          </Button>
        )
      )}

      {views.length > 0 && (
        <Button
          size="small"
          variant="outlined"
          color="inherit"
          onClick={(e) => setViewsAnchor(e.currentTarget)}
          startIcon={<Iconify icon="mdi:bookmark-multiple-outline" sx={{ width: 14 }} />}
          sx={{ textTransform: "none", ...mono, borderColor: "#E4E0D6", color: "text.secondary", px: 1.25 }}
        >
          Views
        </Button>
      )}

      <Menu
        anchorEl={viewsAnchor}
        open={Boolean(viewsAnchor)}
        onClose={() => setViewsAnchor(null)}
        slotProps={{ paper: { sx: { minWidth: 240 } } }}
      >
        {views.map((v) => (
          <MenuItem
            key={v.id}
            onClick={() => {
              onApplyView(v.id);
              setViewsAnchor(null);
            }}
            sx={{ ...mono, py: 0.5, display: "flex", justifyContent: "space-between", gap: 2 }}
          >
            <span>{v.name}</span>
            <Iconify
              icon="mdi:close"
              aria-label={`Delete view ${v.name}`}
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation();
                onDeleteView(v.id);
              }}
              sx={{ width: 14, color: "text.disabled", "&:hover": { color: "#B42318" } }}
            />
          </MenuItem>
        ))}
      </Menu>

      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={closePicker}
        slotProps={{ paper: { sx: { minWidth: 260, maxHeight: 420 } } }}
      >
        <Box sx={{ px: 1.25, pb: 0.75 }} onKeyDown={(e) => e.stopPropagation()}>
          <TextField
            size="small"
            autoFocus
            fullWidth
            placeholder="Filter by…"
            value={pickerQuery}
            onChange={(e) => setPickerQuery(e.target.value)}
            sx={{ "& input": { ...mono, py: 0.6 } }}
          />
        </Box>
        <Divider />
        {pickerGroups.length === 0 && (
          <Typography sx={{ px: 2, py: 1.5, fontSize: 12.5, color: "text.disabled" }}>No matching values</Typography>
        )}
        {pickerGroups.map(({ dim, values }) => [
          <ListSubheader key={`${dim.key}-h`} sx={{ lineHeight: "28px", fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em" }}>
            {dim.label}
          </ListSubheader>,
          ...values.map((v) => (
            <MenuItem
              key={`${dim.key}:${v}`}
              onClick={() => {
                onChange({ ...active, [dim.key]: v });
                closePicker();
              }}
              sx={{ ...mono, py: 0.5 }}
            >
              {displayValue(v, dim.labels)}
            </MenuItem>
          )),
        ])}
      </Menu>
    </Stack>
  );
}
