import { redirect } from "next/navigation";

export const metadata = {
  title: "Settings",
};

/**
 * Bare `/settings` redirects to `/settings/general` — the default sub-tab.
 *
 * Server-side redirect (not `useEffect` + `router.replace`) so the right pane
 * never paints blank: a client-side `useEffect` + `router.replace` would let
 * the layout render with no children for one frame before the navigation
 * kicked in. Server-side `redirect` resolves the URL before the page
 * streams, eliminating the flash entirely.
 *
 * The env is a path segment (`[envName]`), so the redirect target keeps it;
 * any remaining query params are carried through.
 */
export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgName: string; appName: string; envName: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgName, appName, envName } = await params;
  const sp = await searchParams;

  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (Array.isArray(value)) {
      for (const item of value) qs.append(key, item);
    } else if (value !== undefined) {
      qs.set(key, value);
    }
  }
  const query = qs.toString();
  const target = `/orgs/${orgName}/apps/${appName}/env/${envName}/settings/general`;
  redirect(query ? `${target}?${query}` : target);
}
