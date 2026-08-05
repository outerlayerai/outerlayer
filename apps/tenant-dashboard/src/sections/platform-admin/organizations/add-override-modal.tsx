'use client';

import { useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  ENTITLEMENTS,
  type EntitlementKey,
} from '@/config/entitlements';
import { setEntitlementOverride } from './entitlement-actions';

interface AddOverrideModalProps {
  open: boolean;
  onClose: () => void;
  tenantId: string;
  organizationName: string;
  existingOverrideKeys: EntitlementKey[];
  onSuccess: () => void;
}

const ALL_KEYS = Object.keys(ENTITLEMENTS) as EntitlementKey[];

export function AddOverrideModal({
  open,
  onClose,
  tenantId,
  organizationName,
  existingOverrideKeys,
  onSuccess,
}: AddOverrideModalProps) {
  const [selectedKey, setSelectedKey] = useState<EntitlementKey | ''>('');
  const [value, setValue] = useState<string>('');
  const [boolValue, setBoolValue] = useState(true);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableKeys = ALL_KEYS.filter((k) => !existingOverrideKeys.includes(k));
  const selectedDef = selectedKey ? ENTITLEMENTS[selectedKey] : null;

  const handleClose = () => {
    if (saving) return;
    setSelectedKey('');
    setValue('');
    setBoolValue(true);
    setReason('');
    setError(null);
    onClose();
  };

  const handleSave = async () => {
    if (!selectedKey) return;
    if (!reason.trim()) {
      setError('A reason is required for override auditing.');
      return;
    }

    let parsedValue: boolean | number | string;
    if (selectedDef?.type === 'boolean') {
      parsedValue = boolValue;
    } else if (selectedDef?.type === 'numeric') {
      parsedValue = Number(value);
      if (isNaN(parsedValue)) {
        setError('Value must be a number. Use -1 for unlimited.');
        return;
      }
    } else {
      parsedValue = value;
    }

    setSaving(true);
    setError(null);
    const result = await setEntitlementOverride(
      tenantId,
      selectedKey,
      parsedValue,
      reason.trim(),
      organizationName,
    );
    if (result.error) {
      setError(result.error);
      setSaving(false);
      return;
    }
    setSaving(false);
    handleClose();
    onSuccess();
  };

  return (
    <Dialog fullWidth maxWidth="sm" open={open} onClose={handleClose}>
      <DialogTitle>Add Entitlement Override</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{
          pt: 1
        }}>
          {error && <Alert severity="error">{error}</Alert>}

          <TextField
            select
            label="Entitlement"
            value={selectedKey}
            onChange={(e) => {
              setSelectedKey(e.target.value as EntitlementKey);
              setValue('');
              setBoolValue(true);
            }}
            fullWidth
          >
            {availableKeys.map((key) => (
              <MenuItem key={key} value={key}>
                {ENTITLEMENTS[key].displayName} ({key})
              </MenuItem>
            ))}
          </TextField>

          {selectedDef?.type === 'boolean' && (
            <FormControlLabel
              control={
                <Checkbox
                  checked={boolValue}
                  onChange={(e) => setBoolValue(e.target.checked)}
                />
              }
              label="Enabled"
            />
          )}

          {selectedDef?.type === 'numeric' && (
            <TextField
              label="Value (-1 for unlimited)"
              type="number"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              fullWidth
              helperText="Use -1 to represent unlimited"
            />
          )}

          {selectedDef?.type === 'categorical' && (
            <TextField
              label="Value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              fullWidth
            />
          )}

          <TextField
            label="Reason (required)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            fullWidth
            multiline
            rows={2}
            helperText="This is recorded in the audit log"
          />

          {selectedDef && (
            <Typography variant="caption" sx={{
              color: "text.secondary"
            }}>
              Type: {selectedDef.type} | Display: {selectedDef.displayName}
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={saving}>Cancel</Button>
        <Button
          loading={saving}
          onClick={handleSave}
          variant="contained"
          disabled={!selectedKey || !reason.trim()}
        >
          Set Override
        </Button>
      </DialogActions>
    </Dialog>
  );
}
