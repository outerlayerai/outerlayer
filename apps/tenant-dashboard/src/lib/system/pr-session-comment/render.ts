import type { LinkedSessionRow } from "./read";

/**
 * The renderer behind the PR session comment: `rows` (PR 3's
 * `readLinkedSessions`) + `topics` (PR 4's `readTopicLabels`) + `links` (this
 * module's own data param, see {@link RenderLinks}) → a single markdown
 * string.
 *
 * PURE. No I/O, no supabase or ClickHouse client imports — this is what lets
 * the acceptance suite prove seven criteria (AC-057-01, -04, -05, -06, -07,
 * -08, -11) against plain objects, no server, no database.
 *
 * PRIVACY: `LinkedSessionRow` and `readTopicLabels`'s map never carry a human
 * name, an actor/author/profile field, or transcript content (topic labels
 * are curated names, never `trace_facets.Summary`) — so this module has
 * nothing to leak structurally. `__tests__/render.test.ts` still asserts the
 * rendered text on a row with extra (hypothetical) actor-shaped fields never
 * surfaces them, as a regression guard on that invariant.
 */

/**
 * GitHub's issue-comment body limit (risk R3). There is deliberately no row
 * cap on the table (decision 11: "if we have this problem we are in a good
 * spot"), so this module enforces the ceiling itself: a body that would
 * exceed it falls back to the header plus the dashboard link.
 * https://docs.github.com/en/rest/issues/comments — body max length.
 */
const GITHUB_COMMENT_BODY_LIMIT = 65536;

/**
 * `ErrorCount` above this on a single session's rollup counts as an "error
 * storm" for the trouble badge (decision 14). Chosen well above the noise of
 * a normal session with a handful of retried tool calls, while still well
 * under what a genuinely stuck session accumulates. Provider errors
 * (`ApiErrorCount > 0`) always badge regardless of this threshold — a single
 * provider error is never expected.
 */
const ERROR_STORM_THRESHOLD = 10;

/**
 * Caller-supplied data needed to compose deep links. Kept a plain data
 * parameter (never resolved here) so this module stays pure: the read layer
 * resolves `appId`/`appName`/`envName` per row but deliberately does not
 * build URL strings, and `orgName` isn't on the row at all (the read layer
 * has no org context). The orchestrator (PR 7) resolves `orgName` and the
 * dashboard origin and passes them through.
 */
export interface RenderLinks {
  /** Absolute dashboard origin, no trailing slash, e.g. "https://app.outerlayer.example". */
  baseUrl: string;
  /** Org slug for the `/orgs/<orgName>/...` URL segment. */
  orgName: string;
  /** The PR number this comment is for, for the sessions-list URL's `?pr=` filter. */
  prNumber: number;
  /** Query param tag every link carries, so referrers aren't relied on (the story's success signal). */
  sourceTag?: string;
}

const DEFAULT_SOURCE_TAG = "pr-comment";

function sessionDeepLink(
  links: RenderLinks,
  row: Pick<LinkedSessionRow, "appName" | "envName" | "traceId">,
): string {
  const src = links.sourceTag ?? DEFAULT_SOURCE_TAG;
  return `${links.baseUrl}/orgs/${links.orgName}/apps/${row.appName}/env/${row.envName}/agents/sessions/${row.traceId}?src=${src}`;
}

function sessionsListLink(links: RenderLinks, appName: string, envName: string): string {
  const src = links.sourceTag ?? DEFAULT_SOURCE_TAG;
  return `${links.baseUrl}/orgs/${links.orgName}/apps/${appName}/env/${envName}/agents/sessions?pr=${links.prNumber}&src=${src}`;
}

/** Markdown-escapes a title so it can't break out of a table cell: `|`
 * would end the cell early, and a raw newline would end the row. */
function escapeMarkdownCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, " ");
}

function durationMinutes(startedAt: string, endedAt: string): number {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / 60_000));
}

function formatDurationMinutes(totalMinutes: number): string {
  const minutes = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return hours > 0 ? `${hours}h ${remaining}m` : `${remaining}m`;
}

function formatCost(costUsd: number): string {
  return `$${costUsd.toFixed(2)}`;
}

function troubleBadge(row: Pick<LinkedSessionRow, "apiErrorCount" | "errorCount">): string {
  if (row.apiErrorCount > 0) return " ⚠ provider errors";
  if (row.errorCount > ERROR_STORM_THRESHOLD) return " ⚠ error storm";
  return "";
}

function renderRow(
  row: LinkedSessionRow,
  topics: Map<string, string[]>,
  links: RenderLinks,
): string {
  const rawTitle = row.title.trim();
  const label = rawTitle ? escapeMarkdownCell(rawTitle) : "untitled session";
  const url = sessionDeepLink(links, row);
  const inferredBadge = row.method === "branch" ? " _(inferred)_" : "";
  const badge = `${inferredBadge}${troubleBadge(row)}`;

  const rowTopics = topics.get(row.traceId) ?? [];
  const topicsCell = rowTopics.length > 0 ? rowTopics.map(escapeMarkdownCell).join(", ") : "—";

  const duration = formatDurationMinutes(durationMinutes(row.startedAt, row.endedAt));
  const cost = formatCost(row.costUsd);
  const models = row.models.length > 0 ? row.models.join(", ") : "—";

  return `| [${label}](${url})${badge} | ${topicsCell} | ${duration} | ${cost} | ${models} |`;
}

/**
 * Renders the PR session comment body from linked-session rows, their topic
 * labels, and the link-composition data. Pure — no I/O.
 */
export function renderComment(
  rows: LinkedSessionRow[],
  topics: Map<string, string[]>,
  links: RenderLinks,
): string {
  // AC-057-04: a connected repo's PR always gets this slot, even with zero
  // linked sessions — that's what makes a *missing* comment legible as
  // "app not connected" rather than "no sessions yet".
  if (rows.length === 0) {
    return "No agent sessions linked yet.";
  }

  const totalMinutes = rows.reduce(
    (sum, row) => sum + durationMinutes(row.startedAt, row.endedAt),
    0,
  );
  // Header totals are sums over every linked session, never a per-PR cost
  // claim (decision 12) — a session spanning 3 PRs counts fully in all 3.
  const totalCost = rows.reduce((sum, row) => sum + row.costUsd, 0);
  const sessionWord = rows.length === 1 ? "session" : "sessions";
  const header = `### Agent sessions behind this PR — ${rows.length} linked ${sessionWord} · ${formatDurationMinutes(totalMinutes)} · ${formatCost(totalCost)}`;

  const tableHeader = "| Session | Topics | Duration | Cost | Models |\n| ------- | ------ | -------- | ---- | ------ |";
  const tableRows = rows.map((row) => renderRow(row, topics, links));

  // Decision 9: rows can span more than one app in the tenant. A single
  // whole-PR dashboard link only makes sense when every row resolves to the
  // same app/env scope; otherwise it's omitted and readers rely on each
  // row's own deep link.
  const distinctAppEnv = new Set(rows.map((row) => `${row.appName} ${row.envName}`));
  const firstRow = rows[0];
  const footer =
    distinctAppEnv.size === 1 && firstRow
      ? `Full transcripts in the [session dashboard](${sessionsListLink(links, firstRow.appName, firstRow.envName)}).`
      : null;

  const bodyParts = [header, `${tableHeader}\n${tableRows.join("\n")}`];
  if (footer) bodyParts.push(footer);
  const body = bodyParts.join("\n\n");

  if (body.length <= GITHUB_COMMENT_BODY_LIMIT) {
    return body;
  }

  // Risk R3: GitHub rejects comment bodies over 65536 characters, and this
  // feature deliberately has no row cap (decision 11). Fall back to the
  // header plus the dashboard link (when one exists) rather than posting a
  // body GitHub will reject outright.
  return footer ? `${header}\n\n${footer}` : header;
}
