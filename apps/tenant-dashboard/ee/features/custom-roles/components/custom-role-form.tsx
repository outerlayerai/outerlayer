'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Alert,
  Box,
  Typography,
} from '@mui/material';

import { PermissionPicker } from './permission-picker';
import { expandKeysToDbPermissions, dbPermissionsToKeys } from '@/utils/permissions';

type CustomRoleFormProps = {
  open: boolean;
  onClose: () => void;
  /** Receives expanded DB-level permissions (old-style table-level) */
  onSubmit: (name: string, description: string | undefined, permissions: string[]) => Promise<{ error?: string }>;
  /** initialData.permissions contains DB-level permissions (old-style) */
  initialData?: {
    name: string;
    description: string | null;
    permissions: string[];
  };
  title?: string;
  activeEntitlements?: string[];
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CustomRoleForm({ open, onClose, onSubmit, initialData, title, activeEntitlements }: CustomRoleFormProps) {
  const [name, setName] = useState(initialData?.name || '');
  const [description, setDescription] = useState(initialData?.description || '');
  // Internal state uses UI keys; initialData has DB perms that we reverse-map
  const [permissions, setPermissions] = useState<string[]>(
    initialData?.permissions ? dbPermissionsToKeys(initialData.permissions) : []
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isEdit = !!initialData;

  const handleSubmit = async () => {
    setError(null);

    // Client-side validation
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Role name is required');
      return;
    }
    if (trimmedName.length > 100) {
      setError('Role name must be 100 characters or less');
      return;
    }
    if (!/^[a-zA-Z0-9-]+$/.test(trimmedName)) {
      setError('Role name can only contain letters, numbers, and dashes');
      return;
    }
    if (description.length > 500) {
      setError('Description must be 500 characters or less');
      return;
    }
    if (permissions.length === 0) {
      setError('Select at least one permission');
      return;
    }

    setLoading(true);
    try {
      // Expand UI keys to DB-level permissions before sending to server
      const dbPermissions = expandKeysToDbPermissions(permissions);
      const result = await onSubmit(trimmedName, description || undefined, dbPermissions);
      if (result?.error) {
        setError(result.error);
      } else {
        handleClose();
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'An error occurred';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (!loading) {
      setName(initialData?.name || '');
      setDescription(initialData?.description || '');
      setPermissions(initialData?.permissions ? dbPermissionsToKeys(initialData.permissions) : []);
      setError(null);
      onClose();
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>{title || (isEdit ? 'Edit Custom Role' : 'Create Custom Role')}</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}

          <TextField
            label="Role Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Template Editor, Dashboard Viewer"
            required
            disabled={loading}
            fullWidth
            slotProps={{
              htmlInput: { maxLength: 100 }
            }}
          />

          <TextField
            label="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Brief description of what this role allows"
            multiline
            rows={2}
            disabled={loading}
            fullWidth
            slotProps={{
              htmlInput: { maxLength: 500 }
            }}
          />

          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Permissions ({permissions.length} selected)
            </Typography>
            <PermissionPicker
              selectedPermissions={permissions}
              onChange={setPermissions}
              disabled={loading}
              activeEntitlements={activeEntitlements ? new Set(activeEntitlements) : undefined}
            />
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={loading}>
          Cancel
        </Button>
        <Button
          loading={loading}
          onClick={handleSubmit}
          variant="contained"
          disabled={!name.trim() || permissions.length === 0}
        >
          {isEdit ? 'Save Changes' : 'Create Role'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
