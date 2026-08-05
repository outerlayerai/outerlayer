'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Stack,
  Typography,
  TextField,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
  Alert,
  LinearProgress,
  FormControl,
  FormLabel,
  RadioGroup,
  FormControlLabel,
  Radio,
} from '@mui/material';
import Iconify from '@/components/iconify';
import { listOrganizations } from '../organizations/actions';
import { setFlagOverride } from './actions';
import type { OrganizationListItem } from '../../../types/platform-admin';

interface OrgOverrideManagerProps {
  open: boolean;
  onClose: () => void;
  flagId: string | null;
  onSuccess?: () => void;
}

export function OrgOverrideManager({ open, onClose, flagId, onSuccess }: OrgOverrideManagerProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [organizations, setOrganizations] = useState<OrganizationListItem[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<OrganizationListItem | null>(null);
  const [overrideValue, setOverrideValue] = useState<'enabled' | 'disabled'>('enabled');

  const fetchOrganizations = useCallback(async (search: string) => {
    setLoading(true);
    setError(null);

    const result = await listOrganizations({
      page: 1,
      pageSize: 20,
      search: search || undefined,
    });

    if (result.error) {
      setError(result.error);
    } else if (result.data) {
      setOrganizations(result.data.items);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) {
      fetchOrganizations('');
      setSearchQuery('');
      setSelectedOrg(null);
      setOverrideValue('enabled');
    }
  }, [open, fetchOrganizations]);

  useEffect(() => {
    const debounce = setTimeout(() => {
      if (open) {
        fetchOrganizations(searchQuery);
      }
    }, 300);

    return () => clearTimeout(debounce);
  }, [searchQuery, open, fetchOrganizations]);

  const handleSave = async () => {
    if (!flagId || !selectedOrg) return;

    setSaving(true);
    setError(null);

    const result = await setFlagOverride({
      flagId,
      tenantId: selectedOrg.tenant_id,
      isEnabled: overrideValue === 'enabled',
    });

    if (result.error) {
      setError(result.error);
    } else {
      onSuccess?.();
      onClose();
    }

    setSaving(false);
  };

  return (
    <Dialog fullWidth maxWidth="sm" open={open} onClose={onClose}>
      <DialogTitle>
        <Stack direction="row" spacing={1} sx={{
          alignItems: "center"
        }}>
          <Iconify icon="mdi:office-building-plus" width={24} />
          <Typography variant="h6">Add Organization Override</Typography>
        </Stack>
      </DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        <Stack spacing={3} sx={{ mt: 1 }}>
          {/* Search Organizations */}
          <TextField
            fullWidth
            placeholder="Search organizations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <Iconify icon="eva:search-fill" sx={{ color: 'text.disabled' }} />
                  </InputAdornment>
                ),
              }
            }}
          />

          {/* Organization List */}
          {loading && <LinearProgress />}

          {!loading && organizations.length === 0 && (
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
                textAlign: "center",
                py: 2
              }}>
              {searchQuery ? 'No organizations found' : 'Type to search organizations'}
            </Typography>
          )}

          {!loading && organizations.length > 0 && (
            <List
              sx={{
                maxHeight: 200,
                overflow: 'auto',
                border: 1,
                borderColor: 'divider',
                borderRadius: 1,
              }}
            >
              {organizations.map((org) => (
                <ListItemButton
                  key={org.tenant_id}
                  selected={selectedOrg?.tenant_id === org.tenant_id}
                  onClick={() => setSelectedOrg(org)}
                >
                  <ListItemText
                    primary={org.organization_name}
                    secondary={org.company_name !== org.organization_name ? org.company_name : undefined}
                  />
                </ListItemButton>
              ))}
            </List>
          )}

          {/* Override Value Selection */}
          {selectedOrg && (
            <FormControl component="fieldset">
              <FormLabel component="legend">
                Override value for <strong>{selectedOrg.organization_name}</strong>
              </FormLabel>
              <RadioGroup
                value={overrideValue}
                onChange={(e) => setOverrideValue(e.target.value as 'enabled' | 'disabled')}
              >
                <FormControlLabel
                  value="enabled"
                  control={<Radio />}
                  label={
                    <Stack>
                      <Typography variant="body2">Enabled</Typography>
                      <Typography variant="caption" sx={{
                        color: "text.secondary"
                      }}>
                        Force flag ON for this organization
                      </Typography>
                    </Stack>
                  }
                />
                <FormControlLabel
                  value="disabled"
                  control={<Radio />}
                  label={
                    <Stack>
                      <Typography variant="body2">Disabled</Typography>
                      <Typography variant="caption" sx={{
                        color: "text.secondary"
                      }}>
                        Force flag OFF for this organization
                      </Typography>
                    </Stack>
                  }
                />
              </RadioGroup>
            </FormControl>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSave}
          loading={saving}
          disabled={!selectedOrg}
        >
          Add Override
        </Button>
      </DialogActions>
    </Dialog>
  );
}
