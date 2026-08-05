// @vitest-environment jsdom
/**
 * React-layer tests for <RichMarkdownEditor>. The live Milkdown editor cannot be
 * created in-process under Vitest (SSR dep-optimizer dual-instances @milkdown/core
 * — see rich-markdown-editor.roundtrip.test.ts, which drives the real editor in a
 * subprocess). Here we mock ONLY the @milkdown/react binding — the seam that would
 * call `Editor.create()` — and assert the wrapper's own behavior: the client-only
 * mount guard, and that it hands @milkdown/react a factory that builds the real
 * `configureRichEditor` for a given root.
 */
import { Editor } from "@milkdown/core";
import { ThemeProvider } from "@mui/material/styles";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createAppTheme } from "../../../../theme/create-theme";

type EditorFactory = (root: HTMLElement) => Editor;
let capturedFactory: EditorFactory | undefined;

vi.mock("@milkdown/react", () => ({
  MilkdownProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="provider">{children}</div>
  ),
  Milkdown: () => <div data-testid="milkdown-surface" />,
  useEditor: (factory: EditorFactory) => {
    capturedFactory = factory;
    return { loading: false, get: () => undefined };
  },
}));

import { RichMarkdownEditor, buildRichEditorSx, type RichMarkdownEditorProps } from "./rich-markdown-editor";

// The styling reads `theme.vars.*`, so render under the app's CSS-variables theme
// (a bare default theme has no `vars` and the sx callback would throw).
const renderWithTheme = (ui: React.ReactElement) =>
  render(<ThemeProvider theme={createAppTheme()}>{ui}</ThemeProvider>);

describe("<RichMarkdownEditor>", () => {
  it("mounts the provider and editor surface after the client mount-guard flips", () => {
    capturedFactory = undefined;
    // Typed against the frozen contract so a props-shape change breaks here.
    const props: RichMarkdownEditorProps = { value: "# Hi\n\nbody\n", onChange: vi.fn() };
    renderWithTheme(<RichMarkdownEditor {...props} />);
    // The guard returns null on the server / first paint, then renders the tree
    // once the mount effect runs (jsdom flushes effects synchronously).
    expect(screen.getByTestId("provider")).toBeInTheDocument();
    expect(screen.getByTestId("milkdown-surface")).toBeInTheDocument();
  });

  it("hands @milkdown/react a factory that builds a real editor for a root element", () => {
    capturedFactory = undefined;
    renderWithTheme(<RichMarkdownEditor value="hello" onChange={vi.fn()} />);
    expect(typeof capturedFactory).toBe("function");

    // Invoking the factory runs the production `configureRichEditor` (build only —
    // `.create()` is never called here), proving the wrapper wires it to a root.
    const root = document.createElement("div");
    const editor = capturedFactory!(root);
    expect(editor).toBeInstanceOf(Editor);
    expect(typeof editor.create).toBe("function");
    expect(typeof editor.use).toBe("function");
  });
});

describe("buildRichEditorSx", () => {
  it("resolves code-surface corner radii to the theme's literal pixel radius", () => {
    const theme = createAppTheme();
    const styles = (buildRichEditorSx("hint") as (t: unknown) => Record<string, Record<string, Record<string, unknown>>>)(theme);
    const prose = styles["& .ProseMirror"]!;
    // Bare numbers inside sx get multiplied by shape.borderRadius — these must
    // stay literal px so an 8px radius doesn't render as 64px stadiums.
    expect(prose["& pre"]!.borderRadius).toBe(`${theme.shape.borderRadius}px`);
    expect(prose["& code"]!.borderRadius).toBe(`${theme.shape.borderRadius}px`);
  });
});
