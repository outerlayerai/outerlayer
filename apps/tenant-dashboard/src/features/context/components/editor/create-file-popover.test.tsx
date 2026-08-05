// @vitest-environment jsdom
/**
 * Behavior tests for the create-file popover: the kind menu (entries + copy),
 * the exact path template + scaffold each kind produces, the client-side name
 * validation matrix, duplicate detection against tree ∪ drafts, and the
 * fixed-name kinds (AGENTS.md / mcp.json) that create immediately in a single
 * scope and disable when the scope already has one. Path/scaffold strings are
 * pinned exactly — they must match what the classifier + schemas expect.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { validateMcpConfig } from "@repo/context-core";
import { CreateFilePopover } from "./create-file-popover";

// Render with the real i18n + en.json so the label/validation copy assertions
// prove the translation keys and params resolve to the shipped English.
vi.mock("@outerlayer/locales", async () => {
  const { realLocalesModule } = await import("@/test-helpers/real-i18n");
  return realLocalesModule();
});

function renderPopover(props?: {
  scopes?: string[];
  existingPaths?: ReadonlySet<string>;
  target?: React.ComponentProps<typeof CreateFilePopover>["target"];
}) {
  const anchor = document.createElement("button");
  document.body.appendChild(anchor);
  const onCreate = vi.fn();
  const onClose = vi.fn();
  render(
    <CreateFilePopover
      anchorEl={anchor}
      scopes={props?.scopes ?? [""]}
      existingPaths={props?.existingPaths ?? new Set<string>()}
      target={props?.target}
      onCreate={onCreate}
      onClose={onClose}
    />,
  );
  return { onCreate, onClose };
}

function nameInput() {
  return screen.getByTestId("create-name-input") as HTMLInputElement;
}

afterEach(cleanup);

describe("CreateFilePopover", () => {
  it("lists all six kinds with their one-line descriptions", () => {
    renderPopover();
    const expected: Array<[string, string]> = [
      ["create-kind-command", "Slash command your agents can run"],
      ["create-kind-skill", "Reusable capability with a SKILL.md"],
      ["create-kind-subagent", "Specialized agent definition"],
      ["create-kind-document", "Plain markdown doc, lives anywhere"],
      ["create-kind-instructions", "AGENTS.md-style guidance"],
      ["create-kind-mcp", "Connect a tool via mcp.json"],
    ];
    for (const [testid, copy] of expected) {
      const row = screen.getByTestId(testid);
      expect(row).toHaveTextContent(copy);
    }
  });

  it.each([
    ["create-kind-command", "deploy", ".outerlayer/commands/deploy.md"],
    ["create-kind-skill", "my-skill", ".outerlayer/skills/my-skill/SKILL.md"],
    ["create-kind-subagent", "planner", ".outerlayer/agents/planner.md"],
  ])("previews the exact path template for %s", (testid, name, expectedPath) => {
    renderPopover();
    fireEvent.click(screen.getByTestId(testid));
    fireEvent.change(nameInput(), { target: { value: name } });
    expect(screen.getByTestId("create-path-preview")).toHaveTextContent(expectedPath);
  });

  it("shows a <name> placeholder segment (not a double slash) while the name is empty", () => {
    renderPopover();
    fireEvent.click(screen.getByTestId("create-kind-skill"));
    // Empty name must not render `.outerlayer/skills//SKILL.md`.
    const preview = screen.getByTestId("create-path-preview");
    expect(preview).toHaveTextContent(".outerlayer/skills/<name>/SKILL.md");
    expect(preview.textContent).not.toContain("skills//");
  });

  it("creates a named skill draft with the exact path and scaffold", () => {
    const { onCreate } = renderPopover();
    fireEvent.click(screen.getByTestId("create-kind-skill"));
    fireEvent.change(nameInput(), { target: { value: "my-skill" } });
    fireEvent.click(screen.getByTestId("create-submit"));

    expect(onCreate).toHaveBeenCalledWith({
      path: ".outerlayer/skills/my-skill/SKILL.md",
      content: "---\nname: my-skill\ndescription: \n---\n\n",
    });
  });

  it.each([
    ["create-kind-skill", "My Skill", false],
    ["create-kind-skill", "my-skill", true],
    ["create-kind-skill", "trailing-", false],
    ["create-kind-subagent", "agent1", false],
    ["create-kind-subagent", "my-agent", true],
    ["create-kind-command", "deploy-prod", true],
  ])("validates %s name %s → enabled=%s", (testid, name, valid) => {
    renderPopover();
    fireEvent.click(screen.getByTestId(testid));
    fireEvent.change(nameInput(), { target: { value: name } });
    const submit = screen.getByTestId("create-submit");
    if (valid) expect(submit).not.toBeDisabled();
    else expect(submit).toBeDisabled();
  });

  it("blocks a duplicate against tree ∪ drafts and disables Create", () => {
    const { onCreate } = renderPopover({
      existingPaths: new Set([".outerlayer/commands/deploy.md"]),
    });
    fireEvent.click(screen.getByTestId("create-kind-command"));
    fireEvent.change(nameInput(), { target: { value: "deploy" } });

    expect(screen.getByText("A file already exists at this path.")).toBeInTheDocument();
    expect(screen.getByTestId("create-submit")).toBeDisabled();
    fireEvent.click(screen.getByTestId("create-submit"));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("creates AGENTS.md immediately (no name step) in a single scope", () => {
    const { onCreate } = renderPopover();
    fireEvent.click(screen.getByTestId("create-kind-instructions"));

    expect(screen.queryByTestId("create-name-input")).toBeNull();
    expect(onCreate).toHaveBeenCalledWith({ path: ".outerlayer/AGENTS.md", content: "" });
  });

  it("creates mcp.json immediately with a scaffold that validateMcpConfig accepts", () => {
    const { onCreate } = renderPopover();
    fireEvent.click(screen.getByTestId("create-kind-mcp"));

    expect(onCreate).toHaveBeenCalledTimes(1);
    const arg = onCreate.mock.calls[0]![0] as { path: string; content: string };
    expect(arg.path).toBe(".outerlayer/mcp.json");
    expect(arg.content).toBe('{\n  "mcpServers": {}\n}\n');
    expect(validateMcpConfig(arg.content).ok).toBe(true);
  });

  it("disables a fixed-name kind whose file already exists in the scope", () => {
    const { onCreate } = renderPopover({
      existingPaths: new Set([".outerlayer/AGENTS.md"]),
    });
    const instructions = screen.getByTestId("create-kind-instructions");
    expect(instructions).toBeDisabled();
    expect(instructions).toHaveTextContent("Already exists in this scope");

    fireEvent.click(instructions);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("offers a scope select for fixed-name kinds when more than one scope exists", () => {
    renderPopover({ scopes: ["", "apps/web"] });
    // Multi-scope → picking a fixed-name kind advances to a step (no immediate create).
    fireEvent.click(screen.getByTestId("create-kind-instructions"));
    expect(screen.getByTestId("create-scope-select")).toBeInTheDocument();
    expect(screen.getByTestId("create-path-preview")).toHaveTextContent(".outerlayer/AGENTS.md");
  });

  it("creates a Document at the scope root with an empty scaffold", () => {
    const { onCreate } = renderPopover();
    fireEvent.click(screen.getByTestId("create-kind-document"));
    fireEvent.change(nameInput(), { target: { value: "notes" } });
    fireEvent.click(screen.getByTestId("create-submit"));
    expect(onCreate).toHaveBeenCalledWith({ path: ".outerlayer/notes.md", content: "" });
  });

  it("lets a Document name nest with '/' into folders", () => {
    renderPopover();
    fireEvent.click(screen.getByTestId("create-kind-document"));
    fireEvent.change(nameInput(), { target: { value: "guides/intro" } });
    expect(screen.getByTestId("create-path-preview")).toHaveTextContent(".outerlayer/guides/intro.md");
    expect(screen.getByTestId("create-submit")).not.toBeDisabled();
  });

  it("lets a command name nest with '/' into a namespace", () => {
    renderPopover();
    fireEvent.click(screen.getByTestId("create-kind-command"));
    fireEvent.change(nameInput(), { target: { value: "deploy/ship" } });
    expect(screen.getByTestId("create-path-preview")).toHaveTextContent(".outerlayer/commands/deploy/ship.md");
    expect(screen.getByTestId("create-submit")).not.toBeDisabled();
  });

  it("shows the scope root as the default location line", () => {
    renderPopover();
    fireEvent.click(screen.getByTestId("create-kind-document"));
    expect(screen.getByTestId("create-location")).toHaveTextContent(".outerlayer");
  });

  it("opens directly on the naming step for a preset kind, with the target dir as the location and no menu", () => {
    const { onCreate } = renderPopover({
      target: { scope: "", baseDir: ".outerlayer/commands/deploy", presetKind: "command" },
    });
    // No kind menu — straight to naming; no Back button (nothing to return to).
    expect(screen.queryByTestId("create-kind-command")).toBeNull();
    expect(screen.queryByLabelText("Back")).toBeNull();
    expect(screen.getByTestId("create-location")).toHaveTextContent(".outerlayer/commands/deploy");

    fireEvent.change(nameInput(), { target: { value: "ship" } });
    expect(screen.getByTestId("create-path-preview")).toHaveTextContent(".outerlayer/commands/deploy/ship.md");
    fireEvent.click(screen.getByTestId("create-submit"));
    expect(onCreate).toHaveBeenCalledWith({
      path: ".outerlayer/commands/deploy/ship.md",
      content: "---\ndescription: \n---\n\n",
    });
  });

  it("opens on the skill naming step from a bare skills/ row and keeps the fixed SKILL.md path", () => {
    const { onCreate } = renderPopover({
      target: { scope: "", baseDir: ".outerlayer/skills", presetKind: "skill" },
    });
    // Preset kind → straight to naming, no Back, location is the skills dir.
    expect(screen.queryByLabelText("Back")).toBeNull();
    expect(screen.getByTestId("create-location")).toHaveTextContent(".outerlayer/skills");

    // A skill keeps skills/<name>/SKILL.md — NOT skills/<name>.md from the baseDir.
    fireEvent.change(nameInput(), { target: { value: "research" } });
    expect(screen.getByTestId("create-path-preview")).toHaveTextContent(".outerlayer/skills/research/SKILL.md");
    fireEvent.click(screen.getByTestId("create-submit"));
    expect(onCreate).toHaveBeenCalledWith({
      path: ".outerlayer/skills/research/SKILL.md",
      content: "---\nname: research\ndescription: \n---\n\n",
    });
  });

  it("rejects a '/' in a skill name from the bare skills/ row (no nesting)", () => {
    renderPopover({ target: { scope: "", baseDir: ".outerlayer/skills", presetKind: "skill" } });
    fireEvent.change(nameInput(), { target: { value: "a/b" } });
    expect(screen.getByTestId("create-submit")).toBeDisabled();
  });

  it("blocks a targeted create whose resulting path already exists (case-insensitive)", () => {
    renderPopover({
      existingPaths: new Set([".outerlayer/commands/deploy/ship.md"]),
      target: { scope: "", baseDir: ".outerlayer/commands/deploy", presetKind: "command" },
    });
    fireEvent.change(nameInput(), { target: { value: "SHIP" } });
    expect(screen.getByTestId("create-submit")).toBeDisabled();
  });
});
