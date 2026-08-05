/**
 * POST /api/internal/worker-transcript — the runner's raw-transcript upload.
 *
 * Boundary: the secret verifier is a true seam (mocked), and so is the
 * persist service (its parse/convert/insert pipeline has its own suite in
 * services/workers). These pin the route's own contract: schema reject,
 * auth reject, gzip round-trip into the service, and the advisory response.
 */
import { gzipSync } from "node:zlib";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("server-only", () => ({}));

const { mockVerify, mockPersist } = vi.hoisted(() => ({
  mockVerify: vi.fn(),
  mockPersist: vi.fn(),
}));
vi.mock("@/lib/system/workers/verify-worker-secret", () => ({ verifyWorkerSecret: mockVerify }));
vi.mock("@/lib/system/workers/persist-agent-session", () => ({ persistWorkerRunTranscript: mockPersist }));

import { POST } from "../route";

const RUN_ID = "run-1";
const TRANSCRIPT = '{"type":"system","session_id":"s1"}\n{"type":"assistant"}\n';

function reqBody(body: unknown, auth = "Bearer secret-1") {
  return {
    json: async () => body,
    headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? auth : null) },
  } as unknown as import("next/server").NextRequest;
}

const payload = (over: Record<string, unknown> = {}) => ({
  worker_run_id: RUN_ID,
  encoding: "gzip+base64",
  data: gzipSync(Buffer.from(TRANSCRIPT, "utf8")).toString("base64"),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockVerify.mockResolvedValue(true);
  mockPersist.mockResolvedValue(true);
});

describe("POST /api/internal/worker-transcript", () => {
  it("gunzips the payload and hands the exact transcript to the persist service", async () => {
    const res = await POST(reqBody(payload()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ persisted: true });
    expect(mockPersist).toHaveBeenCalledWith(expect.anything(), RUN_ID, TRANSCRIPT);
  });

  it("401s on a bad secret without touching the persist service", async () => {
    mockVerify.mockResolvedValue(false);
    const res = await POST(reqBody(payload()));
    expect(res.status).toBe(401);
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("400s a malformed payload before auth work", async () => {
    const res = await POST(reqBody({ worker_run_id: RUN_ID, encoding: "zstd", data: "x" }));
    expect(res.status).toBe(400);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("400s garbage that is not gzip", async () => {
    const res = await POST(reqBody(payload({ data: Buffer.from("not gzip").toString("base64") })));
    expect(res.status).toBe(400);
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("reports persisted:false as a 200 — fidelity misses are advisory, never a runner retry", async () => {
    mockPersist.mockResolvedValue(false);
    const res = await POST(reqBody(payload()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ persisted: false });
  });
});
