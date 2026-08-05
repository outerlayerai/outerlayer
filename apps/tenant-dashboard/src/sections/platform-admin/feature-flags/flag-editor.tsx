'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  Box,
  Card,
  CardHeader,
  CardContent,
  Divider,
  Stack,
  Typography,
  TextField,
  MenuItem,
  Slider,
  Switch,
  FormControlLabel,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogActions,
  IconButton,
  Button,
  Alert,
  LinearProgress,
} from '@mui/material';
import Iconify from '@/components/iconify';
import Label from '@/components/label';
import {
  getFeatureFlagDetail,
  updateFeatureFlag,
  removeFlagOverride,
} from './actions';
import type { FeatureFlagDetail, FlagStrategy } from '../../../types/platform-admin';
import { OrgOverrideManager } from './org-override-manager';
import { DeleteFlagModal } from './delete-flag-modal';

interface FlagEditorProps {
  flagId: string | null;
  open: boolean;
  onClose: () => void;
  onUpdate?: () => void;
}

export function FlagEditor({ flagId, open, onClose, onUpdate }: FlagEditorProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flag, setFlag] = useState<FeatureFlagDetail | null>(null);

  // Editable state
  const [isEnabled, setIsEnabled] = useState(false);
  const [strategy, setStrategy] = useState<FlagStrategy>('global');
  const [rolloutPercentage, setRolloutPercentage] = useState(0);
  const [description, setDescription] = useState('');

  // Override modal state
  const [overrideModalOpen, setOverrideModalOpen] = useState(false);

  // Delete modal state
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

  // Compute current status summary
  const statusSummary = useMemo(() => {
    if (!flag) return null;

    const enabledOverrides = flag.overrides.filter((o) => o.is_enabled).length;
    const disabledOverrides = flag.overrides.filter((o) => !o.is_enabled).length;

    // For targeted strategy, only overrides matter
    if (strategy === 'targeted') {
      if (enabledOverrides === 0) {
        return { text: 'No organizations targeted', color: 'default' as const };
      }
      return {
        text: `Active for ${enabledOverrides} organization${enabledOverrides > 1 ? 's' : ''}`,
        color: 'success' as const,
      };
    }

    // For global/percentage, check kill switch first
    if (!isEnabled) {
      if (enabledOverrides > 0) {
        return {
          text: `Active for ${enabledOverrides} organization${enabledOverrides > 1 ? 's' : ''} (via override)`,
          color: 'warning' as const,
        };
      }
      return { text: 'Inactive everywhere', color: 'default' as const };
    }

    // Kill switch ON
    if (strategy === 'global') {
      if (disabledOverrides > 0) {
        return {
          text: `Active for all except ${disabledOverrides} organization${disabledOverrides > 1 ? 's' : ''}`,
          color: 'success' as const,
        };
      }
      return { text: 'Active for all organizations', color: 'success' as const };
    }

    if (strategy === 'percentage') {
      return {
        text: `Rolling out to ${rolloutPercentage}% of organizations`,
        color: rolloutPercentage > 0 ? 'info' as const : 'default' as const,
      };
    }

    return null;
  }, [flag, strategy, isEnabled, rolloutPercentage]);

  useEffect(() => {
    if (!flagId || !open) {
      setFlag(null);
      return;
    }

    const fetchDetail = async () => {
      setLoading(true);
      setError(null);

      const result = await getFeatureFlagDetail(flagId);

      if (result.error) {
        setError(result.error);
      } else if (result.data) {
        setFlag(result.data);
        setIsEnabled(result.data.is_enabled);
        setStrategy(result.data.strategy);
        setRolloutPercentage(result.data.rollout_percentage);
        setDescription(result.data.description || '');
      }

      setLoading(false);
    };

    fetchDetail();
  }, [flagId, open]);

  const handleSave = async () => {
    if (!flagId) return;

    setSaving(true);
    setError(null);

    const result = await updateFeatureFlag({
      flagId,
      is_enabled: isEnabled,
      strategy,
      rollout_percentage: rolloutPercentage,
      description,
    });

    if (result.error) {
      setError(result.error);
    } else {
      onUpdate?.();
      onClose();
    }

    setSaving(false);
  };

  const handleRemoveOverride = async (tenantId: string) => {
    if (!flagId) return;

    const result = await removeFlagOverride({ flagId, tenantId });
    if (result.error) {
      setError(result.error);
    } else {
      // Refresh the flag detail
      const refreshResult = await getFeatureFlagDetail(flagId);
      if (refreshResult.data) {
        setFlag(refreshResult.data);
      }
    }
  };

  const handleOverrideSuccess = async () => {
    if (!flagId) return;
    const refreshResult = await getFeatureFlagDetail(flagId);
    if (refreshResult.data) {
      setFlag(refreshResult.data);
    }
    setOverrideModalOpen(false);
  };

  const handleDeleteSuccess = () => {
    setDeleteModalOpen(false);
    onUpdate?.();
    onClose();
  };

  return (
    <>
      <Dialog fullWidth maxWidth="md" open={open} onClose={onClose}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Stack direction="row" spacing={1} sx={{
            alignItems: "center"
          }}>
            <Iconify icon="mdi:flag" width={24} />
            <Typography variant="h6">
              {flag?.key || 'Feature Flag'}
            </Typography>
          </Stack>
          <IconButton onClick={onClose} size="small">
            <Iconify icon="mdi:close" />
          </IconButton>
        </DialogTitle>

        <DialogContent>
          {loading && <LinearProgress sx={{ mb: 2 }} />}

          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          {flag && (
            <Stack spacing={3}>
              {/* Status Summary */}
              {statusSummary && (
                <Alert
                  severity={statusSummary.color === 'success' ? 'success' : statusSummary.color === 'warning' ? 'warning' : statusSummary.color === 'info' ? 'info' : 'info'}
                  icon={<Iconify icon={statusSummary.color === 'success' ? 'mdi:check-circle' : statusSummary.color === 'warning' ? 'mdi:alert' : 'mdi:information'} />}
                  sx={{
                    bgcolor: statusSummary.color === 'default' ? 'background.neutral' : undefined,
                    color: statusSummary.color === 'default' ? 'text.secondary' : undefined,
                  }}
                >
                  <Typography variant="subtitle2">{statusSummary.text}</Typography>
                </Alert>
              )}

              {/* Kill Switch - LaunchDarkly style */}
              <Card>
                <CardHeader
                  title="Kill Switch"
                  subheader="Master control to instantly disable the flag for non-targeted organizations"
                />
                <CardContent>
                  <Stack spacing={2}>
                    <FormControlLabel
                      control={
                        <Switch
                          checked={isEnabled}
                          onChange={(e) => setIsEnabled(e.target.checked)}
                          color={isEnabled ? 'success' : 'default'}
                        />
                      }
                      label={
                        <Stack>
                          <Typography variant="body2" sx={{
                            fontWeight: "medium"
                          }}>
                            {isEnabled ? 'Flag is ON' : 'Flag is OFF'}
                          </Typography>
                          <Typography variant="caption" sx={{
                            color: "text.secondary"
                          }}>
                            {isEnabled
                              ? 'Targeting rules below determine who gets the feature'
                              : 'Feature is disabled (organization overrides still apply)'}
                          </Typography>
                        </Stack>
                      }
                    />
                  </Stack>
                </CardContent>
              </Card>

              {/* Default Rule (Strategy) */}
              <Card>
                <CardHeader
                  title="Default Rule"
                  subheader="How the flag behaves for organizations without specific overrides"
                />
                <CardContent>
                  <Stack spacing={3}>
                    <TextField
                      select
                      fullWidth
                      label="Strategy"
                      value={strategy}
                      onChange={(e) => setStrategy(e.target.value as FlagStrategy)}
                    >
                      <MenuItem value="global">
                        <Stack>
                          <Typography>Serve to everyone</Typography>
                          <Typography variant="caption" sx={{
                            color: "text.secondary"
                          }}>
                            All organizations get the feature (when kill switch is ON)
                          </Typography>
                        </Stack>
                      </MenuItem>
                      <MenuItem value="percentage">
                        <Stack>
                          <Typography>Percentage rollout</Typography>
                          <Typography variant="caption" sx={{
                            color: "text.secondary"
                          }}>
                            Gradually roll out to a percentage of organizations
                          </Typography>
                        </Stack>
                      </MenuItem>
                      <MenuItem value="targeted">
                        <Stack>
                          <Typography>Serve to targeted only</Typography>
                          <Typography variant="caption" sx={{
                            color: "text.secondary"
                          }}>
                            Only organizations with overrides below get the feature
                          </Typography>
                        </Stack>
                      </MenuItem>
                    </TextField>

                    {strategy === 'percentage' && (
                      <Box>
                        <Typography variant="body2" sx={{ mb: 1 }}>
                          Rollout Percentage: {rolloutPercentage}%
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

                    {strategy === 'targeted' && (
                      <Alert severity="info" icon={<Iconify icon="mdi:target" />}>
                        Only organizations listed in &quot;Organization Overrides&quot; below will receive this feature.
                        The kill switch setting is ignored for targeted flags.
                      </Alert>
                    )}

                    <Divider />

                    <TextField
                      fullWidth
                      multiline
                      rows={2}
                      label="Description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="What does this flag control?"
                    />
                  </Stack>
                </CardContent>
              </Card>

              {/* Org Overrides */}
              <Card>
                <CardHeader
                  title="Organization Overrides"
                  subheader="Per-organization targeting that always takes precedence over default rules"
                  action={
                    <Button
                      size="small"
                      startIcon={<Iconify icon="mdi:plus" />}
                      onClick={() => setOverrideModalOpen(true)}
                    >
                      Add Override
                    </Button>
                  }
                />
                <CardContent>
                  {flag.overrides.length === 0 ? (
                    <Typography variant="body2" sx={{
                      color: "text.secondary"
                    }}>
                      No organization-specific overrides.
                      {strategy === 'targeted'
                        ? ' Add overrides to enable this flag for specific organizations.'
                        : ' All organizations follow the default rule above.'}
                    </Typography>
                  ) : (
                    <Stack spacing={1}>
                      {flag.overrides.map((override) => (
                        <Stack
                          key={override.id}
                          direction="row"
                          sx={{
                            alignItems: "center",
                            justifyContent: "space-between",
                            p: 1.5,
                            borderRadius: 1,
                            bgcolor: 'background.neutral'
                          }}>
                          <Stack direction="row" spacing={2} sx={{
                            alignItems: "center"
                          }}>
                            <Typography variant="body2" sx={{
                              fontWeight: "medium"
                            }}>
                              {override.organization_name}
                            </Typography>
                            <Label
                              variant="soft"
                              color={override.is_enabled ? 'success' : 'error'}
                            >
                              {override.is_enabled ? 'Enabled' : 'Disabled'}
                            </Label>
                          </Stack>
                          <IconButton
                            size="small"
                            onClick={() => handleRemoveOverride(override.tenant_id)}
                            sx={{ color: 'text.secondary' }}
                          >
                            <Iconify icon="mdi:close" width={18} />
                          </IconButton>
                        </Stack>
                      ))}
                    </Stack>
                  )}
                </CardContent>
              </Card>
            </Stack>
          )}
        </DialogContent>

        <DialogActions sx={{ justifyContent: 'space-between' }}>
          <Button
            color="error"
            onClick={() => setDeleteModalOpen(true)}
            disabled={saving || !flag}
            startIcon={<Iconify icon="mdi:delete" />}
          >
            Delete Flag
          </Button>
          <Stack direction="row" spacing={1}>
            <Button onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="contained"
              onClick={handleSave}
              loading={saving}
              disabled={!flag}
            >
              Save Changes
            </Button>
          </Stack>
        </DialogActions>
      </Dialog>
      {/* Override Modal */}
      <OrgOverrideManager
        open={overrideModalOpen}
        onClose={() => setOverrideModalOpen(false)}
        flagId={flagId}
        onSuccess={handleOverrideSuccess}
      />
      {/* Delete Modal */}
      <DeleteFlagModal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        flagId={flagId}
        flagKey={flag?.key || null}
        overrideCount={flag?.overrides?.length || 0}
        onSuccess={handleDeleteSuccess}
      />
    </>
  );
}
