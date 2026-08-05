// @vitest-environment jsdom
/**
 * Render tests for the file-level display blocks that survived the read-only
 * viewer's retirement (always-on editor): the mcp.json server summary, the
 * oversize notice, and the scope breadcrumb derivation.
 */
import { render, screen } from "@testing-library/react";
import { McpSummary, OversizeNotice, scopeBreadcrumb } from "../file-blocks";

// Render with the real i18n + en.json so the copy assertions below prove the
// translation keys and interpolation params resolve to the shipped English.
vi.mock("@outerlayer/locales", async () => {
  const { realLocalesModule } = await import("@/test-helpers/real-i18n");
  return realLocalesModule();
});

describe("McpSummary", () => {
  it("summarizes servers with transport chips and env-ref redaction note", () => {
    const content = JSON.stringify({
      mcpServers: {
        github: { url: "https://api.example/mcp" },
        local: { command: "npx", env: { TOKEN: "${GITHUB_TOKEN}" } },
      },
    });
    render(<McpSummary content={content} />);
    expect(screen.getByText("2 MCP servers")).toBeInTheDocument();
    expect(screen.getByText("github")).toBeInTheDocument();
    expect(screen.getByText("http")).toBeInTheDocument();
    expect(screen.getByText("local")).toBeInTheDocument();
    expect(screen.getByText("stdio")).toBeInTheDocument();
    expect(screen.getByText("env refs redacted")).toBeInTheDocument();
  });

  it("renders nothing for unparseable JSON", () => {
    const { container } = render(<McpSummary content="{not json" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("OversizeNotice", () => {
  it("links to the provider when a URL is available", () => {
    render(<OversizeNotice providerFileUrl="https://github.com/o/r/blob/main/big.md" />);
    expect(screen.getByRole("link", { name: /view it on your provider/i })).toHaveAttribute(
      "href",
      "https://github.com/o/r/blob/main/big.md",
    );
  });

  it("falls back to repository copy without a URL", () => {
    render(<OversizeNotice />);
    expect(
      screen.getByText(/open it in your repository to view its contents/i),
    ).toBeInTheDocument();
  });
});

describe("scopeBreadcrumb", () => {
  it("scopes nested .outerlayer paths and drops a trailing SKILL.md", () => {
    expect(scopeBreadcrumb("apps/web/.outerlayer/skills/component-conventions/SKILL.md")).toEqual([
      "apps/web",
      "skills",
      "component-conventions",
    ]);
  });

  it("emits the empty scope sentinel for root-level .outerlayer files (the view localizes it)", () => {
    expect(scopeBreadcrumb(".outerlayer/AGENTS.md")).toEqual(["", "AGENTS.md"]);
  });
});
