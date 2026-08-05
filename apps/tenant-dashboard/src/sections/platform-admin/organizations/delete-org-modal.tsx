'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
  Box,
} from '@mui/material';
import { paths } from '../../../routes/paths';
import { deleteOrganization } from './actions';

interface DeleteOrgModalProps {
  open: boolean;
  onClose: () => void;
  tenantId: string;
  organizationName: string;
  userCount: number;
  appsCount: number;
  apiKeysCount: number;
  hasActiveSubscription: boolean;
}

export function DeleteOrgModal({
  open,
  onClose,
  tenantId,
  organizationName,
  userCount,
  appsCount,
  apiKeysCount,
  hasActiveSubscription,
}: DeleteOrgModalProps) {
  const router = useRouter();
  const [confirmationName, setConfirmationName] = useState('');
  const [reason, setReason] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = () => {
    if (deleting) return; // Prevent closing while deleting
    setConfirmationName('');
    setReason('');
    setError(null);
    onClose();
  };

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);

    const result = await deleteOrganization({
      tenantId,
      confirmationName,
      reason: reason || undefined,
    });

    if (result.error) {
      setError(result.error);
      setDeleting(false);
      return;
    }

    // Success - close modal and redirect to organizations list
    setDeleting(false);
    onClose();
    router.push(paths.platformAdmin.organizations);
  };

  const isConfirmationValid =
    confirmationName.toLowerCase() === organizationName.toLowerCase();

  return (
    <Dialog
      fullWidth
      maxWidth="sm"
      open={open}
      onClose={handleClose}
      data-testid="delete-org-modal"
    >
      <DialogTitle sx={{ color: 'error.main' }}>Delete Organization</DialogTitle>
      <DialogContent>
        <Alert severity="warning" sx={{ mb: 3 }}>
          This action is <strong>irreversible</strong>. All data associated with this
          organization will be permanently deleted.
        </Alert>

        <Typography variant="body2" sx={{ mb: 2 }}>
          The following will be deleted:
        </Typography>

        <Box component="ul" sx={{ mb: 3, pl: 2 }}>
          <li>
            <Typography variant="body2">
              <strong>{userCount}</strong> user memberships
            </Typography>
          </li>
          <li>
            <Typography variant="body2">
              <strong>{appsCount}</strong> apps and all their templates
            </Typography>
          </li>
          <li>
            <Typography variant="body2">
              <strong>{apiKeysCount}</strong> API keys (will be revoked)
            </Typography>
          </li>
          {hasActiveSubscription && (
            <li>
              <Typography variant="body2" sx={{
                color: "warning.main"
              }}>
                Active Stripe subscription (will be cancelled)
              </Typography>
            </li>
          )}
        </Box>

        <Typography variant="body2" sx={{ mb: 2 }}>
          Type <strong>{organizationName}</strong> to confirm:
        </Typography>

        <TextField
          fullWidth
          value={confirmationName}
          onChange={(e) => setConfirmationName(e.target.value)}
          placeholder={organizationName}
          disabled={deleting}
          sx={{ mb: 2 }}
          autoComplete="off"
          data-testid="delete-org-name-input"
          slotProps={{
            htmlInput: { 'data-testid': 'delete-org-name-input-field' }
          }}
        />

        <TextField
          fullWidth
          multiline
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          label="Reason for deletion (optional)"
          placeholder="e.g., Customer requested account deletion"
          disabled={deleting}
          data-testid="delete-org-reason-input"
        />

        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={deleting} data-testid="delete-org-cancel-button">
          Cancel
        </Button>
        <Button
          variant="contained"
          color="error"
          loading={deleting}
          disabled={!isConfirmationValid}
          onClick={handleDelete}
          data-testid="delete-org-confirm-button"
        >
          Delete Organization
        </Button>
      </DialogActions>
    </Dialog>
  );
}
