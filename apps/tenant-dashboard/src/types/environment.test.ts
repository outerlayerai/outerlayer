/**
 * EnvKind classifier + the declarative env predicates.
 *
 * These pin the DECOUPLING that the kind model exists to enforce: "reads from a
 * snapshot" (read source) and "is read-only" (writability) are SEPARATE axes. A
 * preview env reads its snapshot yet stays writable — the exact case a single
 * `isPinned = current_version > 0` flag got wrong (it read preview content from
 * the wrong branch AND marked it read-only). If a future change collapses the
 * two axes back together, the preview-env rows below fail.
 */
import { describe, it, expect } from "vitest";
import {
  classifyEnvKind,
  envReadsSnapshot,
  envIsReadOnly,
  envIsWritable,
  envIsPreview,
  type EnvKind,
} from "./environment";

describe("classifyEnvKind", () => {
  it("default = no version, not ephemeral", () => {
    expect(classifyEnvKind({ current_version: 0, is_ephemeral: false })).toBe(
      "default",
    );
    // is_ephemeral may be absent on the wire shape.
    expect(classifyEnvKind({ current_version: 0 })).toBe("default");
  });

  it("promoted = versioned, not ephemeral", () => {
    expect(classifyEnvKind({ current_version: 5, is_ephemeral: false })).toBe(
      "promoted",
    );
  });

  it("preview = ephemeral, and WINS over the version proxy (a deployed preview has current_version > 0)", () => {
    expect(classifyEnvKind({ current_version: 0, is_ephemeral: true })).toBe(
      "preview",
    );
    // The crux: a preview env bumps current_version on deploy, but is still a
    // preview, NOT promoted — preview must win.
    expect(classifyEnvKind({ current_version: 3, is_ephemeral: true })).toBe(
      "preview",
    );
  });
});

describe("env predicates — the two axes are independent", () => {
  const cases: Array<{
    kind: EnvKind;
    readsSnapshot: boolean;
    readOnly: boolean;
    writable: boolean;
    preview: boolean;
  }> = [
    { kind: "default", readsSnapshot: false, readOnly: false, writable: true, preview: false },
    { kind: "preview", readsSnapshot: true, readOnly: false, writable: true, preview: true },
    { kind: "promoted", readsSnapshot: true, readOnly: true, writable: false, preview: false },
    { kind: "unknown", readsSnapshot: false, readOnly: false, writable: true, preview: false },
  ];

  for (const c of cases) {
    it(`${c.kind}: readsSnapshot=${c.readsSnapshot} readOnly=${c.readOnly} writable=${c.writable} preview=${c.preview}`, () => {
      expect(envReadsSnapshot(c.kind)).toBe(c.readsSnapshot);
      expect(envIsReadOnly(c.kind)).toBe(c.readOnly);
      expect(envIsWritable(c.kind)).toBe(c.writable);
      expect(envIsPreview(c.kind)).toBe(c.preview);
    });
  }

  it("preview is the decoupled case: reads a snapshot AND is writable (the bug class)", () => {
    expect(envReadsSnapshot("preview")).toBe(true);
    expect(envIsReadOnly("preview")).toBe(false);
    expect(envIsWritable("preview")).toBe(true);
  });

  it("envIsWritable is the strict inverse of envIsReadOnly for every kind", () => {
    for (const c of cases) {
      expect(envIsWritable(c.kind)).toBe(!envIsReadOnly(c.kind));
    }
  });
});

describe("predicates accept a bare kind OR anything carrying one", () => {
  it("works on a { kind } object, not just the string", () => {
    const previewEnv = { kind: "preview" as const, name: "pr-7" };
    expect(envReadsSnapshot(previewEnv)).toBe(true);
    expect(envIsReadOnly(previewEnv)).toBe(false);
    expect(envIsWritable(previewEnv)).toBe(true);
    expect(envIsPreview(previewEnv)).toBe(true);

    const promotedScope = { kind: "promoted" as const, envId: "e1" };
    expect(envIsReadOnly(promotedScope)).toBe(true);
    expect(envReadsSnapshot(promotedScope)).toBe(true);
  });
});
