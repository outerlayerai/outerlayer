// @vitest-environment jsdom
/**
 * Accessibility baseline for EmptyAppAccess.
 *
 * This is the full-page state a user sees when they hit a section without the
 * required permission — billing, app settings, environments, etc. It must be
 * navigable by keyboard and screen reader: a user who has been kicked out of
 * a feature deserves a clear, accessible explanation, not a wall of unlabeled
 * MUI icons.
 */
import { render } from '@testing-library/react';
import { describe, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-helpers/a11y';
import { EmptyAppAccess } from '../empty-app-access';

describe('EmptyAppAccess — a11y', () => {
  it('has no a11y violations in its default render', async () => {
    const { container } = render(<EmptyAppAccess />);
    await expectNoA11yViolations(container);
  });
});
