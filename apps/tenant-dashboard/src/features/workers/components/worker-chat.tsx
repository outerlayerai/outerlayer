"use client";

/**
 * Chat-style rendering for a worker run's transcript.
 *
 * The normalized event stream (agent-message / tool-use / file-change /
 * status / result / error) is folded into a conversation: agent prose renders
 * as chat messages, consecutive tool activity collapses into a compact step
 * list, and a live run shows a typing indicator — the same shape as any
 * mainstream AI chat interface.
 */

import { useEffect, useRef } from "react";
import { Avatar, Box, Chip, Stack, Typography } from "@mui/material";
import Iconify from "@/components/iconify";
import type { WorkerRunAttachmentMeta, WorkerRunEvent } from "../hooks";

type ChatStep = { key: string; icon: string; text: string };

type ChatItem =
  | { kind: "text"; key: string; text: string }
  | { kind: "steps"; key: string; steps: ChatStep[] }
  | { kind: "error"; key: string; text: string };

/**
 * The runner reports workspace-absolute paths — an ephemeral clone
 * (/tmp/worker-<run>-x/src/a.ts) or a persistent workspace
 * (/tmp/outerlayer-worker-env/<env-id>/src/a.ts). Strip the workspace prefix
 * so steps read as repo-relative.
 */
function stripWorkspacePrefix(text: string): string {
  return text
    .replace(/\/[^\s"']*\/outerlayer-worker-env\/[^/\s]+\//g, "")
    .replace(/\/[^\s"']*\/worker-[^/\s]+\//g, "");
}

function stepFromEvent(event: WorkerRunEvent): ChatStep | null {
  const p = event.payload;
  const key = `step-${event.seq}`;
  switch (event.event_type) {
    case "tool-use": {
      const tool = String(p.tool ?? "tool");
      const summary = stripWorkspacePrefix(String(p.summary ?? ""));
      return { key, icon: "eva:flash-outline", text: summary ? `${tool} · ${summary}` : tool };
    }
    case "file-change":
      return {
        key,
        icon: "eva:file-text-outline",
        text: `Edited ${stripWorkspacePrefix(String(p.path ?? ""))}`,
      };
    case "status":
      return { key, icon: "eva:activity-outline", text: String(p.phase ?? "status") };
    default:
      return null;
  }
}

/**
 * Fold the raw transcript into chat items: agent prose stays a message,
 * consecutive tool/file/status events group into one step block, errors
 * break out on their own. Result events with text render as the agent's
 * closing message; empty ones are dropped (the run header carries the outcome).
 */
export function eventsToChatItems(events: WorkerRunEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  let steps: ChatStep[] = [];

  const flushSteps = () => {
    if (steps.length > 0) {
      items.push({ kind: "steps", key: steps[0]!.key, steps });
      steps = [];
    }
  };

  const lastText = () => {
    const last = items[items.length - 1];
    return last?.kind === "text" ? last.text : null;
  };

  for (const event of events) {
    const step = stepFromEvent(event);
    if (step) {
      // Agents emit repeated status lines (e.g. agent-launched twice) —
      // collapse consecutive identical steps.
      if (steps[steps.length - 1]?.text !== step.text) steps.push(step);
      continue;
    }
    if (event.event_type === "agent-message") {
      const text = String(event.payload.text ?? "").trim();
      if (!text) continue;
      flushSteps();
      items.push({ kind: "text", key: `text-${event.seq}`, text });
    } else if (event.event_type === "error") {
      flushSteps();
      items.push({
        kind: "error",
        key: `error-${event.seq}`,
        text: String(event.payload.message ?? "error"),
      });
    } else if (event.event_type === "result") {
      const text = String(event.payload.result ?? "").trim();
      // The terminal result usually repeats the agent's final message — only
      // render it when it adds something new.
      if (!text || text === "done" || text === lastText()) continue;
      flushSteps();
      items.push({ kind: "text", key: `result-${event.seq}`, text });
    }
  }
  flushSteps();
  return items;
}

/** The user's side of the exchange: a right-aligned bubble (+ attachment chips). */
export function UserChatMessage({
  text,
  attachments,
}: {
  text: string;
  attachments?: WorkerRunAttachmentMeta[];
}) {
  return (
    <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
      <Box
        sx={{
          maxWidth: "85%",
          bgcolor: "background.neutral",
          borderRadius: 2.5,
          px: 2,
          py: 1.25,
        }}
      >
        {attachments && attachments.length > 0 && (
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75, mb: text ? 1 : 0 }}>
            {attachments.map((attachment, index) => (
              <Chip
                key={`${attachment.name}-${index}`}
                size="small"
                variant="outlined"
                icon={
                  <Iconify
                    icon={
                      attachment.mime.startsWith("image/")
                        ? "eva:image-outline"
                        : "eva:file-text-outline"
                    }
                    width={16}
                  />
                }
                label={attachment.name}
                sx={{ maxWidth: 260 }}
              />
            ))}
          </Box>
        )}
        <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {text}
        </Typography>
      </Box>
    </Box>
  );
}

export function AgentAvatar() {
  return (
    <Avatar sx={{ width: 28, height: 28, bgcolor: "primary.lighter", color: "primary.main" }}>
      <Iconify icon="mdi:robot-outline" width={16} />
    </Avatar>
  );
}

/** Three pulsing dots — the agent is working. */
function ThinkingDots() {
  return (
    <Box
      data-testid="thinking-dots"
      sx={{
        display: "flex",
        gap: 0.5,
        py: 0.75,
        "@keyframes workerThinking": {
          "0%, 80%, 100%": { opacity: 0.25 },
          "40%": { opacity: 1 },
        },
        "& > span": {
          width: 6,
          height: 6,
          borderRadius: "50%",
          bgcolor: "text.secondary",
          animation: "workerThinking 1.2s infinite ease-in-out",
        },
        "& > span:nth-of-type(2)": { animationDelay: "0.2s" },
        "& > span:nth-of-type(3)": { animationDelay: "0.4s" },
      }}
    >
      <span />
      <span />
      <span />
    </Box>
  );
}

function StepBlock({ steps }: { steps: ChatStep[] }) {
  return (
    <Box sx={{ borderLeft: 2, borderColor: "divider", pl: 1.5, py: 0.25 }}>
      <Stack spacing={0.5}>
        {steps.map((step) => (
          <Box key={step.key} sx={{ display: "flex", alignItems: "flex-start", gap: 0.75 }}>
            <Iconify icon={step.icon} width={14} sx={{ mt: "3px", color: "text.disabled", flexShrink: 0 }} />
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
                fontFamily: "monospace",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {step.text}
            </Typography>
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

/**
 * The agent's side of the exchange: one avatar for the whole response,
 * transcript items stacked beside it, typing indicator while live.
 */
export function AgentActivity({ events, live }: { events: WorkerRunEvent[]; live: boolean }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const items = eventsToChatItems(events);

  useEffect(() => {
    if (live && events.length > 0 && typeof bottomRef.current?.scrollIntoView === "function") {
      bottomRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [events.length, live]);

  return (
    <Box sx={{ display: "flex", gap: 1.5, alignItems: "flex-start" }}>
      <AgentAvatar />
      <Stack spacing={1.5} sx={{ flexGrow: 1, minWidth: 0, pt: 0.5 }}>
        {items.map((item) => {
          if (item.kind === "text") {
            return (
              <Typography
                key={item.key}
                variant="body2"
                sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
              >
                {item.text}
              </Typography>
            );
          }
          if (item.kind === "steps") {
            return <StepBlock key={item.key} steps={item.steps} />;
          }
          return (
            <Typography
              key={item.key}
              variant="body2"
              sx={{ color: "error.main", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
            >
              {item.text}
            </Typography>
          );
        })}
        {live && <ThinkingDots />}
        {!live && items.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No activity was recorded for this run.
          </Typography>
        )}
        <div ref={bottomRef} />
      </Stack>
    </Box>
  );
}
