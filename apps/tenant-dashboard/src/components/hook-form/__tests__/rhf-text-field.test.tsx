// @vitest-environment jsdom
import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { useForm, UseFormReturn } from 'react-hook-form';

import FormProvider from '../form-provider';
import RHFTextField from '../rhf-text-field';

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

describe('RHFTextField', () => {
  it('binds the field value and writes plain string input back to the form', () => {
    render(
      <Harness defaultValues={{ title: 'hello' }}>
        <RHFTextField name="title" label="Title" />
      </Harness>
    );

    const input = screen.getByLabelText('Title') as HTMLInputElement;
    expect(input.value).toBe('hello');

    fireEvent.change(input, { target: { value: 'world' } });
    expect(methodsRef.current?.getValues('title')).toBe('world');
  });

  it('coerces number-typed input to a number and shows 0 as an empty field', () => {
    render(
      <Harness defaultValues={{ amount: 0 }}>
        <RHFTextField name="amount" label="Amount" type="number" />
      </Harness>
    );

    const input = screen.getByLabelText('Amount') as HTMLInputElement;
    // A zero default renders blank so the placeholder shows instead of "0".
    expect(input.value).toBe('');

    fireEvent.change(input, { target: { value: '42' } });
    const value = methodsRef.current?.getValues('amount');
    expect(value).toBe(42);
    expect(typeof value).toBe('number');
  });

  it('renders the field error message verbatim and marks the input invalid', () => {
    render(
      <Harness defaultValues={{ title: '' }}>
        <RHFTextField name="title" label="Title" />
      </Harness>
    );

    act(() => {
      methodsRef.current?.setError('title', { message: 'Title is required' });
    });

    expect(screen.getByText('Title is required')).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows the passed helperText when there is no error', () => {
    render(
      <Harness defaultValues={{ title: '' }}>
        <RHFTextField name="title" label="Title" helperText="Max 40 characters" />
      </Harness>
    );

    expect(screen.getByText('Max 40 characters')).toBeInTheDocument();
  });
});
