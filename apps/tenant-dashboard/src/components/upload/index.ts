import dynamic from 'next/dynamic';

export * from './types';

export const UploadAvatar = dynamic(() => import('./upload-avatar'), {
  ssr: false,
});
