import { describe, it, expect } from "vitest";
import { commitContextChangesSchema } from "./schemas";

function batchOf(count: number) {
  return {
    appId: "app-1",
    files: Array.from({ length: count }, (_, i) => ({
      path: `.outerlayer/docs/file-${i}.md`,
      content: "x",
      baseBlobSha: null,
    })),
  };
}

describe("commitContextChangesSchema", () => {
  it("accepts a batch at exactly the 1000-file cap", () => {
    const result = commitContextChangesSchema.safeParse(batchOf(1000));
    expect(result.success).toBe(true);
  });

  it("rejects a batch of 1001 files with the cap message the action surfaces to the dialog", () => {
    const result = commitContextChangesSchema.safeParse(batchOf(1001));
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.error.issues[0]?.message).toBe("a batch commits at most 1000 files at once");
  });
});
