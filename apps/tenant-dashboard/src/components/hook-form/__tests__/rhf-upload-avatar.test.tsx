// @vitest-environment jsdom
import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useForm, UseFormReturn } from 'react-hook-form';

import FormProvider from '../form-provider';
import { RHFUploadAvatar } from '../rhf-upload';

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

describe('RHFUploadAvatar', () => {
  it('surfaces the field error message under the avatar', () => {
    render(
      <Harness defaultValues={{ avatar: null }}>
        <RHFUploadAvatar name="avatar" />
      </Harness>
    );

    act(() => {
      methodsRef.current?.setError('avatar', { message: 'Avatar is required' });
    });

    expect(screen.getByText('Avatar is required')).toBeInTheDocument();
  });
});
