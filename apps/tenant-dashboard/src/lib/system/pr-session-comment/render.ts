import { getAgentDescriptor } from "@/lib/worker-agents";

import type { EvidenceEvaluation, EvidenceFact } from "./evaluate";
import type { LinkedSessionRow } from "./read";
import type { PrArtifactRow } from "./artifacts-read";
import type { CriterionRequirement } from "./criteria";

/**
 * The renderer behind the PR evidence comment: `rows` (from
 * `readLinkedSessions`) + `topics` (from `readTopicLabels`) + `links` (this
 * module's own data param, see {@link RenderLinks}) + `evaluation` (from
 * `evaluateEvidence`) → a single markdown string.
 *
 * Layout, per the comment design: a verdict line first, then one aggregated
 * metadata line (session count when more than one, agent breakdown, summed
 * duration and cost, a session link), then the stated facts, then the
 * per-session detail table the comment has always carried.
 *
 * PURE. No I/O, no supabase or ClickHouse client imports — this is what lets
 * the acceptance suite prove the comment's user-visible guarantees against
 * plain objects, no server, no database. Determinism is part of the
 * contract: unchanged inputs render a byte-identical body.
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
 * How many unrecorded commit shas a flagged provenance fact names inline
 * before summarizing the rest as a count. The fact must NAME the unrecorded
 * commits, but a pathological PR (hundreds of unrecorded commits) must not
 * turn the fact line into the whole comment.
 */
const MAX_NAMED_UNRECORDED_SHAS = 10;

/** Display length for a named commit sha — git's own abbreviation habit. */
const SHA_DISPLAY_LENGTH = 7;

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

/**
 * Evidence inputs for the comment: artifacts anchored to the PR and the
 * proof requirements its changed acceptance files declare. Both are plain
 * data — the read layer and the criteria fetch own all I/O — so the renderer
 * stays pure and the evidence guarantees are provable against objects.
 */
export interface RenderEvidence {
  artifacts: PrArtifactRow[];
  criteria: CriterionRequirement[];
}

/** Artifacts rendered before the overflow line takes over. A PR with more
 * exhibits than this is a documentation dump, not evidence; the dashboard
 * holds the full list. */
const MAX_RENDERED_ARTIFACTS = 30;

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
 * doesn't assert. Totals still sum the numbers as they are.
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

/**
 * The verdict line — the first thing a reviewer reads. Copy is verbatim from
 * the comment design and is the product's voice; changing a word here is a
 * design decision, not a refactor. The one deliberate departure: the design
 * writes "Look at {N} things" with N ≥ 2 in every mock, and a count of one
 * renders the grammatical "1 thing" rather than a machine's "1 things".
 */
function verdictLine(evaluation: EvidenceEvaluation): string {
  switch (evaluation.verdict) {
    case "pass":
      return "**✅ Everything checks out — a quick review should be enough**";
    case "flag": {
      const noun = evaluation.flaggedCount === 1 ? "thing" : "things";
      return `**⚠️ Look at ${evaluation.flaggedCount} ${noun} before merging**`;
    }
    case "unverifiable":
      return "**❌ We can't verify this PR — review it fully**";
    case "waiting":
      return "**⏳ Waiting for session evidence**";
    default: {
      const exhaustive: never = evaluation.verdict;
      void exhaustive;
      return "**⏳ Waiting for session evidence**";
    }
  }
}

/**
 * Display name for a session's agent. Known ids resolve through the shared
 * agent registry ("claude-code" → "Claude Code"); unknown ones render their
 * raw id ESCAPED — `AgentType` arrives from transcript capture, sanitized at
 * no hop on the way here, same trust level as titles and model names.
 */
function agentDisplayName(agentType: string): string {
  const raw = agentType.trim();
  if (!raw) return "unknown agent";
  return getAgentDescriptor(raw)?.displayName ?? escapeMarkdownCell(raw);
}

/**
 * The agent breakdown for the metadata line: "Claude Code" for one session,
 * "Claude Code ×2 · Codex" across several. Ordered by count (desc) then name
 * so unchanged inputs render identically regardless of row arrival order.
 */
function agentBreakdown(rows: LinkedSessionRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const name = agentDisplayName(row.agentType);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(" · ");
}

/**
 * The aggregated metadata line under the verdict: session count (only when
 * more than one — a lone session's count is noise), agent breakdown, summed
 * duration and cost, and a session link (the session itself when there is
 * one; the whole table already links each when there are several, and the
 * footer carries the dashboard doorway either way).
 */
function metadataBlock(rows: LinkedSessionRow[], links: RenderLinks): string {
  const totalMinutes = rows.reduce(
    (sum, row) => sum + durationMinutes(row.startedAt, row.endedAt),
    0,
  );
  // Totals are sums over every linked session, never a per-PR cost claim —
  // a session spanning 3 PRs counts fully in all 3. The label below carries
  // that exact phrase, so a reader never mistakes it for a per-PR
  // attribution.
  const totalCost = rows.reduce((sum, row) => sum + row.costUsd, 0);

  const parts: string[] = [];
  if (rows.length > 1) parts.push(`${rows.length} sessions`);
  parts.push(agentBreakdown(rows));
  parts.push(formatDurationMinutes(totalMinutes));
  parts.push(formatCost(totalCost));
  const only = rows.length === 1 ? rows[0] : undefined;
  if (only) parts.push(`[open session](${sessionDeepLink(links, only)})`);

  const line = parts.join(" · ");
  return rows.length > 1 ? `${line}\n_Totals are sums over linked sessions._` : line;
}

/** A 7-char display prefix for a commit sha. Hex-filtered, not merely
 * escaped: shas reach us from the GitHub API, but a backtick span offers no
 * escaping at all, so anything that isn't hex simply doesn't render. */
function shaDisplay(sha: string): string {
  return sha.replace(/[^0-9a-f]/gi, "").slice(0, SHA_DISPLAY_LENGTH).toLowerCase();
}

/** The "— turn N" / "— turns A → B" suffix for a fact's timeline refs. */
function turnsSuffix(refs: ReadonlyArray<{ turnIndex: number | null }>): string {
  const turns = refs
    .map((ref) => ref.turnIndex)
    .filter((turn): turn is number => turn !== null);
  if (turns.length === 0) return "";
  return ` — ${turns.length === 1 ? `turn ${turns[0]}` : `turns ${turns.join(" → ")}`}`;
}

/**
 * An emitted-result link, made safe for a markdown context. The URL is
 * author-supplied (a CI flag) and lands in a world-readable comment, so
 * only http(s) renders as a link at all, and the characters that would end
 * the `(url)` wrapper or open HTML are percent-encoded.
 */
function safeLinkUrl(link: string): string | null {
  if (!/^https?:\/\//i.test(link)) return null;
  // Explicit percent-encoding: encodeURIComponent leaves `(` and `)`
  // untouched, and an unencoded `)` is exactly the breakout being closed.
  // `\s` covers every whitespace character, newlines above all — a raw
  // newline ends the `(url)` wrapper and lets the remainder of the stored
  // link render as fabricated comment markdown.
  return link.replace(/[()<>`]|\s/g, (char) => {
    const code = char.charCodeAt(0);
    return code <= 0xff
      ? `%${code.toString(16).toUpperCase().padStart(2, "0")}`
      : encodeURIComponent(char);
  });
}

/** The provenance suffix for an emitted-result-backed row: the run link
 * (when its URL is renderable) plus the provenance stamp, mirroring the
 * artifact table's `` `ci` `` labeling. */
function sourceSuffix(source: { provenance: "ci" | "local"; link: string }): string {
  const url = safeLinkUrl(source.link);
  const label = source.provenance === "ci" ? "CI run" : "run";
  return url === null ? ` — \`${source.provenance}\`` : ` — [${label}](${url}) \`${source.provenance}\``;
}

/**
 * A custom validator's row. The sentence is the definition's `row:` copy
 * verbatim — escaped, because it is tenant-authored and this is someone
 * else's repository. Marks: ✓ pass, ⚠ warn-level flag, ℹ info-level flag
 * (visible, never counted), – not checkable. A flag's suffix states the
 * mechanical situation, never a semantic accusation.
 */
function customFactLine(fact: Extract<EvidenceFact, { type: "custom-validation" }>): string {
  const sentence = `**${escapeMarkdownCell(fact.sentence)}**`;
  if (fact.status === "not_checkable") {
    return `– ${sentence} — not checkable for this session`;
  }
  if (fact.status === "pass") {
    const suffix = fact.source !== null ? sourceSuffix(fact.source) : turnsSuffix(fact.refs);
    return `✓ ${sentence}${suffix}`;
  }
  const mark = fact.level === "info" ? "ℹ" : "⚠";
  const suffix =
    fact.source !== null
      ? ` — failed${sourceSuffix(fact.source)}`
      : " — required, not proven this PR";
  return `${mark} ${sentence}${suffix}`;
}

/**
 * One line per stated fact. The fact sentence is the design's copy verbatim
 * — "{k} of {n} commits came from recorded sessions" — and a flagged
 * provenance fact NAMES the unrecorded commits (capped, with the remainder
 * counted) rather than leaving the reviewer to diff the commit list.
 */
function factLine(fact: EvidenceFact): string {
  if ("type" in fact) {
    switch (fact.type) {
      case "custom-validation":
        return customFactLine(fact);
      case "policy-error": {
        const extra =
          fact.additionalProblemCount > 0 ? ` (and ${fact.additionalProblemCount} more)` : "";
        return `⚠ **The policy file has an error** — \`${escapeMarkdownCell(fact.file.replace(/`/g, ""))}\`: ${escapeMarkdownCell(fact.problem)}${extra}`;
      }
      default: {
        const exhaustive: never = fact;
        void exhaustive;
        return "";
      }
    }
  }
  switch (fact.id) {
    case "commits-from-sessions": {
      const sentence = `**${fact.matchedCommitCount} of ${fact.totalCommitCount} commits came from recorded sessions**`;
      if (fact.status === "pass") return `✓ ${sentence}`;
      const named = fact.unrecordedShas.slice(0, MAX_NAMED_UNRECORDED_SHAS).map(
        (sha) => `\`${shaDisplay(sha)}\``,
      );
      const remainder = fact.unrecordedShas.length - named.length;
      const list = remainder > 0 ? `${named.join(", ")} …and ${remainder} more` : named.join(", ");
      return `${fact.level === "info" ? "ℹ" : "⚠"} ${sentence} — unrecorded: ${list}`;
    }
    case "red-then-green":
    case "no-test-tampering": {
      // The sentence is the validator's summary verbatim — the row may only
      // claim what the matcher proved, so no copy is added here. ✕ is
      // reserved for red-class facts (the ones that void the verdict); an
      // info-leveled flag renders ℹ — visible, never counted.
      const mark =
        fact.status === "pass"
          ? "✓"
          : fact.class === "red"
            ? "✕"
            : fact.level === "info"
              ? "ℹ"
              : "⚠";
      return `${mark} **${fact.sentence}**${turnsSuffix(fact.refs)}`;
    }
    default: {
      const exhaustive: never = fact;
      void exhaustive;
      return "";
    }
  }
}

/**
 * The waiting body: candidate links exist but none has confirmed yet, so
 * there is nothing to judge and the comment says so instead of judging on no
 * evidence. Replaced in place — same comment, new body — when a link
 * confirms.
 */
function waitingLine(pendingLinkCount: number): string {
  const noun = pendingLinkCount === 1 ? "session link is" : "session links are";
  return `**⏳ Waiting for session evidence** — ${pendingLinkCount} ${noun} pending confirmation. This comment updates when the session syncs.`;
}

/**
 * Renders the PR evidence comment body from linked-session rows, their topic
 * labels, the link-composition data, and the evidence evaluation. Pure — no
 * I/O.
 *
 * A PR with no candidate session links at all never reaches this function:
 * the orchestrator skips it entirely (a human-only PR gets no comment).
 */
export function renderComment(
  rows: LinkedSessionRow[],
  topics: Map<string, string[]>,
  links: RenderLinks,
  evaluation: EvidenceEvaluation,
  evidence?: RenderEvidence,
): string {
  const evidenceBlock = evidence ? renderEvidence(evidence, links) : null;

  if (evaluation.verdict === "waiting" || rows.length === 0) {
    // No confirmed session to judge. Pending candidates say so; either way
    // artifacts already anchored to the PR (a CI emit needs no session)
    // still surface — evidence is evidence of the PR, not of a session.
    const parts: string[] = [];
    if (evaluation.pendingLinkCount > 0) parts.push(waitingLine(evaluation.pendingLinkCount));
    if (evidenceBlock) parts.push(evidenceBlock);
    parts.push(PR_SESSION_COMMENT_MARKER);
    return parts.join("\n\n");
  }

  // Verdict first, metadata second, facts third — the design's reading
  // order: conclusion, context, evidence.
  const prelude: string[] = [verdictLine(evaluation), metadataBlock(rows, links)];
  const factLines = evaluation.facts.map(factLine).filter((line) => line !== "");
  if (factLines.length > 0) prelude.push(factLines.join("\n"));

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

  // The evidence block is fixed content the session-table fitter must leave
  // room for — evidence links are the exhibits reviewers came for, so the
  // table truncates before evidence ever would.
  const evidenceReservation = evidenceBlock ? evidenceBlock.length + "\n\n".length : 0;
  const fitted = fitTableRows(tableRows, prelude, tableHeader, footer, evidenceReservation);
  const bodyParts = [...prelude];
  if (fitted.rows.length > 0) {
    bodyParts.push(`${tableHeader}\n${fitted.rows.join("\n")}`);
  }
  if (fitted.omitted > 0) {
    const word = fitted.omitted === 1 ? "session" : "sessions";
    bodyParts.push(`_…and ${fitted.omitted} more ${word} — see the dashboard._`);
  }
  if (evidenceBlock) bodyParts.push(evidenceBlock);
  if (footer) bodyParts.push(footer);
  // Last, so it never displaces content a reader sees, and so the fitter's
  // reservation for it (below) is a plain constant.
  bodyParts.push(PR_SESSION_COMMENT_MARKER);
  return bodyParts.join("\n\n");
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

function artifactDeepLink(links: RenderLinks, artifact: PrArtifactRow): string {
  const src = links.sourceTag ?? DEFAULT_SOURCE_TAG;
  return `${links.baseUrl}/orgs/${urlSegment(links.orgName)}/apps/${urlSegment(artifact.appName)}/env/${urlSegment(artifact.envName)}/agents/artifacts/${urlSegment(artifact.id)}?src=${urlSegment(src)}`;
}

/**
 * The one ordering the Artifacts subgroup ever renders in: artifacts bound
 * to a criterion first, then by emit time, ties broken by id. A total order
 * over fields that never change after ingest — re-rendering unchanged
 * records is byte-identical by construction.
 */
function orderArtifacts(artifacts: PrArtifactRow[]): PrArtifactRow[] {
  return [...artifacts].sort((a, b) => {
    const aBound = a.criterionId !== "" ? 0 : 1;
    const bBound = b.criterionId !== "" ? 0 : 1;
    if (aBound !== bBound) return aBound - bBound;
    if (a.emittedAt !== b.emittedAt) return a.emittedAt < b.emittedAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Criterion ids are shape-constrained at ingest and by the spec parser, but
 * the renderer still neutralizes them for a code span: a backtick would end
 * the span early, and `escapeMarkdownCell` covers the rest. */
function criterionSpan(id: string): string {
  return `\`${escapeMarkdownCell(id.replace(/`/g, ""))}\``;
}

function artifactLabel(artifact: PrArtifactRow, links: RenderLinks): string {
  // Kind comes from the server's media-type allowlist, so printing it as the
  // link's prefix is a claim the store can back — never author-supplied.
  const label = `${artifact.kind} · ${escapeMarkdownCell(artifact.filename)}`;
  // Session provenance is the default reading of agent evidence; only the
  // other submission paths get labeled.
  const provenance = artifact.provenance === "session" ? "" : ` \`${artifact.provenance}\``;
  return `[${label}](${artifactDeepLink(links, artifact)})${provenance}`;
}

/**
 * The proof cell for one criterion: its bound artifacts of the required kind
 * as links, or the exact mismatch wording — "video required · screenshot
 * attached" / "video required · none attached". A wrong kind never upgrades:
 * only a kind-matching artifact renders as a link.
 */
function renderProofCell(
  criterion: CriterionRequirement,
  artifacts: PrArtifactRow[],
  links: RenderLinks,
): string {
  const bound = artifacts.filter((a) => a.criterionId === criterion.id);
  const matching = bound.filter((a) => a.kind === criterion.proofKind);
  if (matching.length > 0) {
    return matching.map((a) => artifactLabel(a, links)).join(", ");
  }
  if (bound.length > 0) {
    const attachedKinds = [...new Set(bound.map((a) => a.kind))].sort().join(", ");
    return `${criterion.proofKind} required · ${attachedKinds} attached`;
  }
  return `${criterion.proofKind} required · none attached`;
}

/**
 * The Evidence block: a summary line carrying the artifact count, a Criteria
 * table when the PR's acceptance files declare proof requirements, and an
 * Artifacts table listing each exhibit as a link. Links only — bytes never
 * render inline (no `![`/`<img`); the dashboard page behind the link mints
 * per-viewer expiring blob tokens. Returns null when there is no evidence at
 * all, so a PR without artifacts shows no Evidence section.
 */
function renderEvidence(evidence: RenderEvidence, links: RenderLinks): string | null {
  const artifacts = orderArtifacts(evidence.artifacts);
  const criteria = [...evidence.criteria].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  if (artifacts.length === 0 && criteria.length === 0) return null;

  const parts: string[] = [];
  const artifactWord = artifacts.length === 1 ? "artifact" : "artifacts";
  parts.push(
    artifacts.length > 0
      ? `**Evidence** · ${artifacts.length} ${artifactWord}`
      : `**Evidence**`,
  );

  if (criteria.length > 0) {
    const criteriaHeader = "| Criterion | Proof |\n| --------- | ----- |";
    const criteriaRows = criteria.map(
      (c) => `| ${criterionSpan(c.id)} | ${renderProofCell(c, artifacts, links)} |`,
    );
    parts.push(`${criteriaHeader}\n${criteriaRows.join("\n")}`);
  }

  if (artifacts.length > 0) {
    const shown = artifacts.slice(0, MAX_RENDERED_ARTIFACTS);
    const artifactsHeader = "**Artifacts**\n\n| Artifact | Caption |\n| -------- | ------- |";
    const artifactRows = shown.map((a) => {
      const caption = a.caption.trim() === "" ? "—" : escapeMarkdownCell(a.caption);
      const forSuffix = a.criterionId === "" ? "" : ` · for ${criterionSpan(a.criterionId)}`;
      return `| ${artifactLabel(a, links)} | ${caption}${forSuffix} |`;
    });
    parts.push(`${artifactsHeader}\n${artifactRows.join("\n")}`);
    const omitted = artifacts.length - shown.length;
    if (omitted > 0) {
      const word = omitted === 1 ? "artifact" : "artifacts";
      parts.push(`_…and ${omitted} more ${word} — see the dashboard._`);
    }
  }

  return parts.join("\n\n");
}

/**
 * Fits as many table rows as the GitHub body limit allows, keeping the
 * prelude (verdict, metadata, facts), the table header, the overflow line,
 * and the footer.
 *
 * Over the ceiling the comment degrades to "the most recent N sessions, and
 * a count of the rest" rather than dropping the table entirely — the same
 * ceiling, a far more useful comment than a verdict with no idea which
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
  prelude: string[],
  tableHeader: string,
  footer: string | null,
  extraFixed = 0,
): { rows: string[]; omitted: number } {
  const separators = "\n\n".length;
  const fixed =
    prelude.reduce((sum, part) => sum + part.length + separators, 0) +
    tableHeader.length +
    (footer ? separators + footer.length : 0) +
    // The marker is appended unconditionally by the caller and must be
    // inside the ceiling, not pushed over it by the last row that fits.
    separators +
    PR_SESSION_COMMENT_MARKER.length +
    // Evidence block reservation — see the caller.
    extraFixed;
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
  // table header with it, leaving the verdict, the metadata, the "…and N
  // more" line, and the link: the fallback, reached only where truncating
  // genuinely can't help.
  return { rows: kept, omitted: tableRows.length - kept.length };
}
