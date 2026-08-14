// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it } from "vitest";
import {
  ArtifactCriterionIdSchema,
  ArtifactSpoolRecordSchema,
  inferArtifactKind,
  mediaTypeForArtifactPath,
} from "../artifact.js";

describe("inferArtifactKind", () => {
  // proves AC-083-09
  it("maps each recognized media type to its exact kind", () => {
    expect(inferArtifactKind("video/webm")).toBe("video");
    expect(inferArtifactKind("video/mp4")).toBe("video");
    expect(inferArtifactKind("image/png")).toBe("screenshot");
    expect(inferArtifactKind("image/jpeg")).toBe("screenshot");
    expect(inferArtifactKind("text/html")).toBe("report");
    expect(inferArtifactKind("application/pdf")).toBe("report");
    expect(inferArtifactKind("text/plain")).toBe("log");
  });

  it("ignores media-type parameters and case", () => {
    expect(inferArtifactKind("text/html; charset=utf-8")).toBe("report");
    expect(inferArtifactKind("IMAGE/PNG")).toBe("screenshot");
  });

  // proves AC-083-10
  it("returns file for anything off the allowlist — never a stronger kind", () => {
    expect(inferArtifactKind("video/quicktime")).toBe("file");
    expect(inferArtifactKind("image/svg+xml")).toBe("file");
    expect(inferArtifactKind("application/octet-stream")).toBe("file");
    expect(inferArtifactKind("application/json")).toBe("file");
    expect(inferArtifactKind("")).toBe("file");
  });
});

describe("mediaTypeForArtifactPath", () => {
  it("maps known extensions and defaults the rest to octet-stream", () => {
    expect(mediaTypeForArtifactPath("/tmp/shots/login.PNG")).toBe("image/png");
    expect(mediaTypeForArtifactPath("run.webm")).toBe("video/webm");
    expect(mediaTypeForArtifactPath("report.pdf")).toBe("application/pdf");
    expect(mediaTypeForArtifactPath("build.log")).toBe("text/plain");
    expect(mediaTypeForArtifactPath("notes.txt")).toBe("text/plain");
    expect(mediaTypeForArtifactPath("archive.tar.gz")).toBe("application/octet-stream");
    expect(mediaTypeForArtifactPath(".hidden")).toBe("application/octet-stream");
    expect(mediaTypeForArtifactPath("noext")).toBe("application/octet-stream");
  });
});

describe("ArtifactCriterionIdSchema", () => {
  it("accepts id-shaped values and rejects anything renderable as markup", () => {
    expect(ArtifactCriterionIdSchema.safeParse("AC-083-04").success).toBe(true);
    expect(ArtifactCriterionIdSchema.safeParse("issue:82.3").success).toBe(true);
    expect(ArtifactCriterionIdSchema.safeParse("AC 082").success).toBe(false);
    expect(ArtifactCriterionIdSchema.safeParse("[x](y)").success).toBe(false);
    expect(ArtifactCriterionIdSchema.safeParse("<img>").success).toBe(false);
    expect(ArtifactCriterionIdSchema.safeParse("a|b").success).toBe(false);
    expect(ArtifactCriterionIdSchema.safeParse("").success).toBe(false);
  });
});

describe("ArtifactSpoolRecordSchema", () => {
  it("round-trips a full record and rejects a malformed sha", () => {
    const record = {
      rec: "artifact",
      artifactId: "0f4d1f2a-aaaa-bbbb-cccc-1234567890ab",
      t: "2026-08-14T10:00:00.000Z",
      sessionId: "sess-1",
      cwd: "/repo",
      gitRepo: "github.com/acme/app",
      gitBranch: "feat/x",
      commitSha: "a".repeat(40),
      filename: "login.png",
      mediaType: "image/png",
      bytes: 1024,
      sha256: "b".repeat(64),
      caption: "Login page after fix",
      criterionId: "AC-083-01",
    };
    const parsed = ArtifactSpoolRecordSchema.parse(record);
    expect(parsed).toEqual(record);
    expect(
      ArtifactSpoolRecordSchema.safeParse({ ...record, sha256: "not-a-sha" }).success,
    ).toBe(false);
  });
});
