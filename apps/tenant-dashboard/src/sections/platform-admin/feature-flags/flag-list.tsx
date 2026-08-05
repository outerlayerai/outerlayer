'use client';

import { useState, useCallback, useEffect } from 'react';
import {
  Box,
  Card,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableRow,
  Typography,
  Stack,
  Switch,
  LinearProgress,
  Alert,
} from '@mui/material';
import Iconify from '@/components/iconify';
import { TableHeadCustom } from '@/components/table';
import Label from '@/components/label';
import { listFeatureFlags, updateFeatureFlag } from './actions';
import type { FeatureFlagListItem } from '../../../types/platform-admin';

const TABLE_HEAD = [
  { id: 'key', label: 'Flag Key' },
  { id: 'strategy', label: 'Strategy' },
  { id: 'targeting', label: 'Targeting' },
  { id: 'status', label: 'Status' },
  { id: 'toggle', label: '', width: 80 },
];

interface FlagListProps {
  initialFlags?: FeatureFlagListItem[];
  onSelectFlag?: (flagId: string) => void;
}

export function FlagList({ initialFlags, onSelectFlag }: FlagListProps) {
  const [flags, setFlags] = useState<FeatureFlagListItem[]>(initialFlags || []);
  const [loading, setLoading] = useState(!initialFlags);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const fetchFlags = useCallback(async () => {
    setLoading(true);
    setError(null);

    const result = await listFeatureFlags();

    if (result.error) {
      setError(result.error);
    } else if (result.data) {
      setFlags(result.data);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    if (!initialFlags) {
      fetchFlags();
    }
  }, [fetchFlags, initialFlags]);

  const handleToggle = async (flag: FeatureFlagListItem) => {
    setToggling(flag.id);

    const result = await updateFeatureFlag({
      flagId: flag.id,
      is_enabled: !flag.is_enabled,
    });

    if (result.error) {
      setError(result.error);
    } else {
      // Update local state
      setFlags((prev) =>
        prev.map((f) => (f.id === flag.id ? { ...f, is_enabled: !f.is_enabled } : f))
      );
    }

    setToggling(null);
  };

  const getStrategyColor = (
    strategy: string
  ): 'default' | 'primary' | 'secondary' | 'info' | 'success' | 'warning' | 'error' => {
    switch (strategy) {
      case 'global':
        return 'default';
      case 'percentage':
        return 'info';
      case 'targeted':
        return 'warning';
      default:
        return 'default';
    }
  };

  const formatStrategy = (strategy: string, rolloutPercentage: number): string => {
    if (strategy === 'percentage') {
      return `${rolloutPercentage}%`;
    }
    return strategy.charAt(0).toUpperCase() + strategy.slice(1);
  };

  if (loading) {
    return (
      <Card>
        <LinearProgress />
        <Box sx={{ p: 3, textAlign: 'center' }}>
          <Typography sx={{
            color: "text.secondary"
          }}>Loading feature flags...</Typography>
        </Box>
      </Card>
    );
  }

  if (error) {
    return (
      <Alert severity="error" sx={{ mb: 3 }}>
        {error}
      </Alert>
    );
  }

  if (flags.length === 0) {
    return (
      <Card>
        <Box sx={{ p: 6, textAlign: 'center' }}>
          <Iconify icon="mdi:flag-off" width={48} sx={{ color: 'text.disabled', mb: 2 }} />
          <Typography variant="h6" sx={{
            color: "text.secondary"
          }}>
            No Feature Flags
          </Typography>
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              mt: 1
            }}>
            There are no feature flags configured yet.
          </Typography>
        </Box>
      </Card>
    );
  }

  return (
    <Card>
      <TableContainer sx={{ overflow: 'unset' }}>
        <Box sx={{ flexGrow: 1, height: '100%', maxHeight: '100%', overflow: 'auto' }}>
        <Box sx={{ minHeight: '100%' }}>
          <Table sx={{ minWidth: 700 }}>
            <TableHeadCustom headLabel={TABLE_HEAD} />

            <TableBody>
              {flags.map((flag) => (
                <TableRow
                  key={flag.id}
                  hover
                  sx={{ cursor: 'pointer' }}
                  onClick={() => onSelectFlag?.(flag.id)}
                >
                  <TableCell>
                    <Stack>
                      <Typography variant="body2" sx={{
                        fontWeight: "medium"
                      }}>
                        {flag.key}
                      </Typography>
                      {flag.description && (
                        <Typography variant="caption" sx={{
                          color: "text.secondary"
                        }}>
                          {flag.description}
                        </Typography>
                      )}
                    </Stack>
                  </TableCell>

                  <TableCell>
                    <Label variant="soft" color={getStrategyColor(flag.strategy)}>
                      {formatStrategy(flag.strategy, flag.rollout_percentage)}
                    </Label>
                  </TableCell>

                  <TableCell>
                    <Stack direction="row" spacing={1}>
                      {flag.override_count > 0 ? (
                        <Label variant="soft" color="info">
                          {flag.override_count} override{flag.override_count !== 1 ? 's' : ''}
                        </Label>
                      ) : (
                        <Typography variant="caption" sx={{
                          color: "text.secondary"
                        }}>
                          All orgs
                        </Typography>
                      )}
                    </Stack>
                  </TableCell>

                  <TableCell>
                    <Label
                      variant="soft"
                      color={flag.is_enabled ? 'success' : 'default'}
                    >
                      {flag.is_enabled ? 'Enabled' : 'Disabled'}
                    </Label>
                  </TableCell>

                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Switch
                      checked={flag.is_enabled}
                      onChange={() => handleToggle(flag)}
                      disabled={toggling === flag.id}
                      size="small"
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
        </Box>
      </TableContainer>
    </Card>
  );
}
