import { DropzoneOptions } from 'react-dropzone';

import { Theme, SxProps } from '@mui/material/styles';

// ----------------------------------------------------------------------

interface CustomFile extends File {
  path?: string;
  preview?: string;
  lastModifiedDate?: Date;
}

export interface UploadProps extends DropzoneOptions {
  error?: boolean;
  sx?: SxProps<Theme>;
  helperText?: React.ReactNode;
  file?: CustomFile | string | null;
}
