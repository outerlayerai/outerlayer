"use client";

/** Sessions list (app = repo) — repo-scoped, paginated. Filtering follows the
 * converged token pattern (see session-filter-bar.tsx); every filter, the
 * sort, and the page live in the URL so a filtered view is shareable,
 * back-button-safe, and deep-linkable (Insights → sessions drill-downs).
 *
 * The page React Server Component (RSC) owns the fetch (features/agent-sessions/service.ts,
 * `listSessions`) keyed on these same search params; this component is
 * presentational + navigation-driving. It holds no mirrored filter state —
 * every filter/sort/page value is read straight from the URL (the RSC read
 * already ran under these exact params) — and writes changes back via
 * `router.replace` wrapped in a transition, so the already-rendered table
 * doesn't flash to the Suspense fallback on a filter click. */
import { Fragment, useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { alpha } from "@mui/material/styles";
import Iconify from "@/components/iconify";
import { Stack } from "./agent-ui";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Box,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TableSortLabel,
  Typography,
} from "@mui/material";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { TablePager } from "@/components/table-pager";
import type { SessionsPage, SessionsSort, SessionsSignal, SessionPrOutcome } from "../types";
import { parseTopicFacet } from "@/lib/analytics/topics/topics-shared";
import { useSavedViews } from "@/hooks/use-saved-views";
import type { SavedFilter } from "@/lib/analytics/saved-filters/read";
import { money, shortModel, agentColor } from "./agent-format";
import { fNumber } from "@/utils/format-number";
import { appPaths } from "@/routes/paths";
import { SessionFilterBar, type ActiveFilters } from "./session-filter-bar";
import { SESSIONS_PAGE_SIZE as PAGE, DEFAULT_ORIGIN } from "../session-list-shared";

const SORTS: readonly SessionsSort[] = ["startedAt", "cost", "errors", "turns", "steering", "toolErrorRate"] as const;
const mono = { fontFamily: "monospace", fontSize: 12.5 } as const;

/** Trajectory-signal facet — a fixed taxonomy (every bucket exists for every
 * fleet), so the values are UI constants like the origin segments, not a
 * server vocabulary. Keys are the API's `signal` tokens; labels name the
 * observable event (a follow-up is ANY human turn after the initial ask —
 * the deterministic counter can't distinguish a correction from a new task,
 * so the words don't claim to). */
const SIGNAL_VALUES: readonly SessionsSignal[] = ["hands-on", "denied", "tool-errors", "provider-errors", "clean"] as const;
const SIGNAL_LABELS: Record<string, string> = {
  "hands-on": "hands-on (any follow-up)",
  denied: "tool call denied",
  "tool-errors": "tool errors",
  "provider-errors": "provider errors",
  clean: "clean trajectory",
};
const asSignal = (v: string | null): SessionsSignal | undefined =>
  (SIGNAL_VALUES as readonly string[]).includes(v ?? "") ? (v as SessionsSignal) : undefined;

// ── PR-outcome column ────────────────────────────────────────────────────
// One session can produce several PRs; the scores carry no PR number, so the
// server groups them per PR (see session-outcome-read). Single-PR rows show
// one pill (CI dot + fate); multi-PR rows show the SET of fates present + a
// count and expand into a sub-row per PR — a merge can never hide a revert.
const TOTAL_COLS = 11;
type OutcomeTone = "good" | "bad" | "neutral" | "open";
const toneSx = (tone: OutcomeTone) => (t: import("@mui/material/styles").Theme) => {
  const c =
    tone === "good" ? t.palette.success.main
    : tone === "bad" ? t.palette.error.main
    : tone === "open" ? t.palette.info.main
    : t.palette.text.secondary;
  const bgRef = tone === "neutral" ? t.palette.text.primary : c;
  return { color: c, backgroundColor: alpha(bgRef, 0.12) };
};

/** Terminal state for one PR: a revert beats a merge beats a close; a PR with
 * only a CI score and no fate yet is still open. */
function fateOf(pr: SessionPrOutcome): { label: string; tone: OutcomeTone } {
  if (pr.reverted && pr.reverted.score >= 1) return { label: "reverted", tone: "bad" };
  if (pr.merged) return pr.merged.score >= 1 ? { label: "merged", tone: "good" } : { label: "closed", tone: "neutral" };
  return { label: "open", tone: "open" };
}

function ciDot(pr: SessionPrOutcome): ReactNode {
  if (!pr.ciGreen) return null;
  const ok = pr.ciGreen.score >= 1;
  return (
    <Box
      component="span"
      title={ok ? "CI passed first try" : "CI failed first run (then fixed)"}
      sx={(t) => ({ width: 6, height: 6, borderRadius: "50%", flex: "none", backgroundColor: ok ? t.palette.success.main : t.palette.warning.main })}
    />
  );
}

function FateChip({ label, tone, dot }: { label: string; tone: OutcomeTone; dot?: ReactNode }) {
  return (
    <Box
      component="span"
      sx={(t) => ({ display: "inline-flex", alignItems: "center", gap: 0.5, fontFamily: "monospace", fontSize: 10.5, lineHeight: "17px", height: 18, px: 0.75, borderRadius: "9px", ...toneSx(tone)(t) })}
    >
      {dot}
      {label}
    </Box>
  );
}

/** The multi-PR summary: which fates are present (deduped, worst first), + count. */
function OutcomeSummary({ prs }: { prs: SessionPrOutcome[] }) {
  const rank: Record<string, number> = { reverted: 0, closed: 1, open: 2, merged: 3 };
  const seen = new Map<string, OutcomeTone>();
  for (const pr of prs) {
    const f = fateOf(pr);
    if (!seen.has(f.label)) seen.set(f.label, f.tone);
  }
  const fates = [...seen.entries()].sort((a, b) => (rank[a[0]] ?? 9) - (rank[b[0]] ?? 9));
  return (
    <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, flexWrap: "wrap" }}>
      {fates.map(([label, tone]) => (
        <FateChip key={label} label={label} tone={tone} />
      ))}
      <Box component="span" sx={{ fontFamily: "monospace", fontSize: 10.5, color: "text.secondary", ml: 0.25 }}>{prs.length} PRs</Box>
    </Box>
  );
}

function OutcomeCell({ prs, expanded, onToggle }: { prs: SessionPrOutcome[] | undefined; expanded: boolean; onToggle: () => void }) {
  const list = prs ?? [];
  if (list.length === 0) return <Box component="span" sx={{ color: "text.disabled" }}>—</Box>;
  if (list.length === 1) return <FateChip {...fateOf(list[0]!)} dot={ciDot(list[0]!)} />;
  // A proper disclosure control: a rotating chevron + hover highlight + a
  // pointer, so it reads as expandable at a glance rather than a stray caret.
  return (
    <Box
      component="span"
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      title={expanded ? "Hide the PRs" : "Show each PR"}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); e.preventDefault(); onToggle(); } }}
      sx={(t) => ({
        display: "inline-flex",
        alignItems: "center",
        gap: 0.5,
        cursor: "pointer",
        py: 0.25,
        pl: 0.25,
        pr: 0.75,
        ml: -0.25,
        borderRadius: 1,
        transition: "background-color .12s",
        "&:hover": { backgroundColor: alpha(t.palette.text.primary, 0.06) },
        "&:focus-visible": { outline: "2px solid", outlineColor: t.palette.primary.main, outlineOffset: 1 },
      })}
    >
      <Iconify
        icon="eva:arrow-ios-forward-fill"
        width={16}
        sx={{ color: "text.secondary", flexShrink: 0, transition: "transform .15s", transform: expanded ? "rotate(90deg)" : "none" }}
      />
      <OutcomeSummary prs={list} />
    </Box>
  );
}

const ORIGIN_KEYS = ["interactive", "agent", "worker"] as const;
/** URL/string → an origin state value: "" = every origin. "all" is the
 * explicit every-origin choice; a comma-set of valid tokens passes through;
 * anything unrecognized falls back to the caller's default — People for the
 * plain list, every origin for a topic drill-down, whose facet-specific
 * origin rules live in the query itself. */
const asOrigin = (v: string | null, dflt: string): string => {
  if (v === "all") return "";
  if (v && v.split(",").every((t) => (ORIGIN_KEYS as readonly string[]).includes(t))) return v;
  return dflt;
};

/** `undefined`/absent → deleted; anything else set. Keeps the URL-builder
 * call sites in this file down to one line per field. */
function setOrDelete(url: URLSearchParams, key: string, value: string | undefined | null) {
  if (value) url.set(key, value);
  else url.delete(key);
}

export function AgentSessions({
  data,
  appId,
  envName,
  savedFilters = [],
}: {
  data: SessionsPage;
  appId: string;
  envName: string;
  savedFilters?: SavedFilter[];
}) {
  const params = useParams<{ orgName: string; appName: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  // ---------------------------------------------------------------------
  // URL = the single source of filter truth — read directly, never mirrored
  // into local state. The RSC read behind this render already ran under
  // these exact params, so there is nothing to "seed": this IS the state.
  // ---------------------------------------------------------------------
  const topicId = searchParams.get("topicId") ?? undefined;
  const topicFacet = parseTopicFacet(searchParams.get("topicFacet"));
  const topicName = searchParams.get("topicName") ?? undefined; // display only
  const topicActive = Boolean(topicId && topicFacet);
  // The pristine segment for the current mode; only a deviation goes in the URL.
  const defaultOrigin = topicActive ? "" : DEFAULT_ORIGIN;

  const filters: ActiveFilters = {
    agent: searchParams.get("agent") ?? undefined,
    branch: searchParams.get("branch") ?? undefined,
    developer: searchParams.get("developer") ?? undefined,
    model: searchParams.get("model") ?? undefined,
    source: searchParams.get("source") ?? undefined,
    signal: asSignal(searchParams.get("signal")),
  };
  const range = searchParams.get("range") ?? "";
  const origin = asOrigin(searchParams.get("origin"), defaultOrigin);
  const q = searchParams.get("q") ?? "";
  const sort: SessionsSort = (SORTS as readonly string[]).includes(searchParams.get("sort") ?? "")
    ? (searchParams.get("sort") as SessionsSort)
    : "startedAt";
  const dir: "asc" | "desc" = searchParams.get("dir") === "asc" ? "asc" : "desc";
  const page = Math.max(0, Number(searchParams.get("page") ?? 0) || 0);

  // Local-only UI state the URL can't (or shouldn't) carry: the debounced
  // search INPUT (staged before it commits to `q`) and which multi-PR rows
  // are expanded.
  const [search, setSearch] = useState(() => q);
  const [expandedOutcomes, setExpandedOutcomes] = useState<Set<string>>(() => new Set());
  const toggleOutcome = (traceId: string) =>
    setExpandedOutcomes((prev) => {
      const next = new Set(prev);
      if (next.has(traceId)) next.delete(traceId);
      else next.add(traceId);
      return next;
    });

  /** Every filter/sort/page change goes through here: patch the CURRENT URL
   * and navigate inside a transition, so the already-rendered table stays up
   * (no Suspense flash) while the RSC re-fetches under the new params. */
  const patch = (mutate: (url: URLSearchParams) => void) => {
    const url = new URLSearchParams(searchParams.toString());
    mutate(url);
    const next = url.toString();
    startTransition(() => {
      router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
    });
  };

  const clearTopic = () =>
    patch((url) => {
      url.delete("topicId");
      url.delete("topicFacet");
      url.delete("topicName");
    });

  // Debounce the search box → one navigation per pause, not per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      patch((url) => {
        setOrDelete(url, "q", search.trim() || undefined);
        url.delete("page");
      });
    }, 300);
    return () => clearTimeout(t);
     
  }, [search]);

  // Saved views come from the shared saved_trace_filters store, scoped per page.
  // A view for this surface is a named URL: filter_config = { v: 1, query }.
  const savedViews = useSavedViews({ page: "agents-sessions", appId: appId || undefined, initialViews: savedFilters });
  const currentQuery = useMemo(() => {
    const url = new URLSearchParams();
    setOrDelete(url, "q", q || undefined);
    setOrDelete(url, "agent", filters.agent);
    setOrDelete(url, "branch", filters.branch);
    setOrDelete(url, "developer", filters.developer);
    setOrDelete(url, "model", filters.model);
    setOrDelete(url, "source", filters.source);
    setOrDelete(url, "signal", filters.signal);
    setOrDelete(url, "range", range || undefined);
    if (sort !== "startedAt") url.set("sort", sort);
    if (dir !== "desc") url.set("dir", dir);
    return url.toString();
     
  }, [q, filters.agent, filters.branch, filters.developer, filters.model, filters.source, filters.signal, range, sort, dir]);

  const applyView = (id: string) => {
    const view = savedViews.views.find((v) => v.id === id);
    const query = view && typeof view.filter_config.query === "string" ? view.filter_config.query : null;
    if (query === null) return;
    // Every other filter/sort/page value is derived from the URL, so a plain
    // navigation re-seeds them all; only the debounced search INPUT is local
    // state that needs an explicit resync.
    setSearch(new URLSearchParams(query).get("q") ?? "");
    startTransition(() => {
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    });
  };

  const open = (traceId: string) => router.push(appPaths.agents.session(params.orgName, params.appName, envName, traceId));
  const total = data.total;

  const sortBy = (column: SessionsSort) => {
    const nextDir = sort === column ? (dir === "desc" ? "asc" : "desc") : "desc";
    patch((url) => {
      if (column !== "startedAt") url.set("sort", column);
      else url.delete("sort");
      if (nextDir !== "desc") url.set("dir", nextDir);
      else url.delete("dir");
      url.delete("page");
    });
  };

  const sortHeader = (column: SessionsSort, label: string) => (
    <TableSortLabel active={sort === column} direction={sort === column ? dir : "desc"} onClick={() => sortBy(column)}>
      {label}
    </TableSortLabel>
  );

  const dimensions = [
    { key: "agent" as const, label: "Agent", values: data.agentTypes },
    { key: "branch" as const, label: "Branch", values: data.branches },
    { key: "developer" as const, label: "Developer", values: data.actors, labels: data.actorNames },
    { key: "model" as const, label: "Model", values: data.models },
    { key: "source" as const, label: "Source", values: data.workerKinds },
    // Fixed taxonomy, not a server vocabulary — every bucket always offered.
    // Labeled by the signal family so the word ties this filter to the
    // fleet's Trajectory Signals chart and the definitions doc; the wire
    // param stays `signal`.
    { key: "signal" as const, label: "Trajectory", values: [...SIGNAL_VALUES], labels: SIGNAL_LABELS },
  ];

  return (
    // The dim-while-pending wrapper carries no width or padding of its own —
    // the layout frame owns the content column.
    <Box sx={{ opacity: isPending ? 0.6 : 1, transition: "opacity .15s" }}>
      <PageHeader
        title="Sessions"
        caption={
          <>
            <Box component="span" sx={{ fontFamily: "monospace", color: "primary.main" }}>
              {data.repo || "(unassigned)"}
            </Box>
            <Box component="span" sx={{ ml: 1 }}>
              · {fNumber(total)} sessions
            </Box>
          </>
        }
      />

      {topicActive && (
        <Box sx={{ mb: 2 }}>
          <Chip
            color="primary"
            variant="outlined"
            onDelete={clearTopic}
            data-testid="topic-drilldown-chip"
            label={`Topic · ${topicFacet}: ${topicName || topicId}`}
          />
        </Box>
      )}

      <SessionFilterBar
        search={search}
        onSearch={setSearch}
        range={range}
        onRange={(key) => {
          patch((url) => {
            setOrDelete(url, "range", key || undefined);
            url.delete("page");
          });
        }}
        origin={origin}
        onOrigin={(key) => {
          // "" is the All segment — a real choice, not an absent value.
          const nextOrigin = key === "" ? "" : asOrigin(key, defaultOrigin);
          patch((url) => {
            if (nextOrigin !== defaultOrigin) url.set("origin", nextOrigin || "all");
            else url.delete("origin");
            url.delete("page");
          });
        }}
        originCounts={data.originCounts}
        dimensions={dimensions}
        active={filters}
        onChange={(next) => {
          patch((url) => {
            setOrDelete(url, "agent", next.agent);
            setOrDelete(url, "branch", next.branch);
            setOrDelete(url, "developer", next.developer);
            setOrDelete(url, "model", next.model);
            setOrDelete(url, "source", next.source);
            setOrDelete(url, "signal", next.signal);
            url.delete("page");
          });
        }}
        views={savedViews.views.map((v) => ({ id: v.id, name: v.name }))}
        canSaveView={currentQuery.length > 0}
        onSaveView={(name) => void savedViews.save(name, { v: 1, query: currentQuery })}
        onApplyView={applyView}
        onDeleteView={(id) => void savedViews.remove(id)}
      />

      {data.sessions.length === 0 && (
        <EmptyState
          data-testid="sessions-empty"
          title="No sessions match this filter"
          description="Widen the time range, clear a filter token, or switch origin segment to see more sessions."
        />
      )}

      {data.sessions.length > 0 && (
        <>
          <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 2, overflowX: "auto" }}>
            <Table size="small">
              <TableHead>
                {/* The trajectory-signal columns (Follow-ups / Errors / Err %)
                    sit directly beside Outcome: result and ride are the two
                    halves of one judgment, so they read side by side. Turns
                    stays outside the pair — it's run volume, not a signal.
                    The family name surfaces on the Trajectory filter, not as
                    a header band. */}
                <TableRow sx={{ "& th": { fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: "text.secondary" } }}>
                  <TableCell>Session</TableCell>
                  <TableCell>Agent</TableCell>
                  <TableCell>Branch</TableCell>
                  <TableCell>Actor</TableCell>
                  <TableCell>Outcome</TableCell>
                  <TableCell align="right">{sortHeader("steering", "Follow-ups")}</TableCell>
                  <TableCell align="right">{sortHeader("errors", "Errors")}</TableCell>
                  <TableCell align="right">{sortHeader("toolErrorRate", "Err %")}</TableCell>
                  <TableCell align="right">{sortHeader("turns", "Turns")}</TableCell>
                  <TableCell align="right">{sortHeader("cost", "Cost")}</TableCell>
                  <TableCell>{sortHeader("startedAt", "When")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.sessions.map((s) => (
                  <Fragment key={s.traceId}>
                  <TableRow hover onClick={() => open(s.traceId)} sx={{ cursor: "pointer", "& td": { borderColor: "divider", borderBottom: expandedOutcomes.has(s.traceId) ? 0 : undefined } }}>
                    <TableCell sx={{ maxWidth: 360 }}>
                      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
                        <Typography noWrap sx={{ fontWeight: 500, fontSize: 13.5 }} title={s.title ?? ""}>
                          {s.title || "(untitled session)"}
                        </Typography>
                        {/* Only in the mixed (All) view — a selected origin makes
                            every row that origin, so a per-row chip is noise.
                            Workers show their identity via WorkerKind already. */}
                        {origin === "" && s.origin === "agent" && (
                          <Chip label="Agent" size="small" sx={{ height: 18, fontSize: 10, flexShrink: 0 }} />
                        )}
                      </Stack>
                      <Typography noWrap sx={{ fontSize: 11, color: "text.secondary", fontFamily: "monospace" }}>
                        {s.models.map(shortModel).join(", ") || "—"}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip label={s.agentType} size="small" sx={{ height: 20, fontFamily: "monospace", fontSize: 10.5, bgcolor: `${agentColor(s.agentType)}18`, color: agentColor(s.agentType) }} />
                      {s.workerKind && s.workerKind !== "seat" && (
                        <Typography sx={{ fontFamily: "monospace", fontSize: 10, color: "text.secondary", mt: 0.25 }}>{s.workerKind}</Typography>
                      )}
                    </TableCell>
                    <TableCell sx={{ maxWidth: 200 }}>
                      <Typography noWrap sx={{ fontFamily: "monospace", fontSize: 11.5, color: "text.secondary" }} title={s.branch ?? ""}>{s.branch || "—"}</Typography>
                    </TableCell>
                    <TableCell sx={{ fontSize: 12.5 }} title={s.actorId}>
                      {data.actorNames?.[s.actorId] ?? s.actorId}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: "nowrap" }}>
                      <OutcomeCell prs={s.prOutcomes} expanded={expandedOutcomes.has(s.traceId)} onToggle={() => toggleOutcome(s.traceId)} />
                    </TableCell>
                    <TableCell
                      align="right"
                      sx={{ ...mono, color: s.userTurnCount > 1 ? "warning.main" : "text.disabled" }}
                      title={`user turns: ${s.userTurnCount} · denied tool calls: ${s.rejectedToolCallCount}`}
                    >
                      {Math.max(s.userTurnCount - 1, 0) || "—"}
                    </TableCell>
                    <TableCell align="right" sx={{ ...mono, color: s.errorCount ? "error.main" : "text.disabled" }}>{s.errorCount || "—"}</TableCell>
                    <TableCell
                      align="right"
                      sx={{ ...mono, color: s.errorCount ? "error.main" : "text.disabled" }}
                      title={`${s.errorCount} of ${s.toolCallCount} tool calls failed`}
                    >
                      {s.toolCallCount > 0 && s.errorCount > 0 ? `${Math.round((s.errorCount / s.toolCallCount) * 100)}%` : "—"}
                    </TableCell>
                    <TableCell align="right" sx={mono}>{s.turnCount}</TableCell>
                    <TableCell align="right" sx={mono}>{money(s.costUsd)}</TableCell>
                    <TableCell sx={{ fontSize: 12, color: "text.secondary", whiteSpace: "nowrap" }}>{s.startedAt.slice(0, 16).replace("T", " ")}</TableCell>
                  </TableRow>
                  {expandedOutcomes.has(s.traceId) &&
                    (s.prOutcomes ?? []).map((pr) => (
                      <TableRow key={`${s.traceId}:${pr.prNumber}`} sx={{ "& td": { borderColor: "divider", py: 0.5 } }}>
                        <TableCell colSpan={TOTAL_COLS} sx={{ pl: 5, bgcolor: (t) => alpha(t.palette.text.primary, 0.025) }}>
                          <Box sx={{ display: "inline-flex", alignItems: "center", gap: 1.5, fontFamily: "monospace", fontSize: 12 }}>
                            <Box component="span" sx={{ color: "text.disabled" }}>└</Box>
                            {pr.prUrl ? (
                              <Box
                                component="a"
                                href={pr.prUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                sx={{ display: "inline-flex", alignItems: "center", gap: 0.25, color: "info.main", textDecoration: "none", "&:hover": { textDecoration: "underline" } }}
                              >
                                #{pr.prNumber}
                                <Iconify icon="eva:external-link-outline" width={13} sx={{ opacity: 0.7 }} />
                              </Box>
                            ) : (
                              <Box component="span" sx={{ color: "info.main" }} title="No PR link captured">#{pr.prNumber}</Box>
                            )}
                            <FateChip {...fateOf(pr)} dot={ciDot(pr)} />
                          </Box>
                        </TableCell>
                      </TableRow>
                    ))}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </Box>

          {/* Page 1 drops the param entirely rather than writing `page=0`, so
              the pristine list URL stays clean and shareable. */}
          <TablePager
            page={page}
            pageSize={PAGE}
            total={total}
            itemNoun="sessions"
            onPrev={() => patch((url) => setOrDelete(url, "page", page > 1 ? String(page - 1) : undefined))}
            onNext={() => patch((url) => url.set("page", String(page + 1)))}
          />
        </>
      )}
    </Box>
  );
}
