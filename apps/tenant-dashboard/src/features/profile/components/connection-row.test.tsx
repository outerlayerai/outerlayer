// @vitest-environment jsdom
/**
 * The connections cards joined the settings control language: provider rows,
 * no brand fills. Pin the row anatomy per state.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/components/iconify', () => ({ default: () => <span data-testid="glyph" /> }));

import { ConnectionRow } from './connection-row';

const base = {
  icon: 'mdi:github',
  name: 'GitHub',
  connectedLabel: 'Connected as',
  notConnectedLabel: 'Not connected',
  connectLabel: 'Connect',
  disconnectLabel: 'Disconnect',
  onConnect: vi.fn(),
  onDisconnect: vi.fn(),
};

describe('ConnectionRow', () => {
  it('disconnected: shows the provider + "Not connected" and an outlined ink Connect (no brand fill)', () => {
    render(<ConnectionRow {...base} connected={false} />);
    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(screen.getByText('Not connected')).toBeInTheDocument();

    const btn = screen.getByRole('button', { name: 'Connect' });
    expect(btn.className).toContain('MuiButton-outlined');
    expect(btn.className).not.toContain('MuiButton-colorError');
    // No inline brand fill.
    expect(btn.style.backgroundColor).toBe('');
  });

  it('connected: shows "Connected as {user}" and an error Disconnect', () => {
    render(<ConnectionRow {...base} connected username="octocat" />);
    expect(screen.getByText('Connected as octocat')).toBeInTheDocument();

    const btn = screen.getByRole('button', { name: 'Disconnect' });
    expect(btn.className).toContain('MuiButton-colorError');
    expect(btn.style.backgroundColor).toBe('');
  });
});
