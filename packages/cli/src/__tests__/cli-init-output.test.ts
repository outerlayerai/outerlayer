// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it } from "vitest";
import { formatInitOutput } from "../cli.js";
import type { InitResult } from "../init.js";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const EPILOGUE =
  "\nSessions sync to your OuterLayer app with full content: prompts, agent\n" +
  "messages, thinking, tool inputs/outputs, file paths, repo and branch\n" +
  "names, models, token counts, and costs.\n" +
  "\n" +
  "Secrets are scrubbed before upload — API keys, tokens, and private keys\n" +
  `are replaced with [REDACTED:<type>] on your machine, always. This\n` +
  "cannot be disabled.\n" +
  "\n" +
  `Nothing syncs until you run ${YELLOW}outerlayer sync${RESET} (after that, sessions\n` +
  "sync automatically in the background).\n" +
  `\nNext: run ${YELLOW}outerlayer scan${RESET} to see your first insights.\n`;

function baseResult(overrides: Partial<InitResult> = {}): InitResult {
  return {
    path: "/home/dev/.claude/settings.json",
    changed: true,
    events: ["SessionStart", "SessionEnd", "Stop"],
    wrapped: [],
    ...overrides,
  };
}

describe("formatInitOutput — remove path", () => {
  it("changed removal without a backup: removed line only, no backup mention", () => {
    const out = formatInitOutput(baseResult({ removed: true, changed: true }));
    expect(out).toBe(`${GREEN}✓${RESET} Removed OuterLayer hooks from /home/dev/.claude/settings.json\n`);
  });

  it("changed removal WITH a backup path names it", () => {
    const out = formatInitOutput(baseResult({ removed: true, changed: true, backupPath: "/home/dev/.claude/settings.json.bak-1" }));
    expect(out).toBe(
      `${GREEN}✓${RESET} Removed OuterLayer hooks from /home/dev/.claude/settings.json\n${DIM}  backup: /home/dev/.claude/settings.json.bak-1${RESET}\n`,
    );
  });

  it("unchanged removal (nothing to remove) uses the dim no-op line, stops there", () => {
    const out = formatInitOutput(baseResult({ removed: true, changed: false }));
    expect(out).toBe(`${DIM}No OuterLayer hooks to remove in /home/dev/.claude/settings.json${RESET}\n`);
  });

  it("a restored wrapped status line appends the restore line after the removal line", () => {
    const out = formatInitOutput(baseResult({ removed: true, changed: true, statuslineWrappedCommand: "my-status.sh --flag" }));
    expect(out).toBe(
      `${GREEN}✓${RESET} Removed OuterLayer hooks from /home/dev/.claude/settings.json\n` +
        `${GREEN}✓${RESET} Restored status line to: ${DIM}my-status.sh --flag${RESET}\n`,
    );
  });

  it("no statuslineWrappedCommand means no restore line — and the epilogue never appears on the remove path", () => {
    const out = formatInitOutput(baseResult({ removed: true, changed: true }));
    expect(out).not.toContain("Restored status line");
    expect(out).not.toContain("Sessions sync to your OuterLayer app");
  });
});

describe("formatInitOutput — install path", () => {
  it("unchanged (already installed): the no-change line, then the epilogue", () => {
    const out = formatInitOutput(baseResult({ changed: false }));
    expect(out).toBe(`${GREEN}✓${RESET} Hooks already installed in /home/dev/.claude/settings.json (no change)\n${EPILOGUE}`);
  });

  it("changed with no backup: installed line lists the events, no backup mention", () => {
    const out = formatInitOutput(baseResult({ changed: true }));
    expect(out).toBe(`${GREEN}✓${RESET} Installed SessionStart, SessionEnd, Stop hooks → /home/dev/.claude/settings.json\n${EPILOGUE}`);
  });

  it("changed WITH a backup path names it right after the installed line", () => {
    const out = formatInitOutput(baseResult({ changed: true, backupPath: "/home/dev/.claude/settings.json.bak-1" }));
    expect(out).toBe(
      `${GREEN}✓${RESET} Installed SessionStart, SessionEnd, Stop hooks → /home/dev/.claude/settings.json\n` +
        `${DIM}  backup: /home/dev/.claude/settings.json.bak-1${RESET}\n${EPILOGUE}`,
    );
  });

  it("wrapped hooks: header line names the count, one line per wrapped candidate with matcher shown when present", () => {
    const out = formatInitOutput(
      baseResult({
        changed: true,
        wrapped: [
          { event: "PreToolUse", matcherIndex: 0, hookIndex: 0, matcher: "Bash", command: "/guard/check", wrapped: false },
          { event: "PostToolUse", matcherIndex: 0, hookIndex: 0, command: "/format/on-write", wrapped: false },
        ],
      }),
    );
    expect(out).toBe(
      `${GREEN}✓${RESET} Installed SessionStart, SessionEnd, Stop hooks → /home/dev/.claude/settings.json\n` +
        `${GREEN}✓${RESET} Auto-wrapped 2 hook(s) for execution evidence (adds one spawn per firing — see ${YELLOW}outerlayer hooks unwrap${RESET} to undo):\n` +
        `  ${DIM}PreToolUse[Bash]: /guard/check${RESET}\n` +
        `  ${DIM}PostToolUse: /format/on-write${RESET}\n${EPILOGUE}`,
    );
  });

  it("an empty wrapped array produces no header and no per-hook lines", () => {
    const out = formatInitOutput(baseResult({ changed: true, wrapped: [] }));
    expect(out).not.toContain("Auto-wrapped");
  });

  it("statusline installed: the plain install line", () => {
    const out = formatInitOutput(baseResult({ changed: true, statusline: "installed" }));
    expect(out).toContain(`${GREEN}✓${RESET} Installed the OuterLayer status line (session + all-agent cost)\n`);
  });

  it("statusline repaired: the SAME plain install line as 'installed' (both share the message)", () => {
    const out = formatInitOutput(baseResult({ changed: true, statusline: "repaired" }));
    expect(out).toContain(`${GREEN}✓${RESET} Installed the OuterLayer status line (session + all-agent cost)\n`);
  });

  it("statusline wrapped: the wrap message names the preserved command", () => {
    const out = formatInitOutput(baseResult({ changed: true, statusline: "wrapped", statuslineWrappedCommand: "my-status.sh --flag" }));
    expect(out).toContain(
      `${GREEN}✓${RESET} Status line was occupied — wrapped it (its output stays, ours appends):\n` +
        `  ${DIM}my-status.sh --flag${RESET}\n`,
    );
  });

  it("statusline skipped: the unrecognized-shape warning", () => {
    const out = formatInitOutput(baseResult({ changed: true, statusline: "skipped" }));
    expect(out).toContain(`${YELLOW}!${RESET} Status line slot has an unrecognized shape — left untouched\n`);
  });

  it("statusline undefined (--no-statusline) or 'unchanged': no statusline line at all", () => {
    const out1 = formatInitOutput(baseResult({ changed: true, statusline: undefined }));
    expect(out1).not.toMatch(/[Ss]tatus line|[Ss]tatusline/);
    const out2 = formatInitOutput(baseResult({ changed: true, statusline: "unchanged" }));
    expect(out2).not.toMatch(/[Ss]tatus line|[Ss]tatusline/);
  });

  it("gitignoreUpdated true adds the gitignore line; false/absent omits it entirely", () => {
    const withGitignore = formatInitOutput(baseResult({ changed: true, gitignoreUpdated: true }));
    expect(withGitignore).toContain(`${GREEN}✓${RESET} Added .outerlayer/ to .gitignore\n`);
    const without = formatInitOutput(baseResult({ changed: true, gitignoreUpdated: false }));
    expect(without).not.toContain(".gitignore");
  });

  it("the epilogue and closing 'Next:' line are always present on the install path", () => {
    const out = formatInitOutput(baseResult({ changed: true }));
    expect(out).toContain("Sessions sync to your OuterLayer app with full content");
    expect(out.endsWith(`\nNext: run ${YELLOW}outerlayer scan${RESET} to see your first insights.\n`)).toBe(true);
  });
});
