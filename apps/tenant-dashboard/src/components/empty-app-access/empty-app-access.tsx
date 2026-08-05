import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { SxProps, Theme } from '@mui/material/styles';

import Iconify from '@/components/iconify';
import { useTranslate } from '@outerlayer/locales';

// ----------------------------------------------------------------------

type EmptyAppAccessProps = {
  sx?: SxProps<Theme>;
};

/**
 * Empty state shown to app-scoped users who have no accessible apps.
 *
 * This occurs when a user has app_member_role records (is app-scoped) but
 * none of their assigned apps exist in the current app list — e.g., all
 * assigned apps were deleted or the user was assigned roles on apps that
 * no longer exist.
 */
export function EmptyAppAccess({ sx }: EmptyAppAccessProps) {
  const { t } = useTranslate();

  return (
    <Stack
      sx={{
        alignItems: "center",
        justifyContent: "center",
        py: 10,
        px: 3,
        borderRadius: 2,
        bgcolor: "background.neutral",
        border: "1px dashed",
        borderColor: "divider",
        ...sx
      }}>
      <Iconify
        icon="solar:lock-keyhole-bold-duotone"
        width={64}
        sx={{ color: 'text.disabled', mb: 2 }}
      />
      <Typography
        variant="h6"
        sx={{ color: 'text.secondary', textAlign: 'center' }}
      >
        {t('app.emptyAppAccess.title')}
      </Typography>
      <Typography
        variant="body2"
        sx={{ mt: 1, color: 'text.disabled', textAlign: 'center', maxWidth: 360 }}
      >
        {t('app.emptyAppAccess.description')}
      </Typography>
    </Stack>
  );
}
