// @vitest-environment jsdom
/**
 * Chat rendering for worker transcripts: eventsToChatItems folds the raw
 * normalized event stream into conversation items (prose / grouped tool steps /
 * errors), and the components render user bubbles, agent activity, and the
 * live typing indicator.
 */
import React from "react";
import { render, screen } from "@testing-library/react";

import { AgentActivity, UserChatMessage, eventsToChatItems } from "../worker-chat";
import type { WorkerRunEvent } from "../../hooks";

function evt(seq: number, event_type: string, payload: Record<string, unknown>): WorkerRunEvent {
  return { seq, event_type, payload, created_at: "2026-07-12T00:00:00Z" };
}

describe("eventsToChatItems", () => {
  it("groups consecutive tool/file/status events into one step block between prose", () => {
    const items = eventsToChatItems([
      evt(0, "status", { phase: "cloning" }),
      evt(1, "agent-message", { text: "Let me look at the repo." }),
      evt(2, "tool-use", { tool: "Read", summary: "package.json" }),
      evt(3, "file-change", { path: "src/version.ts" }),
      evt(4, "agent-message", { text: "Done." }),
    ]);
    expect(items).toEqual([
      { kind: "steps", key: "step-0", steps: [{ key: "step-0", icon: "eva:activity-outline", text: "cloning" }] },
      { kind: "text", key: "text-1", text: "Let me look at the repo." },
      {
        kind: "steps",
        key: "step-2",
        steps: [
          { key: "step-2", icon: "eva:flash-outline", text: "Read · package.json" },
          { key: "step-3", icon: "eva:file-text-outline", text: "Edited src/version.ts" },
        ],
      },
      { kind: "text", key: "text-4", text: "Done." },
    ]);
  });

  it("renders a tool step without a summary as just the tool name", () => {
    const items = eventsToChatItems([evt(0, "tool-use", { tool: "Bash" })]);
    expect(items).toEqual([
      { kind: "steps", key: "step-0", steps: [{ key: "step-0", icon: "eva:flash-outline", text: "Bash" }] },
    ]);
  });

  it("drops empty agent messages and 'done' results, keeps a real closing result", () => {
    expect(
      eventsToChatItems([
        evt(0, "agent-message", { text: "   " }),
        evt(1, "result", { result: "done" }),
        evt(2, "result", { result: "Added the endpoint." }),
      ]),
    ).toEqual([{ kind: "text", key: "result-2", text: "Added the endpoint." }]);
  });

  it("drops a result that just repeats the agent's final message", () => {
    expect(
      eventsToChatItems([
        evt(0, "agent-message", { text: "Created the file." }),
        evt(1, "result", { result: "Created the file." }),
      ]),
    ).toEqual([{ kind: "text", key: "text-0", text: "Created the file." }]);
  });

  it("collapses consecutive duplicate status steps (agent-launched twice)", () => {
    expect(
      eventsToChatItems([
        evt(0, "status", { phase: "agent-launched" }),
        evt(1, "status", { phase: "agent-launched" }),
        evt(2, "status", { phase: "collecting-diff" }),
      ]),
    ).toEqual([
      {
        kind: "steps",
        key: "step-0",
        steps: [
          { key: "step-0", icon: "eva:activity-outline", text: "agent-launched" },
          { key: "step-2", icon: "eva:activity-outline", text: "collecting-diff" },
        ],
      },
    ]);
  });

  it("strips ephemeral and persistent workspace prefixes from tool and file paths", () => {
    expect(
      eventsToChatItems([
        evt(0, "tool-use", {
          tool: "Write",
          summary: "Write /var/folders/x/T/worker-3f930676-4X9gTS/src/greeting.ts",
        }),
        evt(1, "file-change", { path: "/var/folders/x/T/worker-3f930676-4X9gTS/src/greeting.ts" }),
        evt(2, "file-change", {
          path: "/var/folders/x/T/outerlayer-worker-env/34eb454c-a0c1/src/animals.ts",
        }),
      ]),
    ).toEqual([
      {
        kind: "steps",
        key: "step-0",
        steps: [
          { key: "step-0", icon: "eva:flash-outline", text: "Write · Write src/greeting.ts" },
          { key: "step-1", icon: "eva:file-text-outline", text: "Edited src/greeting.ts" },
          { key: "step-2", icon: "eva:file-text-outline", text: "Edited src/animals.ts" },
        ],
      },
    ]);
  });

  it("breaks errors out of a step group in order", () => {
    const items = eventsToChatItems([
      evt(0, "tool-use", { tool: "Bash", summary: "npm test" }),
      evt(1, "error", { message: "exit 1" }),
    ]);
    expect(items).toEqual([
      { kind: "steps", key: "step-0", steps: [{ key: "step-0", icon: "eva:flash-outline", text: "Bash · npm test" }] },
      { kind: "error", key: "error-1", text: "exit 1" },
    ]);
  });

  it("ignores unknown event types entirely", () => {
    expect(eventsToChatItems([evt(0, "heartbeat", {})])).toEqual([]);
  });
});

describe("UserChatMessage", () => {
  it("renders the prompt text", () => {
    render(<UserChatMessage text="Add a /version endpoint" />);
    expect(screen.getByText("Add a /version endpoint")).toBeInTheDocument();
  });

  it("renders one chip per attachment alongside the prompt", () => {
    render(
      <UserChatMessage
        text="Match this mock"
        attachments={[
          { name: "mock.png", mime: "image/png", size_bytes: 1024 },
          { name: "spec.pdf", mime: "application/pdf", size_bytes: 2048 },
        ]}
      />,
    );
    expect(screen.getByText("Match this mock")).toBeInTheDocument();
    expect(screen.getByText("mock.png")).toBeInTheDocument();
    expect(screen.getByText("spec.pdf")).toBeInTheDocument();
  });

  it("renders no chips when the run has no attachments", () => {
    const { container } = render(<UserChatMessage text="plain" attachments={[]} />);
    expect(container.querySelectorAll(".MuiChip-root")).toHaveLength(0);
  });
});

describe("AgentActivity", () => {
  it("renders prose, steps, and errors from the transcript", () => {
    render(
      <AgentActivity
        live={false}
        events={[
          evt(0, "agent-message", { text: "Working on it." }),
          evt(1, "tool-use", { tool: "Write", summary: "src/version.ts" }),
          evt(2, "error", { message: "lint failed" }),
        ]}
      />,
    );
    expect(screen.getByText("Working on it.")).toBeInTheDocument();
    expect(screen.getByText("Write · src/version.ts")).toBeInTheDocument();
    expect(screen.getByText("lint failed")).toBeInTheDocument();
    expect(screen.queryByTestId("thinking-dots")).toBeNull();
  });

  it("shows the typing indicator while live and hides the empty-run note", () => {
    render(<AgentActivity live events={[]} />);
    expect(screen.getByTestId("thinking-dots")).toBeInTheDocument();
    expect(screen.queryByText("No activity was recorded for this run.")).toBeNull();
  });

  it("shows the empty note for a finished run with no items", () => {
    render(<AgentActivity live={false} events={[]} />);
    expect(screen.getByText("No activity was recorded for this run.")).toBeInTheDocument();
    expect(screen.queryByTestId("thinking-dots")).toBeNull();
  });
});
