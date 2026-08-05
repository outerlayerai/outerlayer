import * as Sentry from "./sentry";

// The facade must forward every call verbatim to the active reporter. Mock the
// selector and assert delegation + argument fidelity.
const mockReporter = vi.hoisted(() => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  setUser: vi.fn(),
  setContext: vi.fn(),
  setTag: vi.fn(),
}));
vi.mock("./index", () => ({
  getErrorReporter: () => mockReporter,
}));

describe("error-reporting/sentry facade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards captureException with error identity and context", () => {
    const err = new Error("boom");
    Sentry.captureException(err, {
      tags: { component: "billing" },
      extra: { invoiceId: "inv_1" },
    });

    expect(mockReporter.captureException).toHaveBeenCalledTimes(1);
    expect(mockReporter.captureException).toHaveBeenCalledWith(err, {
      tags: { component: "billing" },
      extra: { invoiceId: "inv_1" },
    });
  });

  it("forwards captureException with no context as undefined", () => {
    const err = new Error("bare");
    Sentry.captureException(err);
    expect(mockReporter.captureException).toHaveBeenCalledWith(err, undefined);
  });

  it("forwards captureMessage including the level", () => {
    Sentry.captureMessage("Git provider API error", {
      level: "error",
      tags: { "git.provider": "github" },
      extra: { status: 500 },
    });
    expect(mockReporter.captureMessage).toHaveBeenCalledWith("Git provider API error", {
      level: "error",
      tags: { "git.provider": "github" },
      extra: { status: 500 },
    });
  });

  it("forwards setUser, setContext, and setTag verbatim", () => {
    Sentry.setUser({ id: "u1", email: "u@example.com" });
    Sentry.setContext("logContext", { tenantId: "t1" });
    Sentry.setTag("organization_id", "t1");

    expect(mockReporter.setUser).toHaveBeenCalledWith({
      id: "u1",
      email: "u@example.com",
    });
    expect(mockReporter.setContext).toHaveBeenCalledWith("logContext", {
      tenantId: "t1",
    });
    expect(mockReporter.setTag).toHaveBeenCalledWith("organization_id", "t1");
  });

  it("forwards null clears for setUser and setContext", () => {
    Sentry.setUser(null);
    Sentry.setContext("logContext", null);
    expect(mockReporter.setUser).toHaveBeenCalledWith(null);
    expect(mockReporter.setContext).toHaveBeenCalledWith("logContext", null);
  });
});
