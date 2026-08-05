// @vitest-environment node
/**
 * Verify page wiring tests.
 *
 * Regression: the tab title was a leftover scaffold default ("Supabase: Verify")
 * never rebranded when sibling auth pages were.
 */
import CompactLayout from '../../../layouts/compact';
import { VerifyView } from '@/features/auth';
import Layout from './layout';
import VerifyPage, { metadata } from './page';

vi.mock('@/features/auth', () => ({
  VerifyView: () => null,
}));

vi.mock('../../../layouts/compact', () => ({
  __esModule: true,
  default: () => null,
}));

describe('VerifyPage', () => {
  it('renders the verify view inside Suspense', () => {
    const element = VerifyPage();

    expect(element.props.children.type).toBe(VerifyView);
  });

  it('titles the browser tab', () => {
    expect(metadata).toEqual({ title: 'Verify Email' });
  });
});

describe('verify layout', () => {
  it('wraps children in the compact layout', () => {
    const marker = 'child-marker';
    const element = Layout({ children: marker });

    expect(element.type).toBe(CompactLayout);
    expect(element.props.children).toBe(marker);
  });
});
