// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const pathnameState = vi.hoisted(() => ({ value: '/profile' }));
vi.mock('next/navigation', () => ({ usePathname: () => pathnameState.value }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/iconify', () => ({ default: () => <span data-testid="icon" /> }));

import { ProfileNav } from '../profile-nav';

describe('ProfileNav', () => {
  it('renders the three profile tabs pointing at their sub-routes', () => {
    pathnameState.value = '/profile';
    render(<ProfileNav />);
    expect(screen.getByRole('link', { name: 'General' })).toHaveAttribute('href', '/profile');
    expect(screen.getByRole('link', { name: 'Connections' })).toHaveAttribute(
      'href',
      '/profile/connections',
    );
    expect(screen.getByRole('link', { name: 'Security' })).toHaveAttribute(
      'href',
      '/profile/security',
    );
  });

  it('marks only the exact-match route active', () => {
    pathnameState.value = '/profile/connections';
    render(<ProfileNav />);
    expect(screen.getByRole('link', { name: 'Connections' }).className).toContain('Mui-selected');
    expect(screen.getByRole('link', { name: 'General' }).className).not.toContain('Mui-selected');
    expect(screen.getByRole('link', { name: 'Security' }).className).not.toContain('Mui-selected');
  });

  it('does not activate General on a sub-route (exact match only, no prefix bleed)', () => {
    pathnameState.value = '/profile/security';
    render(<ProfileNav />);
    expect(screen.getByRole('link', { name: 'General' }).className).not.toContain('Mui-selected');
    expect(screen.getByRole('link', { name: 'Security' }).className).toContain('Mui-selected');
  });
});
