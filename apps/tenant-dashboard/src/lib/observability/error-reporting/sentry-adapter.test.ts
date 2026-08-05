import { SentryNextjsAdapter } from "./sentry-adapter";

// The adapter is the ONLY place allowed to call @sentry/nextjs directly; this
// test pins that it forwards each call (and the level/tags/extra context)
// faithfully to the SDK.
const mockSentry = vi.hoisted(() => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  setUser: vi.fn(),
  setContext: vi.fn(),
  setTag: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => mockSentry);

describe("SentryNextjsAdapter", () => {
  const adapter = new SentryNextjsAdapter();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards captureException with level/tags/extra context", () => {
    const err = new Error("boom");
    adapter.captureException(err, {
      level: "error",
      tags: { component: "billing" },
      extra: { invoiceId: "inv_1" },
    });

    expect(mockSentry.captureException).toHaveBeenCalledTimes(1);
    expect(mockSentry.captureException).toHaveBeenCalledWith(err, {
      level: "error",
      tags: { component: "billing" },
      extra: { invoiceId: "inv_1" },
    });
  });

  it("forwards captureException with no context as a bare call", () => {
    const err = new Error("bare");
    adapter.captureException(err);

    expect(mockSentry.captureException).toHaveBeenCalledWith(err, undefined);
  });

  it("forwards captureMessage including the severity level", () => {
    adapter.captureMessage("Git provider API error", {
      level: "error",
      tags: { "git.provider": "github" },
      extra: { status: 500 },
    });

    expect(mockSentry.captureMessage).toHaveBeenCalledWith("Git provider API error", {
      level: "error",
      tags: { "git.provider": "github" },
      extra: { status: 500 },
    });
  });

  it("forwards setUser, setContext, and setTag verbatim", () => {
    adapter.setUser({ id: "u1", email: "u@example.com" });
    adapter.setContext("logContext", { tenantId: "t1" });
    adapter.setTag("organization_id", "t1");

    expect(mockSentry.setUser).toHaveBeenCalledWith({
      id: "u1",
      email: "u@example.com",
    });
    expect(mockSentry.setContext).toHaveBeenCalledWith("logContext", {
      tenantId: "t1",
    });
    expect(mockSentry.setTag).toHaveBeenCalledWith("organization_id", "t1");
  });

  it("clears scope state when passed null", () => {
    adapter.setUser(null);
    adapter.setContext("logContext", null);

    expect(mockSentry.setUser).toHaveBeenCalledWith(null);
    expect(mockSentry.setContext).toHaveBeenCalledWith("logContext", null);
  });
});
