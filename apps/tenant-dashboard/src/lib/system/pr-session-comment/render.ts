import type { LinkedSessionRow } from "./read";

/**
 * The renderer behind the PR session comment: `rows` (from
 * `readLinkedSessions`) + `topics` (from `readTopicLabels`) + `links` (this
 * module's own data param, see {@link RenderLinks}) → a single markdown
 * string.
 *
 * PURE. No I/O, no supabase or ClickHouse client imports — this is what lets
 * the acceptance suite prove the comment's user-visible guarantees against
 * plain objects, no server, no database.
 *
 * PRIVACY: `LinkedSessionRow` and `readTopicLabels`'s map never carry a human
 * name, an actor/author/profile field, or transcript content (topic labels
 * are curated names, never `trace_facets.Summary`) — so this module has
 * nothing to leak structurally. `__tests__/render.test.ts` still asserts the
 * rendered text on a row with extra (hypothetical) actor-shaped fields never
 * surfaces them, as a regression guard on that invariant.
 */

/**
 * GitHub's issue-comment body limit. There is deliberately no row cap on
 * the table — a PR with enough linked sessions to hit this ceiling means
 * the feature is working well beyond expectations, not misbehaving — so
 * this module enforces the ceiling itself: a body that would exceed it
 * keeps as many rows as fit and names the remainder (see
 * {@link fitTableRows}), rather than dropping the table.
 * https://docs.github.com/en/rest/issues/comments — body max length.
 */
const GITHUB_COMMENT_BODY_LIMIT = 65536;

/**
 * Invisible identity marker carried by every body this module renders.
 *
 * GitHub renders an HTML comment as nothing, so this costs a reader nothing
 * and buys the one capability the stored `github_comment_id` cannot provide:
 * recognizing our own comment on a PR when the id was never persisted. That
 * happens when a poster dies between the successful POST and the row write —
 * the comment exists, nothing points at it, and the next caller to take over
 * the abandoned claim would otherwise post a second one. `findPostedComment`
 * (refresh.ts) scans for this marker before creating on a takeover, adopts
 * what it finds, and edits instead.
 *
 * Therefore: stable forever. Changing this string orphans every comment
 * already posted with the old one.
 */
export const PR_SESSION_COMMENT_MARKER = "<!-- outerlayer:pr-session-comment -->";

/**
 * `ErrorCount` above this on a single session's rollup counts as an "error
 * storm" for the trouble badge. Set to 3 as a product call: the badge is
 * there to catch the "eight sessions of fighting" case, and a session that
 * accumulated more than three errors is worth a reviewer's glance. Provider
 * errors (`ApiErrorCount > 0`) always badge regardless of this threshold —
 * a single provider error is never expected.
 */
const ERROR_STORM_THRESHOLD = 3;

/**
 * Caller-supplied data needed to compose deep links. Kept a plain data
 * parameter (never resolved here) so this module stays pure: the read layer
 * resolves `appId`/`appName`/`envName` per row but deliberately does not
 * build URL strings, and `orgName` isn't on the row at all (the read layer
 * has no org context). The orchestrator resolves `orgName` and the
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

/** URL path segments are tenant-authored (`appName`, `envName`) or
 * ClickHouse-derived (`traceId`). An unencoded `)` in any of them closes the
 * markdown link early and spills the rest of the URL into the comment text,
 * so every interpolated segment goes through this. */
function urlSegment(value: string): string {
  return encodeURIComponent(value);
}

function sessionDeepLink(
  links: RenderLinks,
  row: Pick<LinkedSessionRow, "appName" | "envName" | "traceId">,
): string {
  const src = links.sourceTag ?? DEFAULT_SOURCE_TAG;
  return `${links.baseUrl}/orgs/${urlSegment(links.orgName)}/apps/${urlSegment(row.appName)}/env/${urlSegment(row.envName)}/agents/sessions/${urlSegment(row.traceId)}?src=${urlSegment(src)}`;
}

function sessionsListLink(links: RenderLinks, appName: string, envName: string): string {
  const src = links.sourceTag ?? DEFAULT_SOURCE_TAG;
  return `${links.baseUrl}/orgs/${urlSegment(links.orgName)}/apps/${urlSegment(appName)}/env/${urlSegment(envName)}/agents/sessions?pr=${links.prNumber}&src=${urlSegment(src)}`;
}

/**
 * Escapes text for a table cell that may also be a link label.
 *
 * Everything this renders is attacker-influenceable: session titles are
 * transcript-derived and topic labels are tenant-authored, and the result is
 * a world-readable comment in someone else's repository. Cell-breaking is
 * only half the problem — a title containing `](` breaks out of the
 * `[label](url)` wrapper in {@link renderRow} and turns the rest of the cell
 * into a clickable link the tenant chose. So this escapes:
 *   - `\` first (otherwise it would double-escape the escapes below),
 *   - `|` and newlines (cell/row structure),
 *   - `[`, `]`, `(`, `)` (link-syntax breakout),
 *   - `<` (GitHub renders inline HTML in comments; a raw tag would too).
 */
function escapeMarkdownCell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/([|[\]()])/g, "\\$1")
    .replace(/</g, "&lt;");
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

/**
 * A cost we don't have renders as an em-dash, never `$0.00`.
 *
 * `CostUsd` is non-nullable at rest, which is a property of the storage and
 * not of reality: a session whose cost was never captured arrives here as 0,
 * and printing "$0.00" for it claims the work was free. Zero and unknown are
 * indistinguishable in the data, so the honest rendering is the one that
 * doesn't assert. Header totals still sum the numbers as they are.
 */
function formatCost(costUsd: number): string {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return "—";
  return `$${costUsd.toFixed(2)}`;
}

function troubleBadge(row: Pick<LinkedSessionRow, "apiErrorCount" | "errorCount">): string {
  if (row.apiErrorCount > 0) return " ⚠ provider errors";
  if (row.errorCount > ERROR_STORM_THRESHOLD) return " ⚠ error storm";
  return "";
}

/**
 * "An inferred link is never presented as certain" is entirely this
 * predicate.
 *
 * Deliberately an allowlist of the ONE method that constitutes an explicit
 * claim, not a denylist of `branch`: `pull_request_session.method` gaining a
 * third value (a future inference strategy) must default to badged, not
 * silently render as certain. The `never` assignment makes that a compile
 * error at the same time, so a new method can't be added without a decision
 * being made here.
 */
function isCertainMethod(method: LinkedSessionRow["method"]): boolean {
  switch (method) {
    case "pr_link":
      return true;
    case "branch":
      return false;
    default: {
      const exhaustive: never = method;
      void exhaustive;
      return false;
    }
  }
}

function renderRow(
  row: LinkedSessionRow,
  topics: Map<string, string[]>,
  links: RenderLinks,
): string {
  const rawTitle = row.title.trim();
  const label = rawTitle ? escapeMarkdownCell(rawTitle) : "untitled session";
  const url = sessionDeepLink(links, row);
  const inferredBadge = isCertainMethod(row.method) ? "" : " _(inferred)_";
  const badge = `${inferredBadge}${troubleBadge(row)}`;

  const rowTopics = topics.get(row.traceId) ?? [];
  const topicsCell = rowTopics.length > 0 ? rowTopics.map(escapeMarkdownCell).join(", ") : "—";

  const duration = formatDurationMinutes(durationMinutes(row.startedAt, row.endedAt));
  const cost = formatCost(row.costUsd);
  // Escaped for the same reason titles and topics are: model names are
  // SDK/transcript-supplied and sanitized at no hop on the way here, so an
  // unescaped `|` forges a column in a world-readable comment.
  const models = row.models.length > 0 ? row.models.map(escapeMarkdownCell).join(", ") : "—";

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
  // A connected repo's PR always gets this slot, even with zero linked
  // sessions — that's what makes a *missing* comment legible as "app not
  // connected" rather than "no sessions yet".
  if (rows.length === 0) {
    return `No agent sessions linked yet.\n\n${PR_SESSION_COMMENT_MARKER}`;
  }

  const totalMinutes = rows.reduce(
    (sum, row) => sum + durationMinutes(row.startedAt, row.endedAt),
    0,
  );
  // Header totals are sums over every linked session, never a per-PR cost
  // claim — a session spanning 3 PRs counts fully in all 3.
  // The header carries that exact phrase, so a
  // reader never mistakes it for a per-PR attribution.
  const totalCost = rows.reduce((sum, row) => sum + row.costUsd, 0);
  const sessionWord = rows.length === 1 ? "session" : "sessions";
  const header = `### Agent sessions behind this PR — ${rows.length} linked ${sessionWord} · ${formatDurationMinutes(totalMinutes)} · ${formatCost(totalCost)}\n_Totals are sums over linked sessions._`;

  const tableHeader = "| Session | Topics | Duration | Cost | Models |\n| ------- | ------ | -------- | ---- | ------ |";
  const tableRows = rows.map((row) => renderRow(row, topics, links));

  // Rows can span more than one app in the tenant, but the whole-PR link
  // always renders: the multi-app PR is the one most likely to have a lead
  // asking "how did this get built?", and leaving it with no doorway at all
  // was the worse of the two failures. It points at the app/env of the first
  // row — one real scope rather than none.
  //
  // TODO: this link can only scope to ONE app/env, because the sessions
  // list's `?pr=` filter is pinned to a single `app_id`
  // (`features/agent-sessions/service.ts` — the other half of this coupling
  // is commented there). So on a multi-app PR the page a reader lands on
  // shows a SUBSET of the rows above, with smaller totals, which is a real
  // "every figure matches the dashboard exactly" gap. The fix is
  // a tenant-scoped `?pr=` route, or a per-session route that doesn't need
  // an app in the path; until then this is a knowingly-accepted mismatch.
  const firstRow = rows[0];
  const footer = firstRow
    ? `Full transcripts in the [session dashboard](${sessionsListLink(links, firstRow.appName, firstRow.envName)}).`
    : null;

  const fitted = fitTableRows(tableRows, header, tableHeader, footer);
  const bodyParts = [header];
  if (fitted.rows.length > 0) {
    bodyParts.push(`${tableHeader}\n${fitted.rows.join("\n")}`);
  }
  if (fitted.omitted > 0) {
    const word = fitted.omitted === 1 ? "session" : "sessions";
    bodyParts.push(`_…and ${fitted.omitted} more ${word} — see the dashboard._`);
  }
  if (footer) bodyParts.push(footer);
  // Last, so it never displaces content a reader sees, and so the fitter's
  // reservation for it (below) is a plain constant.
  bodyParts.push(PR_SESSION_COMMENT_MARKER);
  return bodyParts.join("\n\n");
}

/**
 * Fits as many table rows as the GitHub body limit allows, keeping the
 * header, the table header, the overflow line, and the footer.
 *
 * Over the ceiling the comment degrades to "the most recent N sessions, and
 * a count of the rest" rather than dropping the table entirely — the same
 * ceiling, a far more useful comment than a cost total with no idea which
 * sessions produced it.
 *
 * Which N is load-bearing. `readLinkedSessions` returns rows OLDEST-first so
 * the table reads as the story of how the branch got built, and this fitter
 * must not quietly invert that choice into "drop the newest": the session
 * that triggered this very refresh is the newest one, and dropping it is the
 * one omission a reviewer would notice. So the fit is taken from the TAIL —
 * newest kept, oldest omitted — and the kept rows are then restored to
 * oldest-first for rendering. Reachable, not pathological: ~385 typical rows
 * reach 64 KB, well under `MAX_LINKS`.
 */
function fitTableRows(
  tableRows: string[],
  header: string,
  tableHeader: string,
  footer: string | null,
): { rows: string[]; omitted: number } {
  const separators = "\n\n".length;
  const fixed =
    header.length +
    separators +
    tableHeader.length +
    (footer ? separators + footer.length : 0) +
    // The marker is appended unconditionally by the caller and must be
    // inside the ceiling, not pushed over it by the last row that fits.
    separators +
    PR_SESSION_COMMENT_MARKER.length;
  // Reserved unconditionally, so dropping the last row can never push the
  // body back over the limit by adding this line.
  const overflowLine = `_…and ${tableRows.length} more sessions — see the dashboard._`;

  let used = fixed;
  const kept: string[] = [];
  // Newest-first (from the tail), so the rows that survive the ceiling are
  // the most recent ones — see the ordering note above.
  for (let i = tableRows.length - 1; i >= 0; i -= 1) {
    const row = tableRows[i]!;
    const cost = row.length + 1; // the newline joining it to the previous row
    const reserve = kept.length + 1 === tableRows.length ? 0 : separators + overflowLine.length;
    if (used + cost + reserve > GITHUB_COMMENT_BODY_LIMIT) break;
    used += cost;
    kept.push(row);
  }
  // Back to the oldest-first reading order the table is built around.
  kept.reverse();

  // Degenerate case — not even one row fits (a single pathological title
  // near the 64 KB ceiling). `kept` stays empty and the caller drops the
  // table header with it, leaving the totals, the "…and N more" line, and
  // the link: the fallback, reached only where truncating genuinely can't
  // help.
  return { rows: kept, omitted: tableRows.length - kept.length };
}
