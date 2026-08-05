'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardHeader,
  IconButton,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import Iconify from '@/components/iconify';
import Label from '@/components/label';
import {
  TIERS,
  TIER_IDS,
  ENTITLEMENTS,
  UNLIMITED,
  type TierId,
  type EntitlementKey,
  type ResolvedEntitlements,
  type TenantEntitlementOverride,
} from '@/config/entitlements';
import {
  getTenantEntitlements,
  setTenantTier,
  removeEntitlementOverride,
} from './entitlement-actions';
import { AddOverrideModal } from './add-override-modal';

interface EntitlementCardProps {
  tenantId: string;
  organizationName: string;
  currentTierId: string;
}

export function EntitlementCard({ tenantId, organizationName, currentTierId }: EntitlementCardProps) {
  const [tierId, setTierId] = useState<TierId>(currentTierId as TierId);
  const [entitlements, setEntitlements] = useState<ResolvedEntitlements | null>(null);
  const [overrides, setOverrides] = useState<TenantEntitlementOverride[]>([]);
  const [loading, setLoading] = useState(true);
  const [tierSaving, setTierSaving] = useState(false);
  const [removingKey, setRemovingKey] = useState<EntitlementKey | null>(null);
  const [overrideModalOpen, setOverrideModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadEntitlements = useCallback(async () => {
    setLoading(true);
    const result = await getTenantEntitlements(tenantId);
    if (result.error) {
      setError(result.error);
    } else if (result.data) {
      setEntitlements(result.data.entitlements);
      setOverrides(result.data.overrides);
    }
    setLoading(false);
  }, [tenantId]);

  useEffect(() => {
    loadEntitlements();
  }, [loadEntitlements]);

  const handleTierChange = async (newTierId: TierId) => {
    setTierSaving(true);
    setError(null);
    const result = await setTenantTier(tenantId, newTierId, organizationName);
    if (result.error) {
      setError(result.error);
    } else {
      setTierId(newTierId);
      await loadEntitlements();
    }
    setTierSaving(false);
  };

  const handleRemoveOverride = async (key: EntitlementKey) => {
    setRemovingKey(key);
    setError(null);
    const result = await removeEntitlementOverride(tenantId, key, organizationName);
    if (result.error) {
      setError(result.error);
    } else {
      await loadEntitlements();
    }
    setRemovingKey(null);
  };

  const formatValue = (value: boolean | number | string): string => {
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'number') return value === UNLIMITED ? 'Unlimited' : String(value);
    return value;
  };

  return (
    <>
      <Card>
        <CardHeader
          title="Entitlements"
          avatar={<Iconify icon="mdi:shield-star" />}
        />
        <Stack sx={{ p: 3 }} spacing={3}>
          {error && (
            <Typography color="error" variant="body2">{error}</Typography>
          )}

          {/* Tier Selector */}
          <Stack
            direction="row"
            sx={{
              justifyContent: "space-between",
              alignItems: "center"
            }}>
            <Box>
              <Typography variant="subtitle2">Current Tier</Typography>
              <Typography variant="body2" sx={{
                color: "text.secondary"
              }}>
                Change this tenant&apos;s pricing tier
              </Typography>
            </Box>
            <Stack direction="row" spacing={1} sx={{
              alignItems: "center"
            }}>
              <TextField
                select
                size="small"
                value={tierId}
                disabled={tierSaving}
                onChange={(e) => handleTierChange(e.target.value as TierId)}
                sx={{ minWidth: 150 }}
              >
                {TIER_IDS.map((id) => (
                  <MenuItem key={id} value={id}>
                    {TIERS[id].displayName}
                  </MenuItem>
                ))}
              </TextField>
              {tierSaving && (
                <Typography variant="caption" sx={{
                  color: "text.secondary"
                }}>Saving...</Typography>
              )}
            </Stack>
          </Stack>

          {/* Overrides Table */}
          <Box>
            <Stack
              direction="row"
              sx={{
                justifyContent: "space-between",
                alignItems: "center",
                mb: 1
              }}>
              <Typography variant="subtitle2">
                Overrides ({overrides.length})
              </Typography>
              <Button
                size="small"
                variant="outlined"
                startIcon={<Iconify icon="mdi:plus" />}
                onClick={() => setOverrideModalOpen(true)}
              >
                Add Override
              </Button>
            </Stack>

            {overrides.length > 0 ? (
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Entitlement</TableCell>
                      <TableCell>Override Value</TableCell>
                      <TableCell>Tier Default</TableCell>
                      <TableCell>Reason</TableCell>
                      <TableCell align="right">Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {overrides.map((override) => {
                      const def = ENTITLEMENTS[override.entitlementKey];
                      const tierDefault = def ? def[tierId] : '—';
                      return (
                        <TableRow key={override.id}>
                          <TableCell>
                            <Typography variant="body2">
                              {def?.displayName ?? override.entitlementKey}
                            </Typography>
                            <Typography
                              variant="caption"
                              sx={{
                                color: "text.secondary",
                                fontFamily: 'monospace'
                              }}>
                              {override.entitlementKey}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            <Label variant="soft" color="warning">
                              {formatValue(override.value)}
                            </Label>
                          </TableCell>
                          <TableCell>
                            <Typography variant="body2" sx={{
                              color: "text.secondary"
                            }}>
                              {formatValue(tierDefault as boolean | number | string)}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            <Typography variant="caption" sx={{
                              color: "text.secondary"
                            }}>
                              {override.overrideReason || '—'}
                            </Typography>
                          </TableCell>
                          <TableCell align="right">
                            <Tooltip title="Remove override">
                              <IconButton
                                size="small"
                                color="error"
                                disabled={removingKey === override.entitlementKey}
                                onClick={() => handleRemoveOverride(override.entitlementKey)}
                              >
                                <Iconify icon="mdi:close" width={18} />
                              </IconButton>
                            </Tooltip>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            ) : (
              <Typography
                variant="body2"
                sx={{
                  color: "text.secondary",
                  py: 2,
                  textAlign: 'center'
                }}>
                {loading ? 'Loading...' : 'No overrides set. Tier defaults apply to all entitlements.'}
              </Typography>
            )}
          </Box>

          {/* Resolved Entitlements Summary */}
          {entitlements && (
            <Box>
              <Typography variant="subtitle2" sx={{
                mb: 1
              }}>Resolved Entitlements</Typography>
              <Stack spacing={0.5}>
                {(Object.keys(ENTITLEMENTS) as EntitlementKey[]).map((key) => {
                  const def = ENTITLEMENTS[key];
                  const value = entitlements[key];
                  const hasOverride = overrides.some((o) => o.entitlementKey === key);
                  return (
                    <Stack
                      key={key}
                      direction="row"
                      sx={{
                        justifyContent: "space-between",
                        alignItems: "center"
                      }}>
                      <Typography variant="caption" sx={{
                        color: "text.secondary"
                      }}>
                        {def.displayName}
                      </Typography>
                      <Typography
                        variant="caption"
                        sx={{
                          color: hasOverride ? 'warning.main' : 'text.primary',
                          fontWeight: hasOverride ? 700 : 400
                        }}
                      >
                        {formatValue(value)}{hasOverride ? ' ★' : ''}
                      </Typography>
                    </Stack>
                  );
                })}
              </Stack>
            </Box>
          )}
        </Stack>
      </Card>
      <AddOverrideModal
        open={overrideModalOpen}
        onClose={() => setOverrideModalOpen(false)}
        tenantId={tenantId}
        organizationName={organizationName}
        existingOverrideKeys={overrides.map((o) => o.entitlementKey)}
        onSuccess={loadEntitlements}
      />
    </>
  );
}
