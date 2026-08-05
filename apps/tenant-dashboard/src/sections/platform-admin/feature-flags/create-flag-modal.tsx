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
  MenuItem,
  Slider,
  Alert,
  Box,
} from '@mui/material';
import Iconify from '@/components/iconify';
import { createFeatureFlag } from './actions';
import type { FlagStrategy } from '../../../types/platform-admin';

interface CreateFlagModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function CreateFlagModal({ open, onClose, onSuccess }: CreateFlagModalProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [strategy, setStrategy] = useState<FlagStrategy>('global');
  const [rolloutPercentage, setRolloutPercentage] = useState(0);

  const handleClose = () => {
    // Reset form on close
    setKey('');
    setDescription('');
    setStrategy('global');
    setRolloutPercentage(0);
    setError(null);
    onClose();
  };

  const handleCreate = async () => {
    // Validate key
    if (!key.trim()) {
      setError('Flag key is required');
      return;
    }

    // Validate key format (lowercase, underscores, no spaces)
    const keyPattern = /^[a-z][a-z0-9_]*$/;
    if (!keyPattern.test(key)) {
      setError('Flag key must be lowercase, start with a letter, and contain only letters, numbers, and underscores');
      return;
    }

    setSaving(true);
    setError(null);

    const result = await createFeatureFlag({
      key,
      description: description || undefined,
      is_enabled: false, // Always start disabled for safety
      strategy,
      rollout_percentage: rolloutPercentage,
    });

    if (result.error) {
      setError(result.error);
    } else {
      onSuccess?.();
      handleClose();
    }

    setSaving(false);
  };

  return (
    <Dialog fullWidth maxWidth="sm" open={open} onClose={handleClose}>
      <DialogTitle>
        <Stack direction="row" spacing={1} sx={{
          alignItems: "center"
        }}>
          <Iconify icon="mdi:flag-plus" width={24} />
          <Typography variant="h6">Create Feature Flag</Typography>
        </Stack>
      </DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        <Stack spacing={3} sx={{ mt: 1 }}>
          <TextField
            fullWidth
            required
            label="Flag Key"
            placeholder="my_new_feature"
            value={key}
            onChange={(e) => setKey(e.target.value.toLowerCase())}
            helperText="Unique identifier. Use lowercase and underscores (e.g., enable_dark_mode)"
          />

          <TextField
            fullWidth
            multiline
            rows={2}
            label="Description"
            placeholder="What does this flag control?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />

          <TextField
            select
            fullWidth
            label="Rollout Strategy"
            value={strategy}
            onChange={(e) => setStrategy(e.target.value as FlagStrategy)}
          >
            <MenuItem value="global">
              <Stack>
                <Typography>Global</Typography>
                <Typography variant="caption" sx={{
                  color: "text.secondary"
                }}>
                  On/off for all users (default)
                </Typography>
              </Stack>
            </MenuItem>
            <MenuItem value="percentage">
              <Stack>
                <Typography>Percentage</Typography>
                <Typography variant="caption" sx={{
                  color: "text.secondary"
                }}>
                  Gradual rollout by percentage
                </Typography>
              </Stack>
            </MenuItem>
            <MenuItem value="targeted">
              <Stack>
                <Typography>Targeted</Typography>
                <Typography variant="caption" sx={{
                  color: "text.secondary"
                }}>
                  Only for organizations with overrides
                </Typography>
              </Stack>
            </MenuItem>
          </TextField>

          {strategy === 'percentage' && (
            <Box>
              <Typography variant="body2" sx={{ mb: 1 }}>
                Initial Rollout: {rolloutPercentage}%
              </Typography>
              <Slider
                value={rolloutPercentage}
                onChange={(_, value) => setRolloutPercentage(value as number)}
                min={0}
                max={100}
                step={5}
                marks={[
                  { value: 0, label: '0%' },
                  { value: 50, label: '50%' },
                  { value: 100, label: '100%' },
                ]}
              />
            </Box>
          )}

          <Alert severity="info" icon={<Iconify icon="mdi:information" />}>
            New flags are created in <strong>disabled</strong> state. Enable them after configuration is complete.
          </Alert>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleCreate}
          loading={saving}
          disabled={!key.trim()}
        >
          Create Flag
        </Button>
      </DialogActions>
    </Dialog>
  );
}
