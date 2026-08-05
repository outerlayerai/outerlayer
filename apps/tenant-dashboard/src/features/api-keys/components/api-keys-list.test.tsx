// @vitest-environment jsdom
/**
 * <ApiKeysList> renders each key's SCOPE so kind-scoped keys (env pin NULL) are
 * distinguishable and revocable — the visible half of the kind-scoped-key
 * visibility fix. A kind-scoped key shows its kind chips; a pinned key shows the
 * env name.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";

vi.mock("@outerlayer/locales", () => ({ useTranslate: () => ({ t: (k: string) => k }) }));
vi.mock("notistack", () => ({ useSnackbar: () => ({ enqueueSnackbar: vi.fn() }) }));
vi.mock("@/lib/app-shell/app-context", () => ({ useAppContext: () => ({ app: { id: "app-1" } }) }));
vi.mock("@/lib/adapters/use-app-permissions", () => ({
  useAppPermissions: () => ({ hasPermission: () => true }),
}));
vi.mock("../actions", () => ({ deleteApiKeyAction: vi.fn() }));
vi.mock("./create-api-key-modal", () => ({
  CreateApiKeyModal: () => <button data-testid="create-api-key">Create key</button>,
}));
vi.mock("./edit-api-key-modal", () => ({ EditApiKeyModal: () => null }));

import { ApiKeysList } from "./api-keys-list";

const baseKey = {
  app_id: "app-1",
  created_at: "2026-04-01T00:00:00.000Z",
  created_by: { name: "Owner" },
  api_key_id: "unkey-x",
} as any;

describe("ApiKeysList — per-row scope", () => {
  it("shows the kind chips for a kind-scoped key (Production == promoted)", () => {
    render(
      <ApiKeysList
        environmentName="dev"
        apiKeys={[
          {
            ...baseKey,
            id: "k-kind",
            name: "Preview CI key",
            environment_id: null,
            allowed_env_kinds: ["preview", "promoted"],
          },
        ]}
      />,
    );
    const row = screen.getByText("Preview CI key").closest("li")!;
    // Both kinds render, with the 'promoted' → 'Production' label mapping.
    expect(within(row).getByText("Preview")).toBeInTheDocument();
    expect(within(row).getByText("Production")).toBeInTheDocument();
    // The env name is NOT shown for a kind-scoped key.
    expect(within(row).queryByText("dev")).toBeNull();
  });

  it("shows the env name (not kind chips) for a pinned key", () => {
    render(
      <ApiKeysList
        environmentName="dev"
        apiKeys={[
          {
            ...baseKey,
            id: "k-pin",
            name: "Dev pinned",
            environment_id: "env-1",
            allowed_env_kinds: null,
          },
        ]}
      />,
    );
    const row = screen.getByText("Dev pinned").closest("li")!;
    expect(within(row).getByText("dev")).toBeInTheDocument();
    expect(within(row).queryByText("Preview")).toBeNull();
  });
});

describe("ApiKeysList — row idiom", () => {
  const keys = [
    { ...baseKey, id: "k1", name: "Alpha key", environment_id: "env-1", allowed_env_kinds: null },
    { ...baseKey, id: "k2", name: "Bravo key", environment_id: "env-1", allowed_env_kinds: null },
    { ...baseKey, id: "k3", name: "Charlie key", environment_id: "env-1", allowed_env_kinds: null },
  ] as any[];

  it("renders one named row per key, in order", () => {
    render(<ApiKeysList environmentName="dev" apiKeys={keys} />);

    const names = screen
      .getAllByTestId("api-key-row-name")
      .map((el) => el.textContent);
    expect(names).toEqual(["Alpha key", "Bravo key", "Charlie key"]);
  });

  it("gives each row a trailing edit and delete action", () => {
    render(<ApiKeysList environmentName="dev" apiKeys={keys} />);

    const row = screen.getByText("Bravo key").closest("li")!;
    // Both actions render because hasPermission is mocked true; the create
    // button lives outside the rows, so a row has exactly the two actions.
    expect(within(row).getAllByRole("button")).toHaveLength(2);
  });

  it("places the create action above the key rows", () => {
    render(<ApiKeysList environmentName="dev" apiKeys={keys} />);

    const create = screen.getByTestId("create-api-key");
    const firstRow = screen.getByText("Alpha key").closest("li")!;
    // The first row follows the create action in document order.
    const relation = create.compareDocumentPosition(firstRow);
    expect(relation & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});

describe("ApiKeysList — created-at timestamp", () => {
  /* The list is server-rendered: the settings React Server Component (RSC) queries the keys and passes
   * them straight in, so a timestamp formatted during render lands in the HTML
   * in the SERVER's timezone. On a date-carrying format the two sides can name
   * different days — a key created near midnight UTC is "the 30th" to the
   * server and "the 31st" to a visitor east of it. It fills in after mount
   * instead. */
  const key = { ...baseKey, id: "k-1", name: "CI key", environment_id: "env-1" };

  it("keeps the created-at timestamp out of the server render", () => {
    const html = renderToString(<ApiKeysList environmentName="dev" apiKeys={[key]} />);

    expect(html).toContain("CI key");
    expect(html).not.toMatch(/Apr|April|2026|00:00|12:00/);
  });

  it("shows the created-at timestamp once mounted", () => {
    render(<ApiKeysList environmentName="dev" apiKeys={[key]} />);

    const row = screen.getByText("CI key").closest("li")!;
    // Rendered in whatever zone the runner sits in, so pin the shape: an en-US
    // month-first date with a clock time.
    expect(row.textContent).toMatch(/[A-Za-z]{3,5}\.? \d{1,2}, \d{4}, \d{1,2}:\d{2}/);
  });
});
