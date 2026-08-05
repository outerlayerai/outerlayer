// Replace the Sentry binding with a sentinel so "enabled" resolves to an
// identifiable class WITHOUT loading the real @sentry/nextjs SDK. Assertions use
// `constructor.name` (not `instanceof`) because vi.resetModules() reloads the
// real @repo/error-reporting-core per scenario, yielding a fresh NoOpAdapter
// class identity each time — the name is stable, the class object is not.
class FakeSentryAdapter {
  readonly marker = "sentry";
}
vi.mock("./sentry-adapter", () => ({ SentryNextjsAdapter: FakeSentryAdapter }));

// index.ts caches config + reporter at module scope and reads process.env once.
// Reset modules and re-import per scenario, controlling env each time.
const DSN_KEYS = [
  "ERROR_REPORTING_DSN",
  "NEXT_PUBLIC_ERROR_REPORTING_DSN",
  "BETTERSTACK_ERRORS_DSN",
  "NEXT_PUBLIC_BETTERSTACK_ERRORS_DSN",
  "ERROR_REPORTING_ENABLED",
  "ERROR_REPORTING_BACKEND",
] as const;

async function loadWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const key of DSN_KEYS) delete (process.env as Record<string, string | undefined>)[key];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) (process.env as Record<string, string>)[key] = value;
  }
  return import("./index");
}

describe("error-reporting selector", () => {
  afterEach(() => {
    for (const key of DSN_KEYS) delete (process.env as Record<string, string | undefined>)[key];
  });

  it("returns the Sentry adapter when a vendor-neutral DSN is set", async () => {
    const mod = await loadWith({ NEXT_PUBLIC_ERROR_REPORTING_DSN: "https://k@h/1" });
    expect(mod.getErrorReportingConfig().enabled).toBe(true);
    expect(mod.getErrorReporter().constructor.name).toBe("FakeSentryAdapter");
  });

  it("returns the Sentry adapter via the legacy BetterStack DSN fallback", async () => {
    const mod = await loadWith({ NEXT_PUBLIC_BETTERSTACK_ERRORS_DSN: "https://legacy@h/2" });
    const config = mod.getErrorReportingConfig();
    expect(config.enabled).toBe(true);
    expect(config.usedLegacyDsn).toBe(true);
    expect(mod.getErrorReporter().constructor.name).toBe("FakeSentryAdapter");
  });

  it("returns the no-op adapter when no DSN is configured", async () => {
    const mod = await loadWith({});
    expect(mod.getErrorReportingConfig().enabled).toBe(false);
    expect(mod.getErrorReporter().constructor.name).toBe("NoOpAdapter");
  });

  it("returns the no-op adapter when force-disabled despite a DSN", async () => {
    const mod = await loadWith({
      NEXT_PUBLIC_ERROR_REPORTING_DSN: "https://k@h/1",
      ERROR_REPORTING_ENABLED: "false",
    });
    expect(mod.getErrorReporter().constructor.name).toBe("NoOpAdapter");
  });

  it("caches the reporter across calls (same instance)", async () => {
    const mod = await loadWith({ NEXT_PUBLIC_ERROR_REPORTING_DSN: "https://k@h/1" });
    expect(mod.getErrorReporter()).toBe(mod.getErrorReporter());
  });
});
