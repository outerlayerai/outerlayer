// @vitest-environment jsdom
/**
 * Regression guard: `GeneralSettingsPage` (a Server Component) must hand
 * `<AppId>` (a Client Component) the git-connection server action itself,
 * never a wrapper closure defined in the page module. A Server Component may
 * only pass a Client Component a function that is itself a Server Action (a
 * top-level export of a `"use server"` module) — anything else throws
 * "Functions cannot be passed directly to Client Components" at render time
 * in the real app. `general-page.test.tsx` renders the real `<AppId>` under
 * plain React reconciliation, which does not enforce that boundary, so it
 * cannot catch a reintroduced wrapper — this file mocks `<AppId>` to capture
 * the prop by reference instead.
 */

import { render } from '@testing-library/react';

const { mockAction } = vi.hoisted(() => ({ mockAction: vi.fn() }));
vi.mock('@/features/git-connection/actions', () => ({
  setPrCommentsEnabledAction: mockAction,
}));

let capturedProps: Record<string, unknown> = {};
vi.mock('@/features/apps/components/app-id', () => ({
  AppId: (props: Record<string, unknown>) => {
    capturedProps = props;
    return <div data-testid="app-id-stub" />;
  },
}));

import GeneralSettingsPage from '../general/page';

describe('GeneralSettingsPage — action passthrough', () => {
  it('passes setPrCommentsEnabledAction to AppId by reference, not a wrapper', async () => {
    const tree = await GeneralSettingsPage();
    render(tree);

    expect(capturedProps.setPrCommentsEnabledAction).toBe(mockAction);
  });
});
