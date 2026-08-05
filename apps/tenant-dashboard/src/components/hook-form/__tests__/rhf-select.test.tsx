// @vitest-environment jsdom
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useForm, UseFormReturn } from 'react-hook-form';
import MenuItem from '@mui/material/MenuItem';

import FormProvider from '../form-provider';
import { RHFSelect } from '../rhf-select';

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

describe('RHFSelect', () => {
  it('displays the currently selected option value', () => {
    render(
      <Harness defaultValues={{ color: 'green' }}>
        <RHFSelect name="color" label="Color">
          <MenuItem value="red">red</MenuItem>
          <MenuItem value="green">green</MenuItem>
        </RHFSelect>
      </Harness>
    );

    expect(screen.getByText('green')).toBeInTheDocument();
  });

  it('renders the field error message verbatim', () => {
    render(
      <Harness defaultValues={{ color: '' }}>
        <RHFSelect name="color" label="Color">
          <MenuItem value="red">red</MenuItem>
        </RHFSelect>
      </Harness>
    );

    act(() => {
      methodsRef.current?.setError('color', { message: 'Pick a color' });
    });

    expect(screen.getByText('Pick a color')).toBeInTheDocument();
  });

  it('runs the caller-supplied onChange in addition to updating the form', () => {
    const onChange = vi.fn();
    render(
      <Harness defaultValues={{ color: 'red' }}>
        <RHFSelect name="color" label="Color" native onChange={onChange}>
          <option value="red">red</option>
          <option value="green">green</option>
        </RHFSelect>
      </Harness>
    );

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    // native select exposes a real <select>; change it directly.
    act(() => {
      select.value = 'green';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(methodsRef.current?.getValues('color')).toBe('green');
  });
});
