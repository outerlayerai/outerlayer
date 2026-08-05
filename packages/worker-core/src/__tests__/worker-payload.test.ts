/// <reference types="node" />
/**
 * Wire-schema contracts: these schemas ARE the dashboard<->runner protocol
 * (the runner ships a duplicated copy), so shape changes must fail loudly
 * here first.
 *
 * Node's Buffer builds the base64 fixtures; the reference above scopes the
 * node types to this test file so the package's runtime-neutral src keeps
 * compiling without node globals.
 */

import {
  DEFAULT_WORKER_CAPS,
  MAX_WORKER_ATTACHMENTS,
  MAX_WORKER_ATTACHMENT_BYTES,
  MAX_WORKER_ATTACHMENT_TOTAL_BYTES,
  decodedBase64Bytes,
  isAllowedWorkerAttachmentMime,
  workerAttachmentListSchema,
  workerCallbackPayloadSchema,
  workerParamsPayloadSchema,
} from "../worker-payload";
import { workerEventBatchSchema, workerEventSchema } from "../worker-events";

const VALID_PARAMS = {
  worker_run_id: "run-1",
  app_id: "app-1",
  tenant_id: "tenant-1",
  agent: "claude-code",
  task_prompt: "add a version endpoint",
  repo_url: "https://github.com/o/r",
  repo_token: "tok",
  git_provider: "github",
  base_branch: "main",
  env_vars: { ANTHROPIC_API_KEY: "sk-ant" },
  events_url: "http://localhost:4000/api/internal/worker-events",
  callback_url: "http://localhost:4000/api/internal/worker-callback",
  worker_secret: "secret-1",
  wall_clock_cap_s: 1800,
  caps: DEFAULT_WORKER_CAPS,
};

describe("workerParamsPayloadSchema", () => {
  it("round-trips a full params payload unchanged", () => {
    expect(workerParamsPayloadSchema.parse(VALID_PARAMS)).toEqual(VALID_PARAMS);
  });

  it("round-trips attachments (name, mime, base64 content) unchanged", () => {
    const withAttachments = {
      ...VALID_PARAMS,
      attachments: [
        { name: "screenshot.png", mime: "image/png", content: "aGVsbG8=" },
        { name: "notes.md", mime: "text/markdown", content: "d29ybGQ=" },
      ],
    };
    expect(workerParamsPayloadSchema.parse(withAttachments)).toEqual(withAttachments);
  });

  it.each([
    ["missing repo_token", { ...VALID_PARAMS, repo_token: undefined }],
    ["cap above one hour", { ...VALID_PARAMS, wall_clock_cap_s: 3601 }],
    ["unknown provider", { ...VALID_PARAMS, git_provider: "bitbucket" }],
    [
      "attachment content that is not base64",
      { ...VALID_PARAMS, attachments: [{ name: "a.png", mime: "image/png", content: "not base64!!" }] },
    ],
    [
      "attachment with an empty name",
      { ...VALID_PARAMS, attachments: [{ name: "", mime: "image/png", content: "aGVsbG8=" }] },
    ],
  ])("rejects %s", (_name, payload) => {
    expect(workerParamsPayloadSchema.safeParse(payload).success).toBe(false);
  });
});

describe("decodedBase64Bytes", () => {
  it("computes exact decoded sizes including padding variants", () => {
    expect(decodedBase64Bytes(Buffer.from("a").toString("base64"))).toBe(1); // "YQ=="
    expect(decodedBase64Bytes(Buffer.from("ab").toString("base64"))).toBe(2); // "YWI="
    expect(decodedBase64Bytes(Buffer.from("abc").toString("base64"))).toBe(3); // "YWJj"
  });

  it("returns 0 for malformed base64 (bad chars or bad length)", () => {
    expect(decodedBase64Bytes("not base64!!")).toBe(0);
    expect(decodedBase64Bytes("abcde")).toBe(0);
  });
});

describe("workerAttachmentListSchema", () => {
  const png = (bytes: number) => Buffer.alloc(bytes, 7).toString("base64");
  const file = (name: string, bytes: number, mime = "image/png") => ({
    name,
    mime,
    content: png(bytes),
  });

  it("accepts a list inside every cap and returns it unchanged", () => {
    const list = [file("a.png", 1024), file("b.pdf", 2048, "application/pdf")];
    expect(workerAttachmentListSchema.parse(list)).toEqual(list);
  });

  it(`rejects more than ${MAX_WORKER_ATTACHMENTS} attachments`, () => {
    const list = Array.from({ length: MAX_WORKER_ATTACHMENTS + 1 }, (_, i) => file(`f${i}.png`, 8));
    expect(workerAttachmentListSchema.safeParse(list).success).toBe(false);
  });

  it("rejects a single file over the per-file byte cap", () => {
    const result = workerAttachmentListSchema.safeParse([
      file("big.png", MAX_WORKER_ATTACHMENT_BYTES + 1),
    ]);
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]!.message).toContain("per-file limit");
  });

  it("rejects files that individually fit but exceed the total cap", () => {
    const each = Math.ceil(MAX_WORKER_ATTACHMENT_TOTAL_BYTES / 2) + 1;
    const result = workerAttachmentListSchema.safeParse([
      file("a.png", each),
      file("b.png", each),
    ]);
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]!.message).toContain("total limit");
  });

  it("rejects audio/video/font mimes and accepts images, text, and documents", () => {
    expect(workerAttachmentListSchema.safeParse([file("clip.mp4", 8, "video/mp4")]).success).toBe(false);
    expect(isAllowedWorkerAttachmentMime("audio/mpeg")).toBe(false);
    expect(isAllowedWorkerAttachmentMime("font/woff2")).toBe(false);
    expect(isAllowedWorkerAttachmentMime("image/png")).toBe(true);
    expect(isAllowedWorkerAttachmentMime("text/plain")).toBe(true);
    expect(isAllowedWorkerAttachmentMime("application/pdf")).toBe(true);
    expect(isAllowedWorkerAttachmentMime("application/octet-stream")).toBe(true);
  });
});

describe("workerCallbackPayloadSchema", () => {
  const BASE = {
    worker_run_id: "run-1",
    app_id: "app-1",
    status: "failed",
    raw_log: "",
    duration_ms: 10,
  };

  it("requires an outcome on succeeded callbacks", () => {
    expect(
      workerCallbackPayloadSchema.safeParse({ ...BASE, status: "succeeded" }).success,
    ).toBe(false);
    expect(
      workerCallbackPayloadSchema.safeParse({
        ...BASE,
        status: "succeeded",
        outcome: "no_changes",
      }).success,
    ).toBe(true);
  });

  it("rejects outcome 'changes' with an empty or missing changes array", () => {
    expect(
      workerCallbackPayloadSchema.safeParse({
        ...BASE,
        status: "succeeded",
        outcome: "changes",
        changes: [],
      }).success,
    ).toBe(false);
    expect(
      workerCallbackPayloadSchema.safeParse({
        ...BASE,
        status: "succeeded",
        outcome: "changes",
        changes: [{ path: "a.ts", operation: "write", content: "x" }],
      }).success,
    ).toBe(true);
  });

  it("defaults file-change encoding to utf8 and accepts delete without content", () => {
    const parsed = workerCallbackPayloadSchema.parse({
      ...BASE,
      status: "succeeded",
      outcome: "changes",
      changes: [
        { path: "a.ts", operation: "write", content: "x" },
        { path: "b.png", operation: "delete" },
      ],
    });
    expect(parsed.changes).toEqual([
      { path: "a.ts", operation: "write", content: "x", encoding: "utf8" },
      { path: "b.png", operation: "delete", encoding: "utf8" },
    ]);
  });
});

describe("worker event schemas", () => {
  it("rejects negative and fractional seq values", () => {
    expect(workerEventSchema.safeParse({ seq: -1, event_type: "status" }).success).toBe(false);
    expect(workerEventSchema.safeParse({ seq: 1.5, event_type: "status" }).success).toBe(false);
  });

  it("defaults payload to an empty object", () => {
    expect(workerEventSchema.parse({ seq: 0, event_type: "status" })).toEqual({
      seq: 0,
      event_type: "status",
      payload: {},
    });
  });

  it("rejects unknown event types and oversized batches", () => {
    expect(workerEventSchema.safeParse({ seq: 0, event_type: "telemetry" }).success).toBe(false);
    const events = Array.from({ length: 501 }, (_, seq) => ({
      seq,
      event_type: "status",
    }));
    expect(
      workerEventBatchSchema.safeParse({ worker_run_id: "run-1", events }).success,
    ).toBe(false);
  });
});
