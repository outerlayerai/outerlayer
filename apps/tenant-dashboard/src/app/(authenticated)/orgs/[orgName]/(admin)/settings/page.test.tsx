import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

import SettingsRootPage from "./page";
import { redirect } from "next/navigation";

beforeEach(() => {
  (redirect as unknown as ReturnType<typeof vi.fn>).mockClear();
});

describe("SettingsRootPage", () => {
  it("redirects the bare settings root into General", async () => {
    await SettingsRootPage({ params: Promise.resolve({ orgName: "acme" }) });

    expect(redirect).toHaveBeenCalledWith("/orgs/acme/settings/general");
  });
});
