'use client';

import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Typography,
  Stack,
  Button,
  Alert,
} from '@mui/material';
import Iconify from '@/components/iconify';
import { useTranslate } from '@outerlayer/locales';

interface UpgradeConfirmationDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  loading: boolean;
  currentTierName: string;
  newTierName: string;
  newTierPricing: string | null;
}

export function UpgradeConfirmationDialog({
  open,
  onClose,
  onConfirm,
  loading,
  currentTierName,
  newTierName,
  newTierPricing,
}: UpgradeConfirmationDialogProps) {
  useTranslate();

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Stack direction="row" spacing={1} sx={{
          alignItems: "center"
        }}>
          <Iconify icon="mdi:arrow-up-circle" width={24} />
          <Typography variant="h6">Confirm Upgrade</Typography>
        </Stack>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={3}>
          <Alert severity="info" icon={<Iconify icon="mdi:information" />}>
            You are about to upgrade your plan. Your billing will be prorated.
          </Alert>

          <Stack direction="row" spacing={2} sx={{
            alignItems: "center"
          }}>
            <Stack
              sx={{
                alignItems: "center",
                flex: 1
              }}>
              <Typography variant="body2" sx={{
                color: "text.secondary"
              }}>
                Current Plan
              </Typography>
              <Typography variant="h6">{currentTierName}</Typography>
            </Stack>

            <Iconify icon="mdi:arrow-right" width={24} color="text.secondary" />

            <Stack
              sx={{
                alignItems: "center",
                flex: 1
              }}>
              <Typography variant="body2" sx={{
                color: "text.secondary"
              }}>
                New Plan
              </Typography>
              <Typography variant="h6" sx={{
                color: "primary.main"
              }}>
                {newTierName}
              </Typography>
              {newTierPricing && (
                <Typography variant="body2" sx={{
                  color: "text.secondary"
                }}>
                  {newTierPricing}
                </Typography>
              )}
            </Stack>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={loading}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={onConfirm}
          loading={loading}
          startIcon={<Iconify icon="mdi:arrow-up-circle" />}
        >
          Upgrade to {newTierName}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
