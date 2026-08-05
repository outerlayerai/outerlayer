import React from 'react';
import { Controller, useFormContext } from 'react-hook-form';

import { Theme, SxProps } from '@mui/material/styles';
import TextField, { TextFieldProps } from '@mui/material/TextField';

// ----------------------------------------------------------------------

type RHFSelectProps = TextFieldProps & {
  name: string;
  native?: boolean;
  maxHeight?: boolean | number;
  children: React.ReactNode;
  PaperPropsSx?: SxProps<Theme>;
  // Controls what the CLOSED select shows for the current value. Needed when
  // MenuItems render richer content (e.g. a label + description) that should
  // not spill into the collapsed control — return just the label here.
  renderValue?: (value: unknown) => React.ReactNode;
};

export function RHFSelect({
  name,
  native,
  maxHeight = 220,
  helperText,
  children,
  PaperPropsSx,
  onChange,
  renderValue,
  ...other
}: RHFSelectProps) {
  const { control } = useFormContext();

  return (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState: { error } }) => (
        <TextField
          {...field}
          onChange={(...arg) => {
            if (onChange) {
              onChange(...arg);
            }
            field.onChange(...arg);
          }}
          select
          fullWidth
          error={!!error}
          helperText={error ? error?.message : helperText}
          slotProps={{
            select: {
              native,
              ...(renderValue ? { renderValue } : {}),
              MenuProps: {
                slotProps: {
                  paper: {
                    sx: {
                      ...(!native && {
                        maxHeight: typeof maxHeight === 'number' ? maxHeight : 'unset',
                      }),
                      ...PaperPropsSx,
                    },
                  },
                },
              },
              sx: { textTransform: 'capitalize' },
            },
          }}
          {...other}
        >
          {children}
        </TextField>
      )}
    />
  );
}
