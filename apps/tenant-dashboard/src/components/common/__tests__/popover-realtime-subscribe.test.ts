// @vitest-environment jsdom
/**
 * Regression — Sentry: "tried to subscribe multiple times. 'subscribe' can only
 * be called a single time per channel instance" (route-error-boundary,
 * vercel-production, /templates).
 *
 * What changed: the Apr-2026 security upgrades moved @supabase/realtime-js
 * 2.11.2 -> 2.11.10. In 2.11.2 RealtimeClient.channel(topic) always created a
 * fresh channel; in 2.11.10 it DEDUPES by topic and returns the existing one.
 * Combined with createSupabaseFontendClient() being a process-wide singleton
 * (@supabase/ssr >=0.4), two co-mounted instances of a popover that used a
 * FIXED channel name (AccountPopover -> "public", NotificationsPopover ->
 * "schema-db-changes") collapsed onto one already-joined channel, so the second
 * .subscribe() threw. The persistent AppHeader renders one instance of each
 * popover, but the useId() topic remains the contract that keeps any two
 * co-mounted instances (e.g. a transient double-mount) off a shared channel.
 *
 * Fix: each popover instance derives a unique channel topic (useId()), so two
 * instances never share a channel. This test pins that contract.
 *
 * Part 1 exercises the real realtime-js lifecycle (only the WebSocket connect is
 * stubbed) to lock the library behaviour the fix relies on. Part 2 renders the
 * real components twice and asserts they subscribe DISTINCT, non-fixed topics —
 * reverting either popover to a constant name fails it.
 */

import React from "react";
import MenuList from "@mui/material/MenuList";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import { createBrowserClient } from "@supabase/ssr";

// ---------------------------------------------------------------------------
// Part 1 — realtime-js lifecycle (real client, stubbed socket)
// ---------------------------------------------------------------------------

type Client = ReturnType<typeof createBrowserClient>;

function makeRealClient(): Client {
  const client = createBrowserClient("http://localhost:54321", "anon-key", {
    isSingleton: false,
  });
  vi.spyOn(client.realtime, "connect").mockImplementation(() => {});
  return client;
}

function subscribeProfile(supabase: Client, topic: string) {
  return supabase
    .channel(topic)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "profile", filter: "id=eq.u1" },
      () => {},
    )
    .subscribe();
}

describe("realtime channel lifecycle (the fix's foundation)", () => {
  it("createBrowserClient returns a browser singleton — the whole app shares one realtime client", () => {
    const a = createBrowserClient("http://localhost:54321", "anon-key");
    const b = createBrowserClient("http://localhost:54321", "anon-key");
    expect(a).toBe(b);
  });

  it("REGRESSION: two instances on the SAME fixed topic collide -> second subscribe throws", () => {
    const supabase = makeRealClient();
    const ch1 = subscribeProfile(supabase, "public");
    // realtime-js dedupes by topic -> same already-joined instance back.
    expect(supabase.channel("public")).toBe(ch1);
    // The exact wording is the library's; the pinned behavior is that reusing
    // the already-subscribed channel throws instead of silently rebinding.
    expect(() => subscribeProfile(supabase, "public")).toThrowError(
      /cannot add `postgres_changes` callbacks .* after `subscribe\(\)`/,
    );
  });

  it("FIX: two instances on per-instance UNIQUE topics each get their own subscribed channel", () => {
    const supabase = makeRealClient();
    // A second subscribe with a DIFFERENT topic must not collide — if it did,
    // .subscribe() would throw here and fail the test outright (that IS the
    // assertion that the collision is gone).
    const ch1 = subscribeProfile(supabase, "profile-a1");
    const ch2 = subscribeProfile(supabase, "profile-b2");
    expect(ch1.topic).toBe("realtime:profile-a1");
    expect(ch2.topic).toBe("realtime:profile-b2");
    expect(ch2).not.toBe(ch1);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — the real popover components must subscribe UNIQUE, non-fixed topics
// ---------------------------------------------------------------------------

// Record every channel name the components request via the singleton client.
// The realtime surface is the accepted exception to MSW: a recording client is
// the seam.
const channelNames: string[] = [];

function makeQuery(result: unknown) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "match", "order", "single", "neq", "limit", "range", "update"]) {
    chain[m] = vi.fn(() => chain);
  }
  // Thenable: awaiting at any point in the chain resolves to `result`.
  chain.then = (onF: (v: unknown) => unknown) => Promise.resolve(result).then(onF);
  return chain;
}

const recordingClient = {
  channel: vi.fn((name: string) => {
    channelNames.push(name);
    const ch: Record<string, unknown> = {};
    ch.on = vi.fn(() => ch);
    ch.subscribe = vi.fn(() => ch);
    return ch;
  }),
  removeChannel: vi.fn(),
  from: vi.fn((table: string) =>
    makeQuery(
      table === "profile"
        ? { data: { id: "u1", name: "Ada", email: "ada@x.io", avatar_url: null }, error: null }
        : { data: [], count: 0, error: null },
    ),
  ),
};

vi.mock("../../../supabaseFrontendClient", () => ({
  createSupabaseFontendClient: () => recordingClient,
}));

vi.mock("../../../auth/hooks", () => ({
  useAuthContext: () => ({
    // NotificationsPopover reads `activeTenant` (URL-reactive), not `tenant`
    // (event-driven, stale-on-navigation) — both are set here since
    // AccountPopover still reads `tenant` for its own profile subscription.
    user: { id: "u1", tenant: { tenant_id: "t1" }, activeTenant: { tenant_id: "t1" } },
    logout: vi.fn(),
  }),
}));

vi.mock("../../../auth/hooks/use-platform-admin", () => ({
  usePlatformAdmin: () => ({ isPlatformAdmin: false }),
}));

vi.mock("../../../routes/hooks", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("../../../routes/paths", () => ({
  paths: {
    profile: { root: "/profile" },
    platformAdmin: { root: "/platform-admin" },
  },
}));

vi.mock("../../snackbar", () => ({
  useSnackbar: () => ({ enqueueSnackbar: vi.fn() }),
}));

vi.mock("../../custom-popover", () => ({
  __esModule: true,
  // Wrap in MenuList so the popover's <MenuItem>s resolve the MenuListContext
  // that MUI v9 requires (the real CustomPopover does the same).
  default: ({ children }: { children: React.ReactNode }) =>
    React.createElement(MenuList, null, children),
  usePopover: () => ({ open: false, onOpen: vi.fn(), onClose: vi.fn() }),
}));

vi.mock("../../../utils/storage", () => ({
  getAvatarUrl: vi.fn(async () => ""),
}));

import AccountPopover from "../account-popover";
import NotificationsPopover from "../notifications-popover";

describe("header popovers subscribe unique realtime topics per instance", () => {
  beforeEach(() => {
    channelNames.length = 0;
  });

  it("two AccountPopover instances request two DISTINCT, non-'public' channel topics", async () => {
    await act(async () => {
      render(React.createElement(React.Fragment, null, [
        React.createElement(AccountPopover, { key: "a" }),
        React.createElement(AccountPopover, { key: "b" }),
      ]));
    });

    const topics = channelNames.filter((n) => n.startsWith("profile-"));
    expect(topics).toHaveLength(2);
    expect(new Set(topics).size).toBe(2); // unique per instance
    expect(channelNames).not.toContain("public"); // the old fixed name is gone
  });

  it("two NotificationsPopover instances request two DISTINCT, non-'schema-db-changes' topics", async () => {
    await act(async () => {
      render(React.createElement(React.Fragment, null, [
        React.createElement(NotificationsPopover, { key: "a" }),
        React.createElement(NotificationsPopover, { key: "b" }),
      ]));
    });

    const topics = channelNames.filter((n) => n.startsWith("notifications-"));
    expect(topics).toHaveLength(2);
    expect(new Set(topics).size).toBe(2);
    expect(channelNames).not.toContain("schema-db-changes");
  });
});
