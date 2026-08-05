// This file configures the initialization of Sentry on the server.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/
// Sentry-compatible error tracking endpoint: https://$TOKEN@$HOST/1

import * as Sentry from "@sentry/nextjs";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { SUPABASE_API } from "@/config-global";
import { getErrorReportingConfig } from "@/lib/observability/error-reporting";

const errorReporting = getErrorReportingConfig();

if (errorReporting.enabled) {
  Sentry.init({
    dsn: errorReporting.dsn,
    tracesSampleRate: 1,
    debug: false,
    // Disable OTel setup to avoid conflicts with Better Stack tracing
    skipOpenTelemetrySetup: true,

    // Enrich errors with user and organization context from server-side session
    async beforeSend(event, _hint) {
      try {
        const cookieStore = await cookies();
        const supabase = createServerClient(
          SUPABASE_API.url,
          SUPABASE_API.key,
          {
            cookies: {
              getAll() {
                return cookieStore.getAll();
              },
              setAll() {
                // No-op on error reporting
              },
            },
          }
        );

        const {
          data: { user },
        } = await supabase.auth.getUser();

        if (user) {
          event.user = {
            id: user.id,
            email: user.email,
          };
        }
      } catch (error) {
        // Fail silently - don't let context enrichment break error reporting
        console.error("Failed to enrich Sentry event with user context:", error);
      }

      return event;
    },
  });
}
