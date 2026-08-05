// @vitest-environment jsdom
import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { useForm, UseFormReturn } from 'react-hook-form';

import FormProvider from '../form-provider';
import RHFSwitch from '../rhf-switch';

const methodsRef: { current: UseFormReturn<any> | null } = { current: null };

function Harness({
  defaultValues,
  children,
}: {
  defaultValues: Record<string, unknown>;
  children: React.ReactNode;
}) {
  const methods = useForm({ defaultValues });
  useEffect(() => {
    methodsRef.current = methods;
  }, [methods]);
  return <FormProvider methods={methods}>{children}</FormProvider>;
}

describe('RHFSwitch', () => {
  it('reflects the boolean field value as the switch state', () => {
    render(
      <Harness defaultValues={{ enabled: true }}>
        <RHFSwitch name="enabled" label="Enabled" />
      </Harness>
    );

    expect(screen.getByRole('switch')).toBeChecked();
  });

  it('writes the toggled value back to the form', () => {
    render(
      <Harness defaultValues={{ enabled: false }}>
        <RHFSwitch name="enabled" label="Enabled" />
      </Harness>
    );

    const toggle = screen.getByRole('switch');
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    expect(methodsRef.current?.getValues('enabled')).toBe(true);
    expect(toggle).toBeChecked();
  });

  it('renders the field error message verbatim', () => {
    render(
      <Harness defaultValues={{ enabled: false }}>
        <RHFSwitch name="enabled" label="Enabled" />
      </Harness>
    );

    act(() => {
      methodsRef.current?.setError('enabled', { message: 'You must enable this' });
    });

    expect(screen.getByText('You must enable this')).toBeInTheDocument();
  });
});
