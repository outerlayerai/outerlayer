// @vitest-environment jsdom
/**
 * Gate regression for the "Organization settings" entry in <AccountPopover>.
 *
 * The "Organization settings" menu item is admin/owner-only and the ONLY
 * persistent path to org settings, so it MUST preserve that gate and target
 * exactly. These pins fail if the item leaks to a member, disappears for an
 * admin/owner, or routes anywhere other than the org-settings path.
 *
 * Boundaries: every seam AccountPopover reads is stubbed (the popover renders
 * its items inline via a MenuList stub so no open interaction is needed); the
 * router push is captured to assert the navigation target.
 */

import React from "react";
import MenuList from "@mui/material/MenuList";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const push = vi.fn();

let mockUser: {
  id: string;
  role?: string;
  tenant?: { organization_name?: string };
  activeTenant?: { organization_name?: string };
} = { id: "u1", role: "admin", tenant: { organization_name: "acme" }, activeTenant: { organization_name: "acme" } };

vi.mock("../../auth/hooks", () => ({
  useAuthContext: () => ({ user: mockUser, logout: vi.fn() }),
}));
vi.mock("../../auth/hooks/use-platform-admin", () => ({
  usePlatformAdmin: () => ({ isPlatformAdmin: false }),
}));
vi.mock("../../routes/hooks", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
}));
vi.mock("../../routes/paths", () => ({
  paths: {
    profile: { root: "/profile" },
    platformAdmin: { root: "/platform-admin" },
    orgs: {
      org: {
        settings: { root: (orgName: string) => `/orgs/${orgName}/settings` },
      },
    },
  },
}));
vi.mock("@/components/snackbar", () => ({
  useSnackbar: () => ({ enqueueSnackbar: vi.fn() }),
}));
vi.mock("@/components/custom-popover", () => ({
  __esModule: true,
  // The real CustomPopover wraps items in a MenuList; mirror that so the
  // <MenuItem>s resolve MUI's MenuListContext and render inline (no open needed).
  default: ({ children }: { children: React.ReactNode }) => (
    <MenuList>{children}</MenuList>
  ),
  usePopover: () => ({ open: false, onOpen: vi.fn(), onClose: vi.fn() }),
}));
vi.mock("@outerlayer/locales", () => ({
  useTranslate: () => ({ t: (key: string) => key }),
}));
vi.mock("../../utils/storage", () => ({
  getAvatarUrl: vi.fn(async () => ""),
}));

function makeQuery(result: unknown) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "single", "update", "match"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (onF: (v: unknown) => unknown) =>
    Promise.resolve(result).then(onF);
  return chain;
}
const supabaseStub = {
  channel: vi.fn(() => {
    const ch: Record<string, unknown> = {};
    ch.on = vi.fn(() => ch);
    ch.subscribe = vi.fn(() => ch);
    return ch;
  }),
  removeChannel: vi.fn(),
  from: vi.fn(() =>
    makeQuery({
      data: { id: "u1", name: "Ada", email: "ada@x.io", avatar_url: null },
      error: null,
    }),
  ),
};
vi.mock("../../supabaseFrontendClient", () => ({
  createSupabaseFontendClient: () => supabaseStub,
}));

import AccountPopover from "./account-popover";

async function renderPopover() {
  await act(async () => {
    render(<AccountPopover />);
  });
}

beforeEach(() => {
  push.mockClear();
});

describe("AccountPopover — Organization settings relocation gate", () => {
  it("shows the entry and navigates to org settings for an admin", async () => {
    mockUser = { id: "u1", role: "admin", tenant: { organization_name: "acme" }, activeTenant: { organization_name: "acme" } };
    await renderPopover();

    const item = screen.getByText("Organization settings");
    await userEvent.click(item);

    expect(push).toHaveBeenCalledWith("/orgs/acme/settings");
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("shows the entry for an owner", async () => {
    mockUser = { id: "u1", role: "owner", tenant: { organization_name: "acme" }, activeTenant: { organization_name: "acme" } };
    await renderPopover();

    expect(screen.getByText("Organization settings")).toBeInTheDocument();
  });

  it("hides the entry for a member (no leak of the org-settings path)", async () => {
    mockUser = {
      id: "u1",
      role: "member",
      tenant: { organization_name: "acme" }, activeTenant: { organization_name: "acme" },
    };
    await renderPopover();

    expect(screen.queryByText("Organization settings")).not.toBeInTheDocument();
  });

  it("navigates to the URL-active org, not a stale tenant snapshot, right after a switch", async () => {
    // tenant is a full-row fetch that only refreshes on auth events; right
    // after a pure-navigation org switch it still names the PREVIOUS org.
    // activeTenant re-derives from the URL on every render and is current.
    mockUser = {
      id: "u1",
      role: "admin",
      tenant: { organization_name: "stale-org" },
      activeTenant: { organization_name: "acme" },
    };
    await renderPopover();

    const item = screen.getByText("Organization settings");
    await userEvent.click(item);

    expect(push).toHaveBeenCalledWith("/orgs/acme/settings");
  });
});

describe("AccountPopover — header-flash cache", () => {
  it("fetches the profile once and paints the avatar from cache on remount", async () => {
    // A fresh user id so the module cache misses on the first mount regardless
    // of what earlier tests left cached.
    mockUser = { id: "u-flash", role: "admin", tenant: { organization_name: "acme" }, activeTenant: { organization_name: "acme" } };
    supabaseStub.from.mockClear();

    // First mount = cache miss → exactly one profile fetch; avatar shows the
    // initial once the fetch resolves.
    let first!: ReturnType<typeof render>;
    await act(async () => {
      first = render(<AccountPopover />);
    });
    expect(supabaseStub.from).toHaveBeenCalledTimes(1);
    expect(screen.getByText("A")).toBeInTheDocument();
    first.unmount();

    // Remount (what an org-level navigation does): cache hit → NO refetch, and
    // the avatar paints from cache instead of blinking blank. This is the
    // header-flash regression pin.
    await act(async () => {
      render(<AccountPopover />);
    });
    expect(supabaseStub.from).toHaveBeenCalledTimes(1);
    expect(screen.getByText("A")).toBeInTheDocument();
  });
});
