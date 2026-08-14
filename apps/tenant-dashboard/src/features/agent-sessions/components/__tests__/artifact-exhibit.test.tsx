// @vitest-environment jsdom
/**
 * ArtifactExhibitView — the dashboard page behind a PR comment's evidence
 * link. Kind decides the medium: screenshots render <img>, videos <video>,
 * everything else a download link — all through the signed agent-blob route,
 * never raw bytes in the page payload.
 */

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgName: "acme" }),
}));

import { ArtifactExhibitView } from "../artifact-exhibit";
import type { ArtifactExhibit } from "../../artifact-service";

const exhibit = (over: Partial<ArtifactExhibit>): ArtifactExhibit => ({
  id: "a1",
  filename: "login.png",
  mediaType: "image/png",
  kind: "screenshot",
  caption: "Login page after fix",
  criterionId: "AC-083-01",
  provenance: "session",
  prNumber: 61,
  repository: "acme/api",
  traceId: "1b247b75d3481b247b75d3481b247b75",
  emittedAt: "2026-08-14T10:00:00.000Z",
  sha256: "ab".repeat(32),
  blobToken: "tok.en",
  ...over,
});

const props = { appId: "app-1", appName: "api", envName: "production" };

describe("ArtifactExhibitView", () => {
  it("renders a screenshot as an <img> through the signed blob route, with kind/provenance and metadata", () => {
    const { container, getByTestId, getByText } = render(
      <ArtifactExhibitView {...props} artifact={exhibit({})} />,
    );

    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(
      `/api/orgs/acme/apps/app-1/agents/blob/${"ab".repeat(32)}?appId=app-1&token=tok.en`,
    );
    expect(getByTestId("artifact-kind-chip").textContent).toBe("screenshot");
    expect(getByTestId("artifact-provenance-chip").textContent).toBe("session");
    expect(getByText("Login page after fix")).toBeTruthy();
    expect(getByText("AC-083-01")).toBeTruthy();
    expect(getByText(/acme\/api\s*#61/)).toBeTruthy();
    // The session link goes to the existing session detail page.
    expect(getByText("1b247b75").getAttribute("href")).toBe(
      "/orgs/acme/apps/api/env/production/agents/sessions/1b247b75d3481b247b75d3481b247b75",
    );
  });

  it("renders a video as a playable element and other kinds as a download link", () => {
    const video = render(
      <ArtifactExhibitView
        {...props}
        artifact={exhibit({ kind: "video", filename: "run.webm", mediaType: "video/webm" })}
      />,
    );
    expect(video.container.querySelector("video")!.getAttribute("src")).toContain(
      "/agents/blob/",
    );

    const log = render(
      <ArtifactExhibitView
        {...props}
        artifact={exhibit({ kind: "log", filename: "gate.log", mediaType: "text/plain" })}
      />,
    );
    expect(log.container.querySelector("img")).toBeNull();
    expect(log.container.querySelector("video")).toBeNull();
    expect(log.getByText("Download gate.log").getAttribute("href")).toContain(
      "/agents/blob/",
    );
  });

  it("says the link expired instead of showing a broken viewer", () => {
    const { container, getByText } = render(
      <ArtifactExhibitView {...props} artifact={exhibit({})} />,
    );
    fireEvent.error(container.querySelector("img")!);
    expect(getByText("Link expired — reload to view")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });
});
