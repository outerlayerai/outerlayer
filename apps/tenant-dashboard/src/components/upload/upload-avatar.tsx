import { useDropzone } from 'react-dropzone';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import { alpha } from '@mui/material/styles';
import Typography from '@mui/material/Typography';

import Iconify from '@/components/iconify';

import { UploadProps } from './types';
import RejectionFiles from './errors-rejection-files';
import { placeholderFill, filledScrim, dropRingBorder } from './upload-avatar-styles';

// ----------------------------------------------------------------------

// Style-literal provenance (theme primitives / written rationale):
//  - Avatar size = spacing(18) (144px) off the 8px grid — the largest avatar in
//    the app (profile settings) and the only place this component is used.
//  - Circular geometry (borderRadius '50%') is functional, not a token.
//  - Color tokens (placeholder fill / dashed ring / filled scrim) live in
//    `upload-avatar-styles.ts` with their rationale and unit tests.
//  - The disabled dim (0.48) and hover fade (0.72) are interaction feedback
//    strengths that map to no named theme opacity, so they carry this rationale.

export default function UploadAvatar({
  error,
  file,
  disabled,
  helperText,
  sx,
  ...other
}: UploadProps) {
  const { getRootProps, getInputProps, isDragActive, isDragReject, fileRejections } = useDropzone({
    multiple: false,
    disabled,
    accept: {
      'image/*': [],
    },
    ...other,
  });

  const hasFile = !!file;

  const hasError = isDragReject || !!error;

  const imgUrl = typeof file === 'string' ? file : file?.preview;

  const renderPreview = hasFile && (
    <Box
      component="img"
      alt="avatar"
      src={imgUrl}
      sx={{
        width: 1,
        height: 1,
        borderRadius: '50%',
        objectFit: 'cover',
      }}
    />
  );

  const renderPlaceholder = (
    <Stack
      spacing={1}
      className="upload-placeholder"
      sx={(theme) => ({
        top: 0,
        left: 0,
        width: 1,
        height: 1,
        zIndex: 9,
        borderRadius: '50%',
        position: 'absolute',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'text.disabled',
        bgcolor: placeholderFill(theme),

        transition: theme.transitions.create(['opacity'], {
          duration: theme.transitions.duration.shorter,
        }),

        '&:hover': {
          opacity: 0.72,
        },

        ...(hasError && {
          color: 'error.main',
          bgcolor: alpha(theme.palette.error.main, theme.palette.action.selectedOpacity),
        }),

        ...(hasFile && {
          zIndex: 9,
          opacity: 0,
          color: 'common.white',
          bgcolor: filledScrim(theme),
        }),
      })}
    >
      <Iconify icon="solar:camera-add-bold" width={32} />

      <Typography variant="caption">{file ? 'Update photo' : 'Upload photo'}</Typography>
    </Stack>
  );

  const renderContent = (
    <Box
      sx={{
        width: 1,
        height: 1,
        overflow: 'hidden',
        borderRadius: '50%',
        position: 'relative',
      }}
    >
      {renderPreview}
      {renderPlaceholder}
    </Box>
  );

  return (
    <>
      <Box
        {...getRootProps()}
        sx={[
          (theme) => ({
            p: 1,
            m: 'auto',
            width: theme.spacing(18),
            height: theme.spacing(18),
            cursor: 'pointer',
            overflow: 'hidden',
            borderRadius: '50%',
            border: dropRingBorder(theme),
            ...(isDragActive && {
              opacity: 0.72,
            }),
            ...(disabled && {
              opacity: 0.48,
              pointerEvents: 'none',
            }),
            ...(hasError && {
              borderColor: 'error.main',
            }),
            ...(hasFile && {
              ...(hasError && {
                bgcolor: alpha(theme.palette.error.main, theme.palette.action.selectedOpacity),
              }),
              '&:hover .upload-placeholder': {
                opacity: 1,
              },
            }),
          }),
          ...(Array.isArray(sx) ? sx : [sx]),
        ]}
      >
        <input {...getInputProps()} />

        {renderContent}
      </Box>

      {helperText && helperText}

      <RejectionFiles fileRejections={fileRejections} />
    </>
  );
}
