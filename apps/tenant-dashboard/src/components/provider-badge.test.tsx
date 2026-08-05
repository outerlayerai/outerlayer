// @vitest-environment jsdom
/**
 * Tests for <ProviderBadge> — the two rendering modes.
 *
 *   - Icon-only (`showLabel={false}`, the app-card repo line): a BARE brand-
 *     colored glyph at 16px (small) / 20px (medium) — NO MUI Chip, so no empty
 *     label span and no phantom right-side padding gap.
 *   - Labeled (`showLabel` default, the settings surface): the tinted Chip with
 *     the provider name — pinned here so the icon-only change can't regress it.
 *
 * Iconify is mocked to a prop-carrying span: the real @iconify/react glyph is
 * async-loaded (nothing to assert on in jsdom), so the mock surfaces the size
 * and color <ProviderBadge> actually passes.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/iconify', () => ({
  __esModule: true,
  default: ({
    icon,
    width,
    height,
    sx,
  }: {
    icon: string;
    width?: number | string;
    height?: number | string;
    sx?: { color?: string };
  }) => (
    <span
      data-testid="iconify"
      data-icon={icon}
      data-width={String(width)}
      data-height={String(height)}
      data-color={sx?.color}
    />
  ),
}));

import { ProviderBadge } from './provider-badge';

describe('ProviderBadge — icon-only mode (showLabel={false})', () => {
  it('renders a bare 16px brand-colored GitHub glyph with no Chip (small)', () => {
    const { container } = render(
      <ProviderBadge provider="github" showLabel={false} size="small" />,
    );

    // No Chip — the whole point of the icon-only mode (kills the phantom gap).
    expect(container.querySelector('.MuiChip-root')).toBeNull();

    const icon = screen.getByTestId('iconify');
    expect(icon.getAttribute('data-icon')).toBe('mdi:github');
    expect(icon.getAttribute('data-width')).toBe('16');
    expect(icon.getAttribute('data-height')).toBe('16');
    // Bare glyph in the brand color — no `!important` (no Chip to fight).
    expect(icon.getAttribute('data-color')).toBe('#24292e');
  });

  it('renders the 20px glyph at size="medium"', () => {
    render(<ProviderBadge provider="github" showLabel={false} size="medium" />);
    const icon = screen.getByTestId('iconify');
    expect(icon.getAttribute('data-width')).toBe('20');
    expect(icon.getAttribute('data-height')).toBe('20');
  });

  it('falls back to the GitHub glyph for an unrecognized provider value (e.g. a legacy row)', () => {
    const { container } = render(
      <ProviderBadge provider={'gitlab' as unknown as 'github'} showLabel={false} size="small" />,
    );
    expect(container.querySelector('.MuiChip-root')).toBeNull();
    const icon = screen.getByTestId('iconify');
    expect(icon.getAttribute('data-icon')).toBe('mdi:github');
    expect(icon.getAttribute('data-color')).toBe('#24292e');
  });
});

describe('ProviderBadge — labeled mode (default, settings surface) is unchanged', () => {
  it('renders the tinted Chip with the provider name and important-colored icon', () => {
    const { container } = render(<ProviderBadge provider="github" size="small" />);

    expect(container.querySelector('.MuiChip-root')).not.toBeNull();
    expect(screen.getByText('GitHub')).toBeInTheDocument();
    // The labeled variant keeps the `!important` icon color (it overrides the
    // Chip's own icon color); a regression here would drift the settings pill.
    expect(screen.getByTestId('iconify').getAttribute('data-color')).toBe(
      '#24292e !important',
    );
  });
});
