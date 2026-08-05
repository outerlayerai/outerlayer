// @vitest-environment jsdom
/**
 * LinkExpiredView rendering tests.
 *
 * Guards against a consumed/expired email link bouncing silently to a bare
 * login screen: /auth/confirm lands here instead, and the page must explain
 * that links are single-use and offer both recovery actions.
 */
import React from 'react';
import { render } from '@testing-library/react';

// The global setup mocks `@/components/iconify` to render nothing; override it
// so the hero glyph is visible.
vi.mock('@/components/iconify', () => ({
  __esModule: true,
  default: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

import LinkExpiredView from './link-expired-view';

describe('LinkExpiredView', () => {
  it('explains the expired link and offers both recovery actions', () => {
    const { getByText, container } = render(<LinkExpiredView />);

    expect(getByText('auth.linkExpired.title')).toBeInTheDocument();
    expect(getByText('auth.linkExpired.description')).toBeInTheDocument();

    // Hero mark is the bordered-flat line glyph, not a raster illustration.
    expect(container.querySelector('[data-icon="mdi:email-outline"]')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();

    const requestLink = getByText('auth.linkExpired.requestNewLink').closest('a');
    expect(requestLink?.getAttribute('href')).toBe('/auth/forgot-password');

    const signInLink = getByText('auth.linkExpired.returnToSignIn').closest('a');
    expect(signInLink?.getAttribute('href')).toBe('/auth/login');
  });
});
