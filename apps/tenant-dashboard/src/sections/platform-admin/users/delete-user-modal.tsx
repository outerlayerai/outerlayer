'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  TextField,
  Typography,
  Box,
} from '@mui/material';
import { paths } from '../../../routes/paths';
import { deleteUser } from './actions';

interface DeleteUserModalProps {
  open: boolean;
  onClose: () => void;
  userId: string;
  userEmail: string;
  userName: string | null;
  organizationCount: number;
  soleOwnerOrgs: Array<{ tenant_id: string; organization_name: string }>;
  isPlatformAdmin: boolean;
}

export function DeleteUserModal({
  open,
  onClose,
  userId,
  userEmail,
  userName,
  organizationCount,
  soleOwnerOrgs,
  isPlatformAdmin,
}: DeleteUserModalProps) {
  const router = useRouter();
  const [confirmationEmail, setConfirmationEmail] = useState('');
  const [reason, setReason] = useState('');
  const [acknowledgeOrphaned, setAcknowledgeOrphaned] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasSoleOwnerOrgs = soleOwnerOrgs.length > 0;

  const handleClose = () => {
    if (deleting) return; // Prevent closing while deleting
    setConfirmationEmail('');
    setReason('');
    setAcknowledgeOrphaned(false);
    setError(null);
    onClose();
  };

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);

    const result = await deleteUser({
      userId,
      confirmationEmail,
      acknowledgeOrphanedOrgs: hasSoleOwnerOrgs ? acknowledgeOrphaned : undefined,
      reason: reason || undefined,
    });

    if (result.error) {
      setError(result.error);
      setDeleting(false);
      return;
    }

    // Success - close modal and redirect to users list
    setDeleting(false);
    onClose();
    router.push(paths.platformAdmin.users);
  };

  const isConfirmationValid =
    confirmationEmail.toLowerCase() === userEmail.toLowerCase();

  const canDelete =
    isConfirmationValid && (!hasSoleOwnerOrgs || acknowledgeOrphaned);

  return (
    <Dialog
      fullWidth
      maxWidth="sm"
      open={open}
      onClose={handleClose}
      data-testid="delete-user-modal"
    >
      <DialogTitle sx={{ color: 'error.main' }}>Delete User</DialogTitle>
      <DialogContent>
        <Alert severity="warning" sx={{ mb: 3 }}>
          This action is <strong>irreversible</strong>. The user and all their data
          will be permanently deleted.
        </Alert>

        <Typography variant="body2" sx={{ mb: 2 }}>
          Deleting <strong>{userName || userEmail}</strong> will:
        </Typography>

        <Box component="ul" sx={{ mb: 3, pl: 2 }}>
          <li>
            <Typography variant="body2">
              Remove user from <strong>{organizationCount}</strong> organization(s)
            </Typography>
          </li>
          <li>
            <Typography variant="body2">
              Delete their profile and authentication data
            </Typography>
          </li>
          {isPlatformAdmin && (
            <li>
              <Typography variant="body2" sx={{
                color: "warning.main"
              }}>
                Remove their <strong>Platform Admin</strong> role
              </Typography>
            </li>
          )}
        </Box>

        {hasSoleOwnerOrgs && (
          <Alert severity="error" sx={{ mb: 3 }}>
            <Typography variant="subtitle2" gutterBottom>
              Warning: Orphaned Organizations
            </Typography>
            <Typography variant="body2" sx={{ mb: 1 }}>
              This user is the <strong>sole owner</strong> of the following
              organization(s). Deleting this user will leave these organizations
              without an owner:
            </Typography>
            <Box component="ul" sx={{ pl: 2, mb: 1 }}>
              {soleOwnerOrgs.map((org) => (
                <li key={org.tenant_id}>
                  <Typography variant="body2">
                    <strong>{org.organization_name}</strong>
                  </Typography>
                </li>
              ))}
            </Box>
            <FormControlLabel
              control={
                <Checkbox
                  checked={acknowledgeOrphaned}
                  onChange={(e) => setAcknowledgeOrphaned(e.target.checked)}
                  disabled={deleting}
                  data-testid="delete-user-acknowledge-checkbox"
                />
              }
              label={
                <Typography variant="body2">
                  I understand these organizations will become orphaned
                </Typography>
              }
            />
          </Alert>
        )}

        <Typography variant="body2" sx={{ mb: 2 }}>
          Type <strong>{userEmail}</strong> to confirm:
        </Typography>

        <TextField
          fullWidth
          value={confirmationEmail}
          onChange={(e) => setConfirmationEmail(e.target.value)}
          placeholder={userEmail}
          disabled={deleting}
          sx={{ mb: 2 }}
          autoComplete="off"
          data-testid="delete-user-email-input"
          slotProps={{
            htmlInput: { 'data-testid': 'delete-user-email-input-field' }
          }}
        />

        <TextField
          fullWidth
          multiline
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          label="Reason for deletion (optional)"
          placeholder="e.g., User requested account deletion"
          disabled={deleting}
          data-testid="delete-user-reason-input"
        />

        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={deleting} data-testid="delete-user-cancel-button">
          Cancel
        </Button>
        <Button
          variant="contained"
          color="error"
          loading={deleting}
          disabled={!canDelete}
          onClick={handleDelete}
          data-testid="delete-user-confirm-button"
        >
          Delete User
        </Button>
      </DialogActions>
    </Dialog>
  );
}
