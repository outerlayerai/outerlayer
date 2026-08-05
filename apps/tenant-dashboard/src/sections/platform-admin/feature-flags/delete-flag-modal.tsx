'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Stack,
  Typography,
  TextField,
  Alert,
} from '@mui/material';
import Iconify from '@/components/iconify';
import { deleteFeatureFlag } from './actions';

interface DeleteFlagModalProps {
  open: boolean;
  onClose: () => void;
  flagId: string | null;
  flagKey: string | null;
  overrideCount?: number;
  onSuccess?: () => void;
}

export function DeleteFlagModal({
  open,
  onClose,
  flagId,
  flagKey,
  overrideCount = 0,
  onSuccess,
}: DeleteFlagModalProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState('');

  const handleClose = () => {
    setConfirmKey('');
    setError(null);
    onClose();
  };

  const handleDelete = async () => {
    if (!flagId || !flagKey) return;

    // Validate confirmation matches
    if (confirmKey !== flagKey) {
      setError('Flag key does not match. Please type the exact key to confirm deletion.');
      return;
    }

    setDeleting(true);
    setError(null);

    const result = await deleteFeatureFlag(flagId);

    if (result.error) {
      setError(result.error);
    } else {
      onSuccess?.();
      handleClose();
    }

    setDeleting(false);
  };

  const isConfirmValid = confirmKey === flagKey;

  return (
    <Dialog fullWidth maxWidth="sm" open={open} onClose={handleClose}>
      <DialogTitle>
        <Stack direction="row" spacing={1} sx={{
          alignItems: "center"
        }}>
          <Iconify icon="mdi:flag-remove" width={24} color="error.main" />
          <Typography variant="h6" sx={{
            color: "error.main"
          }}>
            Delete Feature Flag
          </Typography>
        </Stack>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={3} sx={{ mt: 1 }}>
          <Alert severity="warning" icon={<Iconify icon="mdi:alert" />}>
            <Typography variant="body2">
              <strong>This action cannot be undone.</strong>
            </Typography>
            <Typography variant="body2" sx={{ mt: 1 }}>
              Deleting this flag will:
            </Typography>
            <ul style={{ margin: '8px 0', paddingLeft: '20px' }}>
              <li>Remove the flag from all feature flag evaluation</li>
              {overrideCount > 0 && (
                <li>
                  Delete <strong>{overrideCount}</strong> organization override{overrideCount !== 1 ? 's' : ''}
                </li>
              )}
              <li>Potentially break features that depend on this flag</li>
            </ul>
          </Alert>

          <Stack spacing={1}>
            <Typography variant="body2">
              To confirm, type <strong>{flagKey}</strong> below:
            </Typography>
            <TextField
              fullWidth
              placeholder={flagKey || ''}
              value={confirmKey}
              onChange={(e) => setConfirmKey(e.target.value)}
              error={confirmKey.length > 0 && !isConfirmValid}
              helperText={confirmKey.length > 0 && !isConfirmValid ? 'Key does not match' : ''}
              autoComplete="off"
            />
          </Stack>

          {error && (
            <Alert severity="error">
              {error}
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={deleting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color="error"
          onClick={handleDelete}
          loading={deleting}
          disabled={!isConfirmValid}
          startIcon={<Iconify icon="mdi:delete" />}
        >
          Delete Flag
        </Button>
      </DialogActions>
    </Dialog>
  );
}
