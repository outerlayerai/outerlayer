// @vitest-environment node
/**
 * Link-expired page wiring tests.
 *
 * The page is the landing target for every failed email-link verification
 * (/auth/confirm redirects here), so its route must keep rendering the
 * explanation view inside the compact layout.
 */
import CompactLayout from '../../../layouts/compact';
import { LinkExpiredView } from '@/features/auth';
import Layout from './layout';
import LinkExpiredPage, { metadata } from './page';

vi.mock('@/features/auth', () => ({
  LinkExpiredView: () => null,
}));

vi.mock('../../../layouts/compact', () => ({
  __esModule: true,
  default: () => null,
}));

describe('LinkExpiredPage', () => {
  it('renders the link-expired view', () => {
    const element = LinkExpiredPage();

    expect(element.type).toBe(LinkExpiredView);
  });

  it('titles the browser tab', () => {
    expect(metadata).toEqual({ title: 'Link Expired' });
  });
});

describe('link-expired layout', () => {
  it('wraps children in the compact layout', () => {
    const marker = 'child-marker';
    const element = Layout({ children: marker });

    expect(element.type).toBe(CompactLayout);
    expect(element.props.children).toBe(marker);
  });
});
