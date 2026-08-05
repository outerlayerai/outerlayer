import React from 'react';
import { FileRejection } from 'react-dropzone';

import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import { alpha } from '@mui/material/styles';
import Typography from '@mui/material/Typography';

import { fData } from '../../utils/format-number';

import { fileData } from './file-data';

// ----------------------------------------------------------------------

type Props = {
  fileRejections: readonly FileRejection[];
};

export default function RejectionFiles({ fileRejections }: Props) {
  if (!fileRejections.length) {
    return null;
  }

  return (
    <Paper
      variant="outlined"
      sx={{
        // Spacing off the 8px grid; a dashed error-toned panel whose wash uses
        // the theme's low-emphasis fill strength (`action.selectedOpacity`).
        py: 1,
        px: 2,
        mt: 3,
        textAlign: 'left',
        borderStyle: 'dashed',
        borderColor: 'error.main',
        bgcolor: (theme) =>
          alpha(theme.palette.error.main, theme.palette.action.selectedOpacity),
      }}
    >
      {fileRejections.map(({ file, errors }) => {
        const { path, size } = fileData(file);

        return (
          <Box key={path} sx={{ my: 1 }}>
            <Typography variant="subtitle2" noWrap>
              {path} - {size ? fData(size) : ''}
            </Typography>

            {errors.map((error) => (
              <Box key={error.code} component="span" sx={{ typography: 'caption' }}>
                - {error.message}
              </Box>
            ))}
          </Box>
        );
      })}
    </Paper>
  );
}
