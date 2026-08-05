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
  IconButton,
  Tooltip,
  Alert,
  LinearProgress,
} from '@mui/material';
import { useRouter } from 'next/navigation';
import Iconify from '@/components/iconify';
import { TableHeadCustom } from '@/components/table';
import Label from '@/components/label';
import { paths } from '../../../routes/paths';
import { listActiveGrants, revokeTempAccess } from './actions';
import type { ActiveGrant } from '../../../types/platform-admin';
import { LocalDate } from '@/components/local-date';

const TABLE_HEAD = [
  { id: 'admin_email', label: 'Admin' },
  { id: 'organization_name', label: 'Organization' },
  { id: 'created_at', label: 'Granted' },
  { id: 'expires_at', label: 'Expires' },
  { id: 'time_remaining', label: 'Time Left' },
  { id: 'actions', label: '', width: 60 },
];

interface ActiveGrantsProps {
  initialGrants?: ActiveGrant[];
}

export function ActiveGrants({ initialGrants }: ActiveGrantsProps) {
  const router = useRouter();
  const [grants, setGrants] = useState<ActiveGrant[]>(initialGrants || []);
  const [loading, setLoading] = useState(!initialGrants);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const fetchGrants = useCallback(async () => {
    setLoading(true);
    setError(null);

    const result = await listActiveGrants();

    if (result.error) {
      setError(result.error);
    } else if (result.data) {
      setGrants(result.data);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    if (!initialGrants) {
      fetchGrants();
    }
  }, [fetchGrants, initialGrants]);

  // Refresh every minute to update time remaining
  useEffect(() => {
    const interval = setInterval(() => {
      fetchGrants();
    }, 60000);

    return () => clearInterval(interval);
  }, [fetchGrants]);

  const handleRevoke = async (grantId: string) => {
    setRevoking(grantId);

    const result = await revokeTempAccess({ grantId });

    if (result.error) {
      setError(result.error);
    } else {
      // Remove from list
      setGrants((prev) => prev.filter((g) => g.id !== grantId));
    }

    setRevoking(null);
  };

  const handleOrgClick = (tenantId: string) => {
    router.push(paths.platformAdmin.organizationDetail(tenantId));
  };

  const formatTimeRemaining = (minutes: number) => {
    if (minutes <= 0) return 'Expired';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  };

  const getTimeRemainingColor = (minutes: number): 'success' | 'warning' | 'error' => {
    if (minutes > 360) return 'success'; // > 6 hours
    if (minutes > 60) return 'warning'; // > 1 hour
    return 'error'; // < 1 hour
  };

  if (loading) {
    return (
      <Card>
        <LinearProgress />
        <Box sx={{ p: 3, textAlign: 'center' }}>
          <Typography sx={{
            color: "text.secondary"
          }}>Loading active grants...</Typography>
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

  if (grants.length === 0) {
    return (
      <Card>
        <Box sx={{ p: 6, textAlign: 'center' }}>
          <Iconify icon="mdi:key-off" width={48} sx={{ color: 'text.disabled', mb: 2 }} />
          <Typography variant="h6" sx={{
            color: "text.secondary"
          }}>
            No Active Grants
          </Typography>
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              mt: 1
            }}>
            There are no active temporary access grants at this time.
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
          <Table sx={{ minWidth: 800 }}>
            <TableHeadCustom headLabel={TABLE_HEAD} />

            <TableBody>
              {grants.map((grant) => (
                <TableRow key={grant.id} hover>
                  <TableCell>
                    <Stack>
                      <Typography variant="body2" sx={{
                        fontWeight: "medium"
                      }}>
                        {grant.admin_email}
                      </Typography>
                      {grant.admin_name && (
                        <Typography variant="caption" sx={{
                          color: "text.secondary"
                        }}>
                          {grant.admin_name}
                        </Typography>
                      )}
                    </Stack>
                  </TableCell>

                  <TableCell>
                    <Typography
                      variant="body2"
                      sx={{
                        cursor: 'pointer',
                        '&:hover': { textDecoration: 'underline' },
                      }}
                      onClick={() => handleOrgClick(grant.tenant_id)}
                    >
                      {grant.organization_name}
                    </Typography>
                  </TableCell>

                  <TableCell>
                    <Typography variant="body2" sx={{
                      color: "text.secondary"
                    }}>
                      <LocalDate value={grant.created_at} format="monthDayTime" absent="-" />
                    </Typography>
                  </TableCell>

                  <TableCell>
                    <Typography variant="body2" sx={{
                      color: "text.secondary"
                    }}>
                      <LocalDate value={grant.expires_at} format="monthDayTime" absent="-" />
                    </Typography>
                  </TableCell>

                  <TableCell>
                    <Label
                      color={getTimeRemainingColor(grant.time_remaining_minutes)}
                      variant="soft"
                    >
                      {formatTimeRemaining(grant.time_remaining_minutes)}
                    </Label>
                  </TableCell>

                  <TableCell align="right">
                    <Tooltip title="Revoke access">
                      <IconButton
                        size="small"
                        color="error"
                        onClick={() => handleRevoke(grant.id)}
                        disabled={revoking === grant.id}
                      >
                        <Iconify
                          icon={revoking === grant.id ? 'mdi:loading' : 'mdi:key-remove'}
                          className={revoking === grant.id ? 'animate-spin' : ''}
                        />
                      </IconButton>
                    </Tooltip>
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
