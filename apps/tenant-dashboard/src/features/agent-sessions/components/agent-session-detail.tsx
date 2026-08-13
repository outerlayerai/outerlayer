"use client";

/** Agent session detail — the turn/tool timeline with drill-in, tier-aware. */
import { Box, Chip, Divider, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { useState } from "react";
import type { SyntheticEvent } from "react";
import { useParams } from "next/navigation";
import Iconify from "@/components/iconify";
import { PageHeader } from "@/components/page-header";
import { Stack } from "./agent-ui";
import type { AgentSessionDetail as AgentSessionDetailData, AgentSpan, FacetSummary, SessionPrOutcome } from "../types";
import { SessionTimeline } from "./session-timeline";
import { money, shortModel, agentColor, fmtMs } from "./agent-format";
import { parseUserTurn } from "./user-turn";

function StatDot({ status }: { status: string }) {
  const color = status === "2" ? "error.main" : "success.main";
  return <Box component="span" sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: color, display: "inline-block", flex: "none" }} />;
}

/**
 * A display block = one thing the assistant SAID (or the user asked) plus every
 * tool call that followed until the next spoken message. Claude Code records a
 * long file-writing stretch as many tool-only assistant inferences (empty text,
 * one tool each); rendering a header per inference buries the real messages
 * under dozens of contentless "ASSISTANT" rows. Folding tool-only turns under
 * the preceding spoken turn — and summing their cost into it — matches the
 * local transcript: a message, then its tools. `header` is null only for a
 * leading run of tools before anything was said (rare).
 */
interface Block {
  key: string;
  header: AgentSpan | null;
  isUser: boolean;
  costUsd: number;
  tools: AgentSpan[];
}

function buildBlocks(turns: AgentSpan[], toolsByParent: Map<string, AgentSpan[]>): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (const turn of turns) {
    const isUser = turn.name === "agent.turn.user";
    const spoke = isUser || Boolean(turn.output) || Boolean(turn.reasoning);
    const tools = toolsByParent.get(turn.spanId) ?? [];
    if (spoke) {
      cur = { key: turn.spanId, header: turn, isUser, costUsd: turn.cost ?? 0, tools: [...tools] };
      blocks.push(cur);
    } else if (cur) {
      cur.costUsd += turn.cost ?? 0; // fold the inference's cost into the block
      cur.tools.push(...tools);
    } else {
      cur = { key: turn.spanId, header: null, isUser: false, costUsd: turn.cost ?? 0, tools: [...tools] };
      blocks.push(cur);
    }
  }
  return blocks;
}

/**
 * One collapsible tool-call row. The output `<pre>` is mounted only once the
 * row is opened: a big session has ~1000+ tool calls, and rendering every
 * (truncated-but-still-multi-KB) output up front — even hidden inside a closed
 * `<details>` — floods the DOM with text nodes and makes the transcript crawl
 * to first paint. We keep the native `<details>`/`<summary>` (so the disclosure
 * works without JS) and gate the body on the open state via `onToggle`.
 */
function ToolRow({ tc }: { tc: AgentSpan }) {
  const [open, setOpen] = useState(false);
  const name = tc.name.replace("agent.tool.", "");
  const err = tc.statusCode === "2";
  return (
    <Box
      component="details"
      onToggle={(e: SyntheticEvent<HTMLDetailsElement>) => setOpen(e.currentTarget.open)}
      sx={{ mt: 1, border: "1px solid #E4E0D6", borderRadius: 2, bgcolor: "#fff", overflow: "hidden", "&[open] .tsum": { borderBottom: "1px solid #EEEAE0" } }}
    >
      <Box
        component="summary"
        className="tsum"
        sx={{ display: "flex", gap: 1, alignItems: "center", px: 1.5, py: 0.75, bgcolor: "#FBFAF6", cursor: "pointer", listStyle: "none", "&::-webkit-details-marker": { display: "none" } }}
      >
        <StatDot status={tc.statusCode} />
        <Typography sx={{ fontWeight: 600, fontSize: 13 }}>{name}</Typography>
        {tc.metadata.file && (
          <Typography sx={{ fontFamily: "monospace", fontSize: 11, color: "text.secondary" }} noWrap>{tc.metadata.file}</Typography>
        )}
        {err ? (
          <Typography sx={{ fontSize: 11, color: "error.main", ml: "auto" }} noWrap title={tc.statusMessage ?? ""}>{tc.statusMessage?.slice(0, 80)}</Typography>
        ) : (
          <Typography sx={{ fontSize: 10.5, color: "text.disabled", ml: "auto", fontFamily: "monospace" }}>{tc.output ? "▸ output" : ""}</Typography>
        )}
      </Box>
      {open && tc.output && (
        <Typography component="pre" sx={{ m: 0, px: 1.5, py: 1, fontFamily: "monospace", fontSize: 11.5, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 320, overflow: "auto" }}>
          {tc.output.slice(0, 4000)}
        </Typography>
      )}
    </Box>
  );
}

/**
 * A slash command the developer ran, as a compact command line rather than the
 * four XML tags the transcript records it as. Output is collapsed: `/context`
 * and friends print screens of text that would otherwise bury the conversation.
 */
function CommandBlock({ command, args, stdout }: { command: string; args: string; stdout: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Box sx={{ border: "1px solid #E4E0D6", borderRadius: 2, bgcolor: "#FBFAF6", overflow: "hidden" }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 1.5, py: 0.75 }}>
        <Iconify icon="eva:corner-down-right-fill" width={13} sx={{ color: "text.disabled", flex: "none" }} />
        <Typography sx={{ fontFamily: "monospace", fontSize: 12.5, fontWeight: 600 }}>{command}</Typography>
        {args && (
          <Typography sx={{ fontFamily: "monospace", fontSize: 12.5, color: "text.secondary" }} noWrap>
            {args}
          </Typography>
        )}
        {stdout && (
          <Typography
            component="button"
            onClick={() => setOpen((v) => !v)}
            sx={{ ml: "auto", fontFamily: "monospace", fontSize: 10.5, color: "text.secondary", background: "none", border: 0, cursor: "pointer", p: 0 }}
          >
            {open ? "▾ output" : "▸ output"}
          </Typography>
        )}
      </Stack>
      {open && stdout && (
        <Typography
          component="pre"
          sx={{ m: 0, px: 1.5, py: 1, borderTop: "1px solid #EEEAE0", bgcolor: "#fff", fontFamily: "monospace", fontSize: 11.5, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 320, overflow: "auto" }}
        >
          {stdout.slice(0, 4000)}
        </Typography>
      )}
    </Box>
  );
}

/**
 * One pasted image. The URL carries a signed token that expires, so a
 * transcript left open long enough can outlive its own image links. A broken
 * -image icon would read as "the screenshot is gone" when the fix is a
 * reload — say what actually happened instead.
 */
function TranscriptImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <Box
        sx={{
          width: 200, height: 120, borderRadius: 2, border: "1px dashed #E4E0D6", bgcolor: "#fff",
          display: "flex", alignItems: "center", justifyContent: "center", p: 1.5, textAlign: "center",
        }}
      >
        <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
          Image link expired — reload to view
        </Typography>
      </Box>
    );
  }
  return (
    <Box
      component="img"
      src={src}
      alt="pasted image"
      loading="lazy"
      onError={() => setFailed(true)}
      sx={{ maxWidth: 320, maxHeight: 320, borderRadius: 2, border: "1px solid #E4E0D6", objectFit: "contain", bgcolor: "#fff" }}
    />
  );
}

function TurnBlock({ block, appId, orgName }: { block: Block; appId: string; orgName: string }) {
  const { header, isUser, tools } = block;
  const role = isUser ? "user" : "assistant";
  // A user turn's text shares a channel with harness markup; split them so the
  // bubble holds words and the command renders as a command.
  const userView = isUser && header ? parseUserTurn(header.input) : null;
  // A turn that was nothing but harness boilerplate carries no tool calls
  // either — dropping it removes a row, not information.
  if (userView?.empty && tools.length === 0 && !header?.images?.length) return null;
  return (
    <Box sx={{ mb: header ? 2 : 0.5 }}>
      {header && (
        <Stack direction="row" spacing={1} alignItems="baseline" sx={{ mb: 0.5 }}>
          <Typography sx={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".07em", color: isUser ? "text.secondary" : "primary.main", fontWeight: 600 }}>
            {role}
            {header.model ? ` · ${shortModel(header.model)}` : ""}
          </Typography>
          {block.costUsd > 0 && (
            <Typography sx={{ fontFamily: "monospace", fontSize: 11, color: "text.secondary" }}>{money(block.costUsd)}</Typography>
          )}
        </Stack>
      )}
      {header?.reasoning && (
        <Box sx={{ borderLeft: "2px solid #7A5EA8", pl: 1.5, mb: 1 }}>
          <Typography sx={{ fontSize: 12.5, color: "#5E4A98", whiteSpace: "pre-wrap", fontStyle: "italic" }}>
            {header.reasoning.slice(0, 800)}
          </Typography>
        </Box>
      )}
      {userView && (userView.command || userView.stdout) && (
        <CommandBlock command={userView.command || "(command)"} args={userView.commandArgs} stdout={userView.stdout} />
      )}
      {header && (userView ? userView.text : header.output) && (
        <Box
          sx={{
            bgcolor: isUser ? "#fff" : "transparent",
            border: isUser ? "1px solid #E4E0D6" : 0,
            borderLeft: isUser ? "1px solid #E4E0D6" : "2px solid #2065D1",
            borderRadius: isUser ? 2 : 0,
            p: isUser ? 1.5 : "2px 0 2px 14px",
            ...(userView?.command || userView?.stdout ? { mt: 1 } : {}),
          }}
        >
          <Typography sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 14 }}>
            {(userView ? userView.text : header.output)?.slice(0, 4000)}
          </Typography>
        </Box>
      )}
      {header?.images && header.images.length > 0 && (
        <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: "wrap" }}>
          {header.images.map((img) => (
            <TranscriptImage
              key={img.sha256}
              // The blob route is tenant+app scoped — appId is both the path
              // segment (canonical URL) and the required query param withApi
              // authorizes against. `token` is the per-caller, expiring
              // capability the route verifies before it reads any bytes; the
              // hash alone opens nothing.
              src={`/api/orgs/${orgName}/apps/${appId}/agents/blob/${img.sha256}?appId=${appId}&token=${encodeURIComponent(img.token)}`}
            />
          ))}
        </Stack>
      )}
      {tools.map((tc) => (
        <ToolRow key={tc.spanId} tc={tc} />
      ))}
    </Box>
  );
}

/**
 * The hook rollup + honesty caption. The rollup line always renders, even at
 * zero runs — Claude Code's transcript records only Stop-hook executions, so
 * an empty count here does not mean no hooks ran; it means none of the hooks
 * that DID run were Stop hooks. The caption itself is conditional: a session
 * carrying a wrapped Pre/PostToolUse execution (`agent.hook.pre_tool_use` /
 * `agent.hook.post_tool_use` spans) DOES have that timing, so the "Stop hooks
 * only" disclaimer would be false for it.
 */
function HookRollup({
  session,
  hasWrappedHookEvents,
}: {
  session: AgentSessionDetailData["session"];
  hasWrappedHookEvents: boolean;
}) {
  const { hookExecutionCount, hookDurationMs, hookUnreportedCount, slowestHookMs, slowestHookCommand } = session;
  const timedCount = hookExecutionCount - hookUnreportedCount;
  const parts = [`${hookExecutionCount} runs`];
  if (hookExecutionCount > 0) {
    // A duration total is only meaningful once at least one hook reported
    // one — an all-unreported session must never render "0ms total", the
    // exact fabricated zero this rollup exists to avoid. When some but not
    // all reported, say so, so the total doesn't silently imply full coverage.
    if (timedCount > 0) {
      parts.push(timedCount < hookExecutionCount ? `${fmtMs(hookDurationMs)} total (${timedCount} timed)` : `${fmtMs(hookDurationMs)} total`);
    } else {
      parts.push("no timing reported");
    }
  }
  // Gate on timedCount, not on slowestHookCommand — a real slowest duration
  // can arrive with no command string (parser cap, malformed entry, etc.);
  // the number is the point of this chip, so it must never disappear just
  // because the command happened to be empty.
  if (timedCount > 0) parts.push(`slowest: ${slowestHookCommand || "(unknown command)"} ${fmtMs(slowestHookMs)}`);
  return (
    <Box sx={{ mb: 3 }}>
      <Typography sx={{ fontFamily: "monospace", fontSize: 12.5, color: "text.secondary" }} data-testid="hook-rollup">
        hooks: {parts.join(" · ")}
      </Typography>
      {!hasWrappedHookEvents && (
        <Typography sx={{ fontSize: 11, color: "text.disabled", mt: 0.25 }} data-testid="hook-caption">
          Stop hooks only. The agent transcript does not record PreToolUse/PostToolUse hook timing; an empty list does not mean no hooks ran.
        </Typography>
      )}
    </Box>
  );
}

/** One outcome fact as a compact monospace chip. `good`/`bad`/`neutral` maps to
 * the same success/error/muted palette the rest of this surface uses. */
function OutcomeChip({ label, tone }: { label: string; tone: "good" | "bad" | "neutral" }) {
  const color =
    tone === "good" ? "success.main" : tone === "bad" ? "error.main" : "text.secondary";
  return (
    <Chip
      label={label}
      size="small"
      variant="outlined"
      sx={{ height: 20, fontFamily: "monospace", fontSize: 10.5, color, borderColor: color }}
    />
  );
}

/** Per-PR outcome chips for one PR the session produced. */
function PrOutcomeRow({ pr }: { pr: SessionPrOutcome }) {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: "wrap" }}>
      {pr.prUrl ? (
        <Typography
          component="a"
          href={pr.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          sx={{ fontFamily: "monospace", fontSize: 12, color: "info.main", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 0.25, "&:hover": { textDecoration: "underline" } }}
        >
          PR #{pr.prNumber}
          <Iconify icon="eva:external-link-outline" width={13} sx={{ opacity: 0.7 }} />
        </Typography>
      ) : (
        <Typography sx={{ fontFamily: "monospace", fontSize: 12, color: "text.secondary" }} title="No PR link captured">
          PR #{pr.prNumber}
        </Typography>
      )}
      {pr.ciGreen && (
        <OutcomeChip
          // First-pass CI: passing is good; a first-run failure is NOT
          // necessarily bad (it's often fixed and merged anyway), so it's
          // neutral, not an error.
          label={pr.ciGreen.score >= 1 ? "CI passed first try" : "CI failed first try"}
          tone={pr.ciGreen.score >= 1 ? "good" : "neutral"}
        />
      )}
      {pr.merged && (
        <OutcomeChip
          label={pr.merged.score >= 1 ? "Merged" : "Closed unmerged"}
          tone={pr.merged.score >= 1 ? "good" : "bad"}
        />
      )}
      {/* Only surface durability when it went WRONG. "Merged and not reverted"
       * is the expected case for nearly every merged PR, so a chip for it is
       * noise; the absence of a revert chip already says the work held. */}
      {pr.reverted && pr.reverted.score >= 1 && <OutcomeChip label="Reverted" tone="bad" />}
    </Stack>
  );
}

/** The session's PR-outcome strip: what happened to the PR(s) this session
 * produced. Renders nothing when the session touched no scored PR — most
 * sessions won't, and an empty box on every one of them would be noise. */
function SessionOutcomeStrip({ prs }: { prs: SessionPrOutcome[] }) {
  if (prs.length === 0) return null;
  return (
    <Box sx={{ mb: 3 }}>
      <Typography sx={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", color: "text.secondary", mb: 1 }}>
        pr outcomes
      </Typography>
      <Stack spacing={1}>
        {prs.map((pr) => (
          <PrOutcomeRow key={pr.prNumber} pr={pr} />
        ))}
      </Stack>
    </Box>
  );
}

/** Display labels for the built-in facet keys; an unrecognized (custom) key
 * falls back to itself title-cased. */
const FACET_LABELS: Record<string, string> = {
  task: "Task",
  sentiment: "Sentiment",
  issues: "Issues",
  steering: "Steering",
};

function facetLabel(facet: string): string {
  return FACET_LABELS[facet] ?? facet.charAt(0).toUpperCase() + facet.slice(1);
}

/** The session's facet-classification summaries — one row per enabled facet.
 * Renders nothing when the trace carries none (Topics disabled for the app,
 * or the pipeline hasn't classified this trace yet) — most sessions predate
 * Topics or belong to an app that never turned it on, so an empty box on
 * every one of them would be noise. */
function FacetSummaryStrip({ facets }: { facets: FacetSummary[] }) {
  if (facets.length === 0) return null;
  return (
    <Box sx={{ mb: 3 }} data-testid="facet-summaries">
      <Typography sx={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", color: "text.secondary", mb: 1 }}>
        facet summaries
      </Typography>
      <Stack spacing={0.75}>
        {facets.map((f) => (
          <Stack key={f.facet} direction="row" spacing={1} alignItems="baseline">
            <Typography sx={{ fontFamily: "monospace", fontSize: 11, color: "text.secondary", flex: "0 0 auto", width: 80 }}>
              {facetLabel(f.facet)}
            </Typography>
            <Typography sx={{ fontSize: 13 }}>{f.summary}</Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

export function AgentSessionDetail({
  appId,
  data,
}: {
  appId: string;
  data: AgentSessionDetailData;
}) {
  const [view, setView] = useState<"transcript" | "timeline">("transcript");
  const { orgName } = useParams<{ orgName: string }>();

  const { session, spans, prOutcomes, facetSummaries } = data;
  const turns = spans.filter((s) => s.name.startsWith("agent.turn."));
  // A wrapped Pre/PostToolUse hook is the only source of these two span
  // names — a transcript-derived Stop hook always names its span
  // agent.hook.stop, never these.
  const hasWrappedHookEvents = spans.some(
    (s) => s.name === "agent.hook.pre_tool_use" || s.name === "agent.hook.post_tool_use",
  );
  const toolsByParent = new Map<string, AgentSpan[]>();
  for (const s of spans.filter((x) => x.name.startsWith("agent.tool."))) {
    if (!s.parentSpanId) continue;
    (toolsByParent.get(s.parentSpanId) ?? toolsByParent.set(s.parentSpanId, []).get(s.parentSpanId)!).push(s);
  }

  return (
    // width:100% is required. Without an explicit width this box
    // shrink-wraps: the Transcript (full-width message blocks) fills the row,
    // but the Timeline — fixed label/preview/duration columns plus a flexGrow
    // bar track — has a small max-content width and collapses to a narrow
    // column (the track has no definite parent width to grow into). Pinning
    // 100% makes both tabs render on the same track so the gantt spans the row.
    <Box sx={{ width: "100%" }}>
      <PageHeader
        title={session.title || "session"}
        // The header renders its caption inside a `<p>`, so every node here is
        // an inline element — a Chip's default `div` would be invalid nesting.
        caption={
          <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 1.5, flexWrap: "wrap" }}>
            <Chip
              component="span"
              label={session.agentType}
              size="small"
              sx={{ height: 20, fontFamily: "monospace", fontSize: 10.5, bgcolor: `${agentColor(session.agentType)}18`, color: agentColor(session.agentType) }}
            />
            <Box component="span" sx={{ fontFamily: "monospace" }}>
              {session.actorName ?? session.actorId} · {session.project ?? ""} · tier {session.captureTier}
            </Box>
          </Box>
        }
      />

      <Stack direction="row" spacing={3} sx={{ mb: 3, flexWrap: "wrap", rowGap: 1.5 }}>
        {[
          // `money(null)` renders "—": the transcript carries token counts but
          // never a cost, so every dollar here is computed against a model price
          // map. A model that map doesn't know yields no cost at all, and that
          // is what "—" means — not that the session was free.
          ["cost", money(session.costUsd), session.costUsd == null ? "No price for this session's model(s) at capture time" : ""],
          ["turns", String(session.turnCount), ""],
          ["tool calls", String(session.toolCallCount), ""],
          ["tool errors", String(session.errorCount), ""],
          // Trajectory signals — how the session RAN, named by observable
          // event: a follow-up is ANY human turn beyond the initial ask (a
          // correction, an answer, or a new task — the counter can't tell,
          // so the label doesn't claim to). The error rate matches the list
          // and fleet definition (errors ÷ tool calls).
          ["follow-ups", String(Math.max(session.userTurnCount - 1, 0)), ""],
          ["denials", String(session.rejectedToolCallCount), ""],
          [
            "provider errors",
            String(session.apiErrorCount),
            "Provider failures the transcript recorded mid-session (rate limit, overload, dropped connection).",
          ],
          [
            "err rate",
            session.toolCallCount > 0 ? `${Math.round((session.errorCount / session.toolCallCount) * 100)}%` : "—",
            "",
          ],
        ].map(([k, v, hint]) => (
          <Box key={k} {...(hint ? { title: hint } : {})}>
            <Typography sx={{ fontFamily: "monospace", fontSize: 18, fontWeight: 600 }}>{v}</Typography>
            <Typography sx={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", color: "text.secondary" }}>{k}</Typography>
          </Box>
        ))}
      </Stack>

      {session.editRetryLoop && (
        <Box sx={{ mb: 3 }}>
          <Chip
            size="small"
            variant="outlined"
            data-testid="edit-retry-loop-chip"
            label={`edit loop · ${session.editRetryLoop.fails}× on ${session.editRetryLoop.file.split(/[/\\]/).pop()}`}
            title={`${session.editRetryLoop.fails} consecutive failed edits to ${session.editRetryLoop.file} — likely a stale edit anchor`}
            sx={{ height: 22, fontFamily: "monospace", fontSize: 11, color: "warning.main", borderColor: "warning.main" }}
          />
        </Box>
      )}

      <HookRollup session={session} hasWrappedHookEvents={hasWrappedHookEvents} />

      <SessionOutcomeStrip prs={prOutcomes} />

      <FacetSummaryStrip facets={facetSummaries} />

      <ToggleButtonGroup
        exclusive
        size="small"
        value={view}
        onChange={(_e, v: "transcript" | "timeline" | null) => v && setView(v)}
        sx={{ mb: 2, "& .MuiToggleButton-root": { textTransform: "none", fontFamily: "monospace", fontSize: 12, py: 0.4, px: 1.5 } }}
      >
        <ToggleButton value="transcript">Transcript</ToggleButton>
        <ToggleButton value="timeline">Timeline</ToggleButton>
      </ToggleButtonGroup>
      <Divider sx={{ mb: 2 }} />

      {view === "timeline" ? (
        <SessionTimeline spans={spans} agentType={session.agentType} />
      ) : (
        buildBlocks(turns, toolsByParent).map((block) => (
          <TurnBlock key={block.key} block={block} appId={appId} orgName={orgName} />
        ))
      )}
    </Box>
  );
}
