// @vitest-environment jsdom
import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useForm, UseFormReturn } from 'react-hook-form';

import FormProvider from '../../hook-form/form-provider';
import TermsCheckbox from '../terms-checkbox';

const methodsRef: { current: UseFormReturn<any> | null } = { current: null };

function Harness() {
  const methods = useForm({ defaultValues: { agreedToTerms: false } });
  useEffect(() => {
    methodsRef.current = methods;
  }, [methods]);
  return (
    <FormProvider methods={methods}>
      <TermsCheckbox />
    </FormProvider>
  );
}

describe('TermsCheckbox error wiring', () => {
  it('carries no error signal until the field is invalid', () => {
    render(<Harness />);
    const input = screen.getByRole('checkbox');
    // Clean state: no aria-invalid on the input and no Mui-error on the box, so
    // the theme's error recolor does not fire.
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(input.closest('.MuiCheckbox-root')?.classList.contains('Mui-error')).toBe(false);
  });

  it('marks the checkbox invalid so the theme can paint the error box', () => {
    render(<Harness />);
    act(() => {
      methodsRef.current?.setError('agreedToTerms', {
        message: 'You must agree to the terms to continue',
      });
    });

    const input = screen.getByRole('checkbox');
    // aria-invalid on the input (a11y) AND Mui-error on the box (the theme hook
    // that draws the outline in error.main) — both are the fix; before it, the
    // box stayed neutral grey on validation failure.
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.closest('.MuiCheckbox-root')?.classList.contains('Mui-error')).toBe(true);
    expect(
      screen.getByText('You must agree to the terms to continue'),
    ).toBeInTheDocument();
  });

  it('forwards the field name and ref to the input, and reports blur back to the form', async () => {
    render(<Harness />);
    const input = screen.getByRole('checkbox');

    // `name` proves the Controller field's name reached the DOM input, not
    // just the checked/onChange pair.
    expect(input.getAttribute('name')).toBe('agreedToTerms');

    // `inputRef` proves the field's DOM ref is the same node RHF's own
    // imperative API operates on — this is what `shouldFocusError` relies on
    // to focus the field after a failed submit. `setFocus` defers the actual
    // `.focus()` call to a macrotask, so the assertion has to wait one too.
    act(() => {
      methodsRef.current?.setFocus('agreedToTerms');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(input);

    // `onBlur` proves blur is reported back to the form, not swallowed by
    // the presentational layer — RHF only marks a field touched once its
    // registered onBlur fires.
    expect(methodsRef.current?.formState.touchedFields.agreedToTerms).toBeUndefined();
    act(() => {
      fireEvent.blur(input);
    });
    expect(methodsRef.current?.formState.touchedFields.agreedToTerms).toBe(true);
  });
});
