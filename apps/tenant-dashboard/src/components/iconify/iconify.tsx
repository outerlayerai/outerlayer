import { type Ref } from 'react';
import { Icon, type IconifyIcon } from '@iconify/react';
import Box, { type BoxProps } from '@mui/material/Box';

type IconifyProps = IconifyIcon | string;

type Props = Omit<BoxProps, 'width' | 'height' | 'ref'> & {
  icon: IconifyProps;
  width?: number | string;
  height?: number | string;
  ref?: Ref<HTMLDivElement>;
};

export default function Iconify({ icon, width = 20, height, sx, ref, ...other }: Props) {
  return (
    <Box
      component={Icon}
      icon={icon}
      sx={{
        width,
        height: height ?? width,
        flexShrink: 0,
        display: 'inline-flex',
        ...sx,
      }}
      {...other}
      ref={ref}
    />
  );
}
