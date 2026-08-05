/**
 * Accessibility test helper.
 *
 * Wraps `jest-axe` so component tests can assert WCAG 2.1 AA compliance with
 * one call instead of three. The matcher itself is registered globally in
 * `unit-test-setup.ts`; this module exists so test files don't have to know
 * about `jest-axe` as a library — they import a single named function from
 * the test-helpers barrel and the rest is detail.
 *
 * Pattern:
 *
 *   import { render } from '@testing-library/react';
 *   import { expectNoA11yViolations } from '@/test-helpers/a11y';
 *
 *   it('has no a11y violations in the default state', async () => {
 *     const { container } = render(<MyComponent />);
 *     await expectNoA11yViolations(container);
 *   });
 *
 * For interactive components, render the relevant state (open dialog, expand
 * popover, fill a form) BEFORE the assertion — axe sees the live DOM, so any
 * hidden subtree is excluded by default.
 */

import { axe, type JestAxeConfigureOptions } from 'jest-axe';

/**
 * Run axe against a rendered container and assert zero violations.
 *
 * @param container - The DOM node returned by `render(...).container`.
 * @param options - Optional axe configuration (e.g. disabling specific rules
 *                  for components that legitimately can't satisfy them — keep
 *                  these to a minimum and always leave a comment with the
 *                  WCAG rationale).
 */
export async function expectNoA11yViolations(
  container: Element,
  options?: JestAxeConfigureOptions,
): Promise<void> {
  const results = await axe(container, options);
  // `toHaveNoViolations` is registered in unit-test-setup.ts. The matcher
  // formats the violation list with rule id, impact, help URL, and the
  // offending HTML — failing tests get a clickable debug trail.
  expect(results).toHaveNoViolations();
}
