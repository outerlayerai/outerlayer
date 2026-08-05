import { describe, it, expect } from "vitest";
import type { EditorView } from "@codemirror/view";
import { computeContextDiagnostics, lintSource } from "./editor-lint";

const VALID_SKILL = `---
name: deploy-checklist
description: Steps to run before a deploy
---
# Deploy checklist
`;

describe("computeContextDiagnostics", () => {
  it("returns no diagnostics for a valid skill file", () => {
    const diags = computeContextDiagnostics("skill", VALID_SKILL, {
      dirName: "deploy-checklist",
    });
    expect(diags).toEqual([]);
  });

  it("flags a missing required field as a WARNING (matches the publish gate), first-line fallback span", () => {
    const missingDescription = `---
name: deploy-checklist
---
body
`;
    const diags = computeContextDiagnostics("skill", missingDescription, {
      dirName: "deploy-checklist",
    });
    expect(diags).toHaveLength(1);
    const diag = diags[0]!;
    // A fixable field lint (missing/empty description) is a warning here, exactly
    // as the publish gate ships it — the raw editor must not show red for it.
    expect(diag.severity).toBe("warning");
    // The message comes straight from the shared schema — not invented here —
    // prefixed with the field path so the tooltip names what's wrong.
    expect(diag.message).toMatch(/^description: /);
    // No `description:` line to anchor on → the span is EXACTLY the first line.
    expect({ from: diag.from, to: diag.to }).toEqual({
      from: 0,
      to: missingDescription.indexOf("\n"),
    });
  });

  it("keeps an empty description a WARNING and unparseable frontmatter YAML an ERROR", () => {
    const emptyDescription = `---
name: deploy-checklist
description:${" "}
---
body
`;
    const warnDiags = computeContextDiagnostics("skill", emptyDescription, {
      dirName: "deploy-checklist",
    });
    expect(warnDiags.some((d) => d.severity === "warning" && d.message.startsWith("description:"))).toBe(true);
    expect(warnDiags.some((d) => d.severity === "error")).toBe(false);

    const brokenYaml = `---
name: [unclosed
---
body
`;
    const errDiags = computeContextDiagnostics("skill", brokenYaml, { dirName: "deploy-checklist" });
    expect(errDiags).toHaveLength(1);
    expect(errDiags[0]!.severity).toBe("error");
    expect(errDiags[0]!.source).toBe("frontmatter_unparseable");
  });

  it("spans the whole single-line document when the fallback has no newline to stop at", () => {
    // Skill frontmatter missing entirely, one line, no trailing newline.
    const oneLine = `# just a title`;
    const diags = computeContextDiagnostics("skill", oneLine, {
      dirName: "deploy-checklist",
    });
    expect(diags.length).toBeGreaterThan(0);
    expect({ from: diags[0]!.from, to: diags[0]!.to }).toEqual({
      from: 0,
      to: oneLine.length,
    });
  });

  it("marks the offending frontmatter line when the field is present but invalid", () => {
    // `name` must equal the dir name — this one doesn't.
    const mismatched = `---
name: wrong-name
description: ok
---
body
`;
    const diags = computeContextDiagnostics("skill", mismatched, {
      dirName: "deploy-checklist",
    });
    const nameDiag = diags.find((d) => d.source === "name_mismatch");
    expect(nameDiag?.severity).toBe("error");
    // The span covers the `name:` line exactly, not the whole document.
    const nameLineStart = mismatched.indexOf("name:");
    expect(nameDiag!.from).toBe(nameLineStart);
    expect(mismatched.slice(nameDiag!.from, nameDiag!.to)).toBe("name: wrong-name");
  });

  it("surfaces AGENTS.md frontmatter as a forbidden-frontmatter error, message unprefixed ((frontmatter) is not a field)", () => {
    const withFrontmatter = `---
title: nope
---
# Instructions
`;
    const diags = computeContextDiagnostics("instructions", withFrontmatter);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe("error");
    expect(diags[0]!.source).toBe("frontmatter_forbidden");
    // The sentinel "(frontmatter)" path must NOT be prefixed onto the message.
    expect(diags[0]!.message).toBe("AGENTS.md must not have frontmatter");
  });

  it("reports unknown frontmatter keys as warnings, message prefixed with the key", () => {
    const unknownKey = `---
name: deploy-checklist
description: ok
surprise: value
---
body
`;
    const diags = computeContextDiagnostics("skill", unknownKey, {
      dirName: "deploy-checklist",
    });
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe("warning");
    expect(diags[0]!.source).toBe("unknown_key");
    expect(diags[0]!.message).toBe(
      'surprise: unknown frontmatter key "surprise" — preserved, not validated',
    );
    // The squiggle sits on the `surprise:` line exactly.
    const start = unknownKey.indexOf("surprise:");
    expect(unknownKey.slice(diags[0]!.from, diags[0]!.to)).toBe("surprise: value");
    expect(diags[0]!.from).toBe(start);
  });

  it("anchors a JSON-mode diagnostic on the offending server's line via the path's LAST segment", () => {
    // `mcpServers.db` — the anchor must be the `"db"` member (last segment),
    // not `"mcpServers"` (first segment) and not the first-line fallback.
    const invalidJson = `{
  "mcpServers": {
    "db": {}
  }
}`;
    const diags = computeContextDiagnostics("mcp", invalidJson);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.every((d) => d.severity === "error")).toBe(true);
    const dbStart = invalidJson.indexOf('"db"');
    const dbLineEnd = invalidJson.indexOf("\n", dbStart);
    expect({ from: diags[0]!.from, to: diags[0]!.to }).toEqual({
      from: dbStart,
      to: dbLineEnd,
    });
  });

  it("spans to the end of the document when the offending JSON member sits on the last line", () => {
    const lastLine = `{
  "mcpServers": { "db": {} } }`;
    const diags = computeContextDiagnostics("mcp", lastLine);
    const dbStart = lastLine.indexOf('"db"');
    expect({ from: diags[0]!.from, to: diags[0]!.to }).toEqual({
      from: dbStart,
      to: lastLine.length,
    });
  });

  it("reports unparseable JSON at the first line with the raw parser message ((root) is not a field)", () => {
    const broken = `{ not json
still not json`;
    const diags = computeContextDiagnostics("mcp", broken);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.source).toBe("invalid_json");
    // "(root)" must not be prefixed, and with no key to anchor on the span is
    // the first line.
    expect(diags[0]!.message.startsWith("(root)")).toBe(false);
    expect({ from: diags[0]!.from, to: diags[0]!.to }).toEqual({
      from: 0,
      to: broken.indexOf("\n"),
    });
  });

  it("returns no diagnostics for a valid stdio mcp.json", () => {
    const validMcp = `{
  "mcpServers": {
    "db": { "command": "run-db", "args": ["--port", "5432"] }
  }
}`;
    expect(computeContextDiagnostics("mcp", validMcp)).toEqual([]);
  });

  it("lintSource reads the live document out of the editor view and diagnoses it", () => {
    // The CodeMirror seam: a view whose state holds a skill doc with an
    // unknown key. The source must produce the SAME diagnostics computed
    // directly — proving it reads view.state.doc, not a stale snapshot.
    const doc = `---
name: deploy-checklist
description: ok
surprise: value
---
body
`;
    const view = { state: { doc: { toString: () => doc } } } as unknown as EditorView;
    const source = lintSource("skill", { dirName: "deploy-checklist" });
    expect(source(view)).toEqual(
      computeContextDiagnostics("skill", doc, { dirName: "deploy-checklist" }),
    );
    expect(source(view)).toHaveLength(1);
  });
});
