"use client";

import NextError from "next/error";
import { useErrorBoundaryRecovery } from "@/hooks/use-error-boundary-recovery";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  const { isReloading, needsManualRefresh, manualRefreshReason } = useErrorBoundaryRecovery(
    error,
    "global-error-boundary",
  );

  // Show "Updating..." UI while reloading for skew errors
  if (isReloading) {
    return (
      <html>
        <body>
          <div style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            textAlign: "center",
            gap: "1rem",
            fontFamily: "system-ui, -apple-system, sans-serif"
          }}>
            <h1 style={{ fontSize: "1.5rem", margin: 0 }}>Updating application...</h1>
            <p style={{ color: "#666", margin: 0 }}>
              Loading the latest version. This will only take a moment.
            </p>
          </div>
        </body>
      </html>
    );
  }

  // The automatic recovery refused, and the generic Next.js error page offers no
  // way to say so. Neither wording states a release as fact — an aborted React Server Component (RSC)
  // stream reaches here with no deploy involved. No MUI, no provider: this
  // boundary replaces the root layout, so nothing is mounted around it.
  if (needsManualRefresh) {
    return (
      <html>
        <body>
          <div style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            textAlign: "center",
            gap: "1rem",
            fontFamily: "system-ui, -apple-system, sans-serif"
          }}>
            <h1 style={{ fontSize: "1.5rem", margin: 0 }}>
              {manualRefreshReason === "reloads-spent"
                ? "This page still is not loading"
                : "This page may be out of date"}
            </h1>
            <p style={{ color: "#666", margin: 0 }}>
              {manualRefreshReason === "reloads-spent"
                ? "Reloading did not fix it. Refresh to try again."
                : "Refresh to load the current version."}
            </p>
            <button type="button" onClick={() => window.location.reload()}>
              Refresh page
            </button>
          </div>
        </body>
      </html>
    );
  }

  return (
    <html>
      <body>
        {/* `NextError` is the default Next.js error page component. Its type
        definition requires a `statusCode` prop. However, since the App Router
        does not expose status codes for errors, we simply pass 0 to render a
        generic error message. */}
        <NextError statusCode={0} />
      </body>
    </html>
  );
}