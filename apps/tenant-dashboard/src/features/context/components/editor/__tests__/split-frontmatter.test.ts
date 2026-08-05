import { describe, it, expect } from "vitest";
import { conformTrailingNewline, splitFrontmatter, joinFrontmatter } from "../split-frontmatter";

describe("splitFrontmatter", () => {
  it("separates a frontmatter block from the body, delimiters staying with the frontmatter", () => {
    const raw = "---\nname: deploy\nkind: skill\n---\n# Deploy\n\nBody text.\n";
    expect(splitFrontmatter(raw)).toEqual({
      frontmatter: "---\nname: deploy\nkind: skill\n---\n",
      body: "# Deploy\n\nBody text.\n",
    });
  });

  it("treats a file with no frontmatter as all body, so AGENTS.md never gains one", () => {
    const raw = "# AGENTS\n\nJust instructions, no frontmatter.\n";
    expect(splitFrontmatter(raw)).toEqual({ frontmatter: "", body: raw });
  });

  it("does not treat a mid-file thematic break as frontmatter", () => {
    const raw = "# Title\n\ntext\n\n---\n\nmore\n";
    expect(splitFrontmatter(raw)).toEqual({ frontmatter: "", body: raw });
  });

  it("round-trips byte-exactly for frontmatter, plain, and CRLF inputs", () => {
    for (const raw of [
      "---\nname: x\n---\nbody\n",
      "no frontmatter here\n",
      "---\r\nname: x\r\n---\r\nbody\r\n",
      "---\nunknown_key: survives\nname: y\n---\n",
    ]) {
      const { frontmatter, body } = splitFrontmatter(raw);
      expect(joinFrontmatter(frontmatter, body)).toBe(raw);
    }
  });
});

describe("conformTrailingNewline", () => {
  it("strips the serializer's trailing newline when the loaded body had none", () => {
    expect(conformTrailingNewline("line one\nline two\n", "line one\nline two")).toBe(
      "line one\nline two",
    );
  });

  it("adds a trailing newline when the loaded body had one but the output lost it", () => {
    expect(conformTrailingNewline("line one\nline two", "line one\nline two\n")).toBe(
      "line one\nline two\n",
    );
  });

  it("leaves the output untouched when the trailing-newline state already matches", () => {
    expect(conformTrailingNewline("body\n", "loaded\n")).toBe("body\n");
    expect(conformTrailingNewline("body", "loaded")).toBe("body");
  });

  it("removes only the final newline, preserving an intentional blank last line", () => {
    // Interior blank lines are genuine content; only the single EOF newline moves.
    expect(conformTrailingNewline("a\n\n", "a")).toBe("a\n");
  });
});
