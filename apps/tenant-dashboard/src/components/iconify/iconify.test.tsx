// @vitest-environment jsdom
import { createRef, type Ref } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { addIcon } from '@iconify/react';

// The global test setup mocks this module to `() => null`; exercise the real
// implementation here.
vi.unmock('@/components/iconify');

import Iconify from './iconify';

const ICON_NAME = 'test:square';

beforeAll(() => {
  // Register the icon offline so <Icon> resolves it synchronously with no
  // network fetch — the source width/height are deliberately not 20 so a test
  // that reads the icon's own dimensions instead of the prop would fail.
  addIcon(ICON_NAME, {
    body: '<path d="M0 0h24v24H0z" fill="currentColor" />',
    width: 24,
    height: 24,
  });
});

describe('Iconify', () => {
  it('renders the icon svg as the root element', () => {
    const { container } = render(<Iconify icon={ICON_NAME} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(container.firstElementChild).toBe(svg);
  });

  it('sizes the svg glyph to the width prop exactly', () => {
    const { container } = render(<Iconify icon={ICON_NAME} width={32} />);
    expect(container.querySelector('svg')).toHaveStyle({ width: '32px', height: '32px' });
  });

  it('applies width and height independently when both are given', () => {
    const { container } = render(<Iconify icon={ICON_NAME} width={16} height={40} />);
    expect(container.querySelector('svg')).toHaveStyle({ width: '16px', height: '40px' });
  });

  it('defaults the svg glyph size to 20 when width is omitted', () => {
    const { container } = render(<Iconify icon={ICON_NAME} />);
    expect(container.querySelector('svg')).toHaveStyle({ width: '20px', height: '20px' });
  });

  // Regression: the wrapper-Box rebuild sized only the wrapper via sx while the
  // inner svg stayed at the 20px default. sx width/height must reach the glyph.
  it('sizes the svg glyph itself when a consumer sizes via sx', () => {
    const { container } = render(<Iconify icon={ICON_NAME} sx={{ width: 32, height: 32 }} />);
    expect(container.querySelector('svg')).toHaveStyle({ width: '32px', height: '32px' });
  });

  it('lets sx={{ width: 1, height: 1 }} expand the glyph to fill its parent', () => {
    // MUI resolves sizing values between 0 and 1 to a percentage, so the glyph
    // fills a fixed-size parent (the config-navigation.tsx nav-icon pattern).
    const { container } = render(<Iconify icon={ICON_NAME} sx={{ width: 1, height: 1 }} />);
    expect(container.querySelector('svg')).toHaveStyle({ width: '100%', height: '100%' });
  });

  it('passes sx through to the root svg element', () => {
    const { container } = render(<Iconify icon={ICON_NAME} sx={{ marginTop: '13px' }} />);
    expect(container.firstElementChild).toHaveStyle({ marginTop: '13px' });
  });

  it('forwards ref to the root svg element', () => {
    const ref = createRef<SVGSVGElement>();
    const { container } = render(
      <Iconify icon={ICON_NAME} ref={ref as unknown as Ref<HTMLDivElement>} />
    );
    expect(ref.current).toBeInstanceOf(SVGSVGElement);
    expect(ref.current).toBe(container.firstElementChild);
  });
});
