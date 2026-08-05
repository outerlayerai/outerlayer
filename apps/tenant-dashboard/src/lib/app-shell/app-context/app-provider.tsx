"use client";

/**
 * App Context Provider
 *
 * Mounted ONCE at the `(authenticated)` layout — above the persistent header —
 * so the breadcrumb's App/Env segments can resolve their context (the header
 * is chrome shared by every authenticated route, not part of the `[appName]`
 * subtree). `EnvProvider` reads `app.id` from this same provider and is also
 * mounted above `[appName]`, which is why the app object can't live
 * where it resolves (`[appName]` is a React Server Component (RSC) further down the tree).
 *
 * The provider opens no Supabase client of its own: the `[appName]` RSC layout
 * resolves the app row server-side and renders a client `<AppSeeder>` that
 * pushes it up through `AppSeedSetterContext`. The provider persists across app
 * switches and org-level routes, so it still self-manages the two behaviours a
 * mount-per-app topology would otherwise get for free:
 *
 *   1. Outside an app route (`appName` param absent) it settles to the empty
 *      resolved state (`app: null`, `loading: false`) without a seeder ever
 *      mounting beneath it.
 *   2. On an app switch it clears the previous app's state SYNCHRONOUSLY
 *      (render-time reset below) — no frame ever shows app A's context under
 *      app B's route — before the new `[appName]` subtree's seeder lands.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { AppContext, AppWithGitConnection } from "./app-context";
import { AppSeedSetterContext } from "./app-seed-context";

export const AppProvider = ({ children }: { children: React.ReactNode }) => {
  const params = useParams();
  const appName = Array.isArray(params.appName)
    ? params.appName[0]
    : params.appName;
  // The canonical tenant-scoped URL carries the org slug so the middleware
  // derives the request tenant from it (has-traces below).
  const orgName = Array.isArray(params.orgName)
    ? params.orgName[0]
    : params.orgName;

  const [app, setApp] = useState<AppWithGitConnection | null>(null);
  // `loading` is true only while there is an app to load — org-level routes
  // must not read as "an app is on its way". It clears once resolution has
  // fully SETTLED: immediately when the seed resolves to `null` (no app
  // found — nothing left to check), or once the has-traces initial check
  // below has also completed when an app IS found. The has-traces half of
  // that settling matters: `useSetupGate` (sections/onboarding/use-setup-gate.ts)
  // derives `showSetup` from `!loading && app && !hasCreatedTrace`, so a
  // `loading` that clears before the initial has-traces check resolves would
  // flash the onboarding placeholder at every returning user for one frame,
  // before the real (already-true) trace state lands.
  const [loading, setLoading] = useState(Boolean(appName));
  const [hasCreatedTrace, setHasCreatedTrace] = useState(false);

  // Render-time reset (React's derive-state-from-props idiom): the moment the
  // route's `appName` changes, drop the previous app's state in the SAME
  // render, before any child can read it. An effect-based reset would leak one
  // frame of app A's context into app B's route (or into org-level chrome).
  const [scopedAppName, setScopedAppName] = useState(appName);
  if (scopedAppName !== appName) {
    setScopedAppName(appName);
    setApp(null);
    setHasCreatedTrace(false);
    setLoading(Boolean(appName));
  }

  // Pushed down to the `[appName]` RSC's `<AppSeeder>` via context. Leaving the
  // app subtree unmounts the seeder; the render-time reset above (keyed on
  // `appName`) has already settled `app: null` by then.
  const seedApp = useCallback((seeded: AppWithGitConnection | null) => {
    setApp(seeded);
    if (!seeded) {
      // No app resolved (not found) — there is no has-traces check to wait
      // on, so resolution is fully settled the moment the (null) seed lands.
      setLoading(false);
    }
    // When `seeded` is truthy, `loading` clears below, once the has-traces
    // initial check has also settled.
  }, []);

  // live: has-traces advances server-side as onboarding progresses (a
  // background ingest pipeline, not a user action in this tab) — the initial
  // check below notices a trace that already exists by the time the app loads.
  useEffect(() => {
    if (!app?.id) return;

    let cancelled = false;

    (async () => {
      try {
        // Fail CLOSED: on a non-ok response or a thrown error, treat the app
        // as having no traces yet (`false`) and show the onboarding panel. The
        // panel is ClickHouse-independent and genuinely useful, so a transient
        // has-traces failure should surface it rather than dump a brand-new
        // user onto an empty/broken dashboard. The poll below then self-heals:
        // once the backend recovers and reports a trace, the gate flips and
        // the real content takes over.
        const response = await fetch(`/api/orgs/${orgName}/has-traces?appId=${app.id}`);
        if (cancelled) return;
        if (response.ok) {
          const data = await response.json();
          if (cancelled) return;
          setHasCreatedTrace(data.hasTraces);
        } else {
          setHasCreatedTrace(false);
        }
      } catch {
        if (!cancelled) setHasCreatedTrace(false);
      } finally {
        // Only now — app resolved AND its initial trace state is known — is
        // resolution settled. Clearing `loading` any earlier would let
        // `useSetupGate` read `hasCreatedTrace`'s still-default `false` as
        // final and flash the onboarding placeholder at a returning user who
        // already has traces.
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [app?.id, orgName]);

  // live: "waiting for your first trace" — while the app has no traces yet,
  // poll the lightweight has-traces endpoint so the onboarding placeholder
  // auto-advances to real content the moment the first trace lands (no manual
  // refresh). The effect stops as soon as a trace is seen (the guard returns
  // early once hasCreatedTrace flips true) or the component unmounts.
  //
  // This is a self-scheduling setTimeout loop, not a fixed setInterval, so it
  // can be a polite background citizen:
  //   - When the tab is hidden (`document.hidden`), it SKIPS the fetch and just
  //     reschedules — a backgrounded onboarding tab must not hammer the
  //     uncached `&fresh=1` endpoint forever.
  //   - It polls every POLL_MS while visible.
  //   - It gives up after MAX_POLL_MS of wall-clock time, after which the user
  //     relies on the manual "Check now" button. Onboarding completes in
  //     minutes; an indefinite poll on an abandoned tab is pure waste.
  useEffect(() => {
    if (!app?.id || hasCreatedTrace) return;

    const POLL_MS = 5000;
    const MAX_POLL_MS = 15 * 60 * 1000; // ~15 min of visible polling, then stop.
    const startedAt = Date.now();

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      timer = setTimeout(tick, POLL_MS);
    };

    const tick = async () => {
      if (cancelled) return;

      // Wall-clock cap reached — stop polling and let "Check now" take over.
      if (Date.now() - startedAt >= MAX_POLL_MS) return;

      // Hidden tab — don't spend the request; just come back later.
      if (typeof document !== "undefined" && document.hidden) {
        schedule();
        return;
      }

      try {
        // `fresh=1` bypasses the 30s trace cache so the first trace is seen
        // within a poll interval, not a cache-TTL later.
        const response = await fetch(`/api/orgs/${orgName}/has-traces?appId=${app.id}&fresh=1`);
        if (response.ok) {
          const data = await response.json();
          if (!cancelled && data.hasTraces) {
            setHasCreatedTrace(true);
            return; // Trace seen — the guard would stop us anyway; stop now.
          }
        }
      } catch {
        // Transient network error — keep polling.
      }

      if (!cancelled) schedule();
    };

    schedule();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [app?.id, hasCreatedTrace, orgName]);

  return (
    <AppSeedSetterContext.Provider value={seedApp}>
      <AppContext.Provider
        value={{
          app,
          loading,
          hasCreatedTrace,
          // Manual fast-path for the "Check now" button — flip the gate without a
          // full page reload (see getting-started-panel `handleCheckNow`).
          markTraceSeen: () => setHasCreatedTrace(true),
        }}
      >
        {children}
      </AppContext.Provider>
    </AppSeedSetterContext.Provider>
  );
};
