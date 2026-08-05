// @vitest-environment jsdom
/**
 * Render tests for the raw CodeMirror surface. CodeMirror mounts fine under
 * jsdom, so these run the REAL editor: content lands in the contenteditable
 * surface, `readOnly` flips it non-editable, and the testid override works
 * (the knob the e2e specs target).
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { markdown } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import { Language } from "@codemirror/language";
import { CodeEditor } from "./code-editor";

// A second copy of `@codemirror/language` in the tree means markdown's parser
// carries the OTHER instance's `Language`, so its style tags never reach the
// `syntaxHighlighting` the basic setup installs — Raw markdown renders unstyled.
// Both language packages must resolve their `Language` from one module instance.
describe("codemirror language module is deduplicated", () => {
  it("resolves markdown and json parsers against a single Language class", () => {
    expect(markdown().language).toBeInstanceOf(Language);
    expect(json().language).toBeInstanceOf(Language);
  });
});

// CodeMirror measures text ranges via Range.getClientRects, which jsdom leaves
// undefined — its async measure pass then throws after a doc change (typing /
// remount). Return an empty rect list so measurement is a no-op; these tests
// assert on the document text, not on layout geometry.
beforeAll(() => {
  const emptyRectList = {
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* () {},
  } as unknown as DOMRectList;
  Range.prototype.getClientRects = () => emptyRectList;
  Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) }) as DOMRect;
});

describe("<CodeEditor>", () => {
  it("renders the document into an editable CodeMirror surface", () => {
    render(
      <CodeEditor kind="instructions" value={"# Title\n\nBody"} onChange={vi.fn()} />,
    );
    const host = screen.getByTestId("context-code-editor");
    const content = host.querySelector(".cm-content");
    expect(content?.getAttribute("contenteditable")).toBe("true");
    expect(content?.textContent).toContain("# Title");
  });

  it("renders a read-only surface when readOnly (CodeMirror announces aria-readonly)", () => {
    render(
      <CodeEditor kind="instructions" value="locked" onChange={vi.fn()} readOnly />,
    );
    const content = screen
      .getByTestId("context-code-editor")
      .querySelector(".cm-content");
    expect(content?.getAttribute("aria-readonly")).toBe("true");
  });

  it("honors a caller-supplied testid (the seam e2e specs target)", () => {
    render(
      <CodeEditor
        kind="mcp"
        value='{"mcpServers":{}}'
        onChange={vi.fn()}
        data-testid="mcp-editor"
      />,
    );
    expect(screen.getByTestId("mcp-editor").querySelector(".cm-editor")).not.toBeNull();
  });

  // Regression: a conflict-row Refresh that finds remote == buffer drops the
  // draft, reverting `value` to the loaded bytes. CodeMirror defers its own
  // external-value sync behind a keystroke latch, so right after an edit the
  // surface kept showing the stale buffer. The editor must load the external
  // value immediately by remounting the surface.
  it("loads an externally reverted value immediately after a recent edit", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [content, setContent] = useState("LOADED");
      return (
        <>
          {/* Drives an external revert to the loaded bytes (the draft-drop path). */}
          <button data-testid="ext-revert" onClick={() => setContent("LOADED")}>
            revert
          </button>
          <CodeEditor kind="instructions" value={content} onChange={setContent} />
        </>
      );
    }
    render(<Harness />);
    const host = screen.getByTestId("context-code-editor");
    const cmContent = host.querySelector(".cm-content") as HTMLElement;
    await user.click(cmContent);
    await user.type(cmContent, "ZZ");
    expect(host.querySelector(".cm-content")?.textContent).toBe("ZZLOADED");

    const surfaceBefore = host.querySelector(".cm-editor");
    await user.click(screen.getByTestId("ext-revert"));

    expect(host.querySelector(".cm-content")?.textContent).toBe("LOADED");
    // A remounted surface is the proof the external bytes loaded now rather than
    // waiting out CodeMirror's deferred sync.
    expect(host.querySelector(".cm-editor")).not.toBe(surfaceBefore);
  });

  // A self-edit round-trips back through `value` and must NOT remount the
  // surface (that would drop the cursor) nor re-emit — one change per keystroke.
  it("does not remount or loop on a self-edit round-trip", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    function Harness() {
      const [content, setContent] = useState("abc");
      return (
        <CodeEditor
          kind="instructions"
          value={content}
          onChange={(next) => {
            onChange(next);
            setContent(next);
          }}
        />
      );
    }
    render(<Harness />);
    const host = screen.getByTestId("context-code-editor");
    const cmContent = host.querySelector(".cm-content") as HTMLElement;
    const surfaceBefore = host.querySelector(".cm-editor");
    await user.click(cmContent);
    await user.type(cmContent, "X");

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("Xabc");
    expect(host.querySelector(".cm-editor")).toBe(surfaceBefore);
  });
});
