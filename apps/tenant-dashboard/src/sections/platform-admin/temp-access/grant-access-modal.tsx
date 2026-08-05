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
import Iconify from '@/components/iconify';
import { grantTempAccess } from './actions';
import { setLastActiveOrgAction } from '@/features/org-lifecycle/action-adapters';
import { paths } from '../../../routes/paths';

interface GrantAccessModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  tenantId: string;
  organizationName: string;
}

export function GrantAccessModal({
  open,
  onClose,
  onSuccess,
  tenantId,
  organizationName,
}: GrantAccessModalProps) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [customerPermissionConfirmed, setCustomerPermissionConfirmed] = useState(false);
  const [granting, setGranting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ expiresAt: string; orgName: string } | null>(null);

  const handleClose = () => {
    if (granting) return;
    setReason('');
    setCustomerPermissionConfirmed(false);
    setError(null);
    setSuccess(null);
    onClose();
  };

  const handleGrant = async () => {
    if (!reason.trim()) {
      setError('You must provide a reason for access');
      return;
    }

    if (!customerPermissionConfirmed) {
      setError('You must confirm you have received customer permission');
      return;
    }

    setGranting(true);
    setError(null);

    const result = await grantTempAccess({
      tenantId,
      reason: reason.trim(),
      customerPermissionConfirmed,
    });

    if (result.error) {
      setError(result.error);
      setGranting(false);
      return;
    }

    if (result.data) {
      // Record the customer's tenant as last-active; the grant already
      // inserted the membership row, so navigation alone scopes the next
      // request.
      const preferenceResult = await setLastActiveOrgAction(tenantId);
      if (preferenceResult.error) {
        setError(`Access granted but failed to record active org: ${preferenceResult.error}`);
        setGranting(false);
        return;
      }

      setSuccess({ expiresAt: result.data.expiresAt, orgName: organizationName });
      setGranting(false);
      onSuccess?.();
    }
  };

  const handleGoToOrg = () => {
    if (!success) return;
    router.push(paths.orgs.org.apps.root(success.orgName));
  };

  const formatExpiry = (isoString: string) => {
    return new Date(isoString).toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  };

  return (
    <Dialog fullWidth maxWidth="sm" open={open} onClose={handleClose}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Iconify icon="mdi:key-plus" width={24} />
        Grant Temporary Access
      </DialogTitle>

      <DialogContent>
        {success ? (
          <Box>
            <Alert severity="success" sx={{ mb: 2 }}>
              Access granted successfully!
            </Alert>
            <Typography variant="body2">
              You now have <strong>read-only</strong> access to{' '}
              <strong>{organizationName}</strong>.
            </Typography>
            <Typography variant="body2" sx={{ mt: 1 }}>
              Access expires: <strong>{formatExpiry(success.expiresAt)}</strong>
            </Typography>
            <Typography variant="body2" sx={{ mt: 2, color: 'text.secondary' }}>
              Organization owners have been notified of this access grant.
            </Typography>
          </Box>
        ) : (
          <Box>
            <Alert severity="info" sx={{ mb: 3 }}>
              This will grant you <strong>24-hour read-only</strong> access to{' '}
              <strong>{organizationName}</strong>.
            </Alert>

            <Typography variant="body2" sx={{ mb: 2 }}>
              You will be able to:
            </Typography>

            <Box component="ul" sx={{ mb: 3, pl: 2 }}>
              <li>
                <Typography variant="body2">View traces, logs, and execution history</Typography>
              </li>
              <li>
                <Typography variant="body2">View apps, templates, and prompt configurations</Typography>
              </li>
              <li>
                <Typography variant="body2">View files and uploaded assets</Typography>
              </li>
            </Box>

            <Typography variant="body2" sx={{ mb: 2 }}>
              You will <strong>not</strong> be able to:
            </Typography>

            <Box component="ul" sx={{ mb: 3, pl: 2 }}>
              <li>
                <Typography variant="body2">Create, edit, or delete any data</Typography>
              </li>
              <li>
                <Typography variant="body2">View or manage API keys</Typography>
              </li>
              <li>
                <Typography variant="body2">Modify settings or billing</Typography>
              </li>
              <li>
                <Typography variant="body2">Invite or remove users</Typography>
              </li>
            </Box>

            <Box
              sx={{
                mb: 3,
                p: 2,
                bgcolor: 'warning.lighter',
                borderRadius: 1,
                border: '1px solid',
                borderColor: 'warning.light',
              }}
            >
              <FormControlLabel
                control={
                  <Checkbox
                    checked={customerPermissionConfirmed}
                    onChange={(e) => setCustomerPermissionConfirmed(e.target.checked)}
                    disabled={granting}
                    color="warning"
                  />
                }
                label={
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    I confirm that I have received permission from the customer to access their
                    organization data
                  </Typography>
                }
              />
            </Box>

            <TextField
              fullWidth
              required
              multiline
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              label="Reason for access"
              placeholder="e.g., Investigating support ticket #12345"
              disabled={granting}
              error={!reason.trim() && reason !== ''}
              helperText="Required - describe why you need access"
            />

            {error && (
              <Alert severity="error" sx={{ mt: 2 }}>
                {error}
              </Alert>
            )}
          </Box>
        )}
      </DialogContent>

      <DialogActions>
        {success ? (
          <>
            <Button onClick={handleClose}>
              Close
            </Button>
            <Button onClick={handleGoToOrg} variant="contained" startIcon={<Iconify icon="mdi:arrow-right" />}>
              Go to Organization
            </Button>
          </>
        ) : (
          <>
            <Button onClick={handleClose} disabled={granting}>
              Cancel
            </Button>
            <Button
              variant="contained"
              loading={granting}
              disabled={!customerPermissionConfirmed || !reason.trim()}
              onClick={handleGrant}
              startIcon={<Iconify icon="mdi:key-plus" />}
            >
              Grant Access
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
