import { registerOTel, OTLPHttpJsonTraceExporter } from '@vercel/otel';
import { TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import * as Sentry from '@sentry/nextjs';

export async function register() {
  // Initialize OpenTelemetry FIRST (before Sentry) so it can instrument modules
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Enable tracing if Better Stack source token and URL are configured
    const sourceToken = process.env.NEXT_PUBLIC_BETTER_STACK_SOURCE_TOKEN;
    const ingestingUrl = process.env.NEXT_PUBLIC_BETTER_STACK_INGESTING_URL;

    if (sourceToken && ingestingUrl) {
      // Use source-specific URL with /v1/traces path for OTLP
      const baseUrl = ingestingUrl.replace(/\/$/, ''); // Remove trailing slash if present
      const tracesUrl = `${baseUrl}/v1/traces`;

      registerOTel({
        serviceName: 'tenant-dashboard',
        traceExporter: new OTLPHttpJsonTraceExporter({
          url: tracesUrl,
          headers: {
            'Authorization': `Bearer ${sourceToken}`,
          },
        }),
        // Sampling rate: 1.0 = 100%, 0.1 = 10%
        traceSampler: new TraceIdRatioBasedSampler(1.0),
      });
    }

    // Import Sentry server config AFTER OTel initialization
    await import('../sentry.server.config');

    // One structured line with the self-host EE license state at boot, so
    // operators see it in server logs without opening the dashboard.
    // The shaping logic lives in a tested ee/ helper (logLicenseStateAtBoot
    // swallows its own errors and is silent on Cloud); this is just the wire-up.
    // Dynamically imported to keep it off the edge bundle.
    const { logLicenseStateAtBoot } = await import('@ee/features/license/boot-log');
    await logLicenseStateAtBoot();
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;
