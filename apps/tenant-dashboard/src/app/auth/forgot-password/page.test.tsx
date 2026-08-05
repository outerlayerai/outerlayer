// @vitest-environment node
/**
 * Forgot-password page wiring tests.
 *
 * Regression: the tab title was a leftover scaffold default
 * ("Supabase: Forgot Password") never rebranded when sibling auth pages were.
 */
import CompactLayout from '../../../layouts/compact';
import { ForgotPasswordView } from '@/features/auth';
import Layout from './layout';
import ForgotPasswordPage, { metadata } from './page';

vi.mock('@/features/auth', () => ({
  ForgotPasswordView: () => null,
}));

vi.mock('../../../layouts/compact', () => ({
  __esModule: true,
  default: () => null,
}));

describe('ForgotPasswordPage', () => {
  it('renders the forgot-password view', () => {
    const element = ForgotPasswordPage();

    expect(element.type).toBe(ForgotPasswordView);
  });

  it('titles the browser tab', () => {
    expect(metadata).toEqual({ title: 'Forgot Password' });
  });
});

describe('forgot-password layout', () => {
  it('wraps children in the compact layout', () => {
    const marker = 'child-marker';
    const element = Layout({ children: marker });

    expect(element.type).toBe(CompactLayout);
    expect(element.props.children).toBe(marker);
  });
});
