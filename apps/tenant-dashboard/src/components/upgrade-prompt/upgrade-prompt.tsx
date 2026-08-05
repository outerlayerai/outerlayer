'use client';

import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { usePathname, useParams } from 'next/navigation';
import type { EntitlementDeniedInfo } from '@/config/entitlements';

type UpgradePromptVariant = 'inline' | 'dialog' | 'banner';

interface UpgradePromptProps {
  info: EntitlementDeniedInfo;
  variant: UpgradePromptVariant;
  onUpgradeClick?: () => void;
}

export function UpgradePrompt({ info, variant, onUpgradeClick }: UpgradePromptProps) {
  const isInline = variant === 'inline';
  const severity = 'info';
  const pathname = usePathname();
  const params = useParams<{ orgName?: string }>();

  const actionLabel = info.isSelfServe ? 'Upgrade Plan' : 'Contact Sales';

  const description = info.isSelfServe
    ? `Upgrade your plan to unlock ${info.featureDisplayName}.`
    : `${info.featureDisplayName} is available on the ${info.requiredTierDisplayName} plan.`;

  // Resolve billing URL with org context
  const resolvedUrl = info.isSelfServe && params.orgName
    ? `/orgs/${params.orgName}/settings/billing`
    : info.upgradeUrl;

  // Append returnTo so users come back to the current page after checkout
  const upgradeHref = info.isSelfServe && pathname && !pathname.includes('/settings/billing')
    ? `${resolvedUrl}?returnTo=${encodeURIComponent(pathname)}`
    : resolvedUrl;

  return (
    <Alert
      severity={severity}
      variant={isInline ? 'standard' : 'filled'}
      sx={{
        width: '100%',
        ...(variant === 'banner' && { borderRadius: 0 }),
      }}
      action={
        <Button
          component="a"
          href={upgradeHref}
          color="inherit"
          size={isInline ? 'small' : 'medium'}
          variant={isInline ? 'text' : 'outlined'}
          onClick={onUpgradeClick}
          sx={{ whiteSpace: 'nowrap' }}
        >
          {actionLabel}
        </Button>
      }
    >
      {!isInline && (
        <AlertTitle>{info.featureDisplayName}</AlertTitle>
      )}
      <Typography variant={isInline ? 'caption' : 'body2'} component="span">
        {description}
      </Typography>
    </Alert>
  );
}
