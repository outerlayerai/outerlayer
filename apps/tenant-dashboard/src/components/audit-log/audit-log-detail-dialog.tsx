'use client';

import { useState, useEffect } from 'react';
import {
  Box,
  Card,
  CardHeader,
  Divider,
  Grid,
  Stack,
  Typography,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Alert,
  LinearProgress,
} from '@mui/material';
import Iconify from '@/components/iconify';
import Label from '@/components/label';
import type { ServerActionResponse } from '../../types/server-action';
import type { AuditLogDetail } from '../../types/platform-admin';

/**
 * Presentational audit log detail dialog shared by the internal
 * platform-admin viewer and the tenant Settings -> Audit log page. The data
 * source is injected — scoping is the caller's server action's responsibility.
 */

interface AuditLogDetailDialogProps {
  logId: string | null;
  open: boolean;
  onClose: () => void;
  fetchDetail: (logId: string) => Promise<ServerActionResponse<AuditLogDetail>>;
}

export function AuditLogDetailDialog({
  logId,
  open,
  onClose,
  fetchDetail,
}: AuditLogDetailDialogProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<AuditLogDetail | null>(null);

  useEffect(() => {
    if (!logId || !open) {
      setLog(null);
      return;
    }

    const run = async () => {
      setLoading(true);
      setError(null);

      const result = await fetchDetail(logId);

      if (result?.error) {
        setError(result.error);
      } else if (result?.data) {
        setLog(result.data);
      }

      setLoading(false);
    };

    run();
  }, [logId, open, fetchDetail]);

  const formatDateTime = (dateString: string) => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleString('en-US', {
      dateStyle: 'full',
      timeStyle: 'medium',
    });
  };

  const getActionColor = (actionType: string): 'error' | 'success' | 'warning' | 'info' => {
    if (actionType.includes('delete') || actionType.includes('denied') || actionType.includes('removed')) return 'error';
    if (actionType.includes('grant') || actionType.includes('create') || actionType.includes('invited')) return 'success';
    if (actionType.includes('revoke')) return 'warning';
    return 'info';
  };

  const formatActionType = (actionType: string): string => {
    return actionType
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  const renderJsonBlock = (data: Record<string, unknown> | null, title: string) => {
    if (!data) return null;

    return (
      <Box sx={{ mb: 3 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          {title}
        </Typography>
        <Box
          component="pre"
          sx={{
            p: 2,
            borderRadius: 1,
            bgcolor: 'background.neutral',
            fontSize: '0.875rem',
            fontFamily: 'monospace',
            overflow: 'auto',
            maxHeight: 300,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {JSON.stringify(data, null, 2)}
        </Box>
      </Box>
    );
  };

  return (
    <Dialog fullWidth maxWidth="md" open={open} onClose={onClose}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Stack direction="row" spacing={1} sx={{
          alignItems: "center"
        }}>
          <Iconify icon="mdi:clipboard-text" width={24} />
          <Typography variant="h6">Audit Log Detail</Typography>
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

        {log && (
          <Grid container spacing={3}>
            {/* Summary */}
            <Grid size={12}>
              <Card>
                <CardHeader title="Action Summary" />
                <Stack spacing={2} sx={{ p: 3 }}>
                  <Stack
                    direction="row"
                    sx={{
                      justifyContent: "space-between",
                      alignItems: "center"
                    }}>
                    <Typography variant="body2" sx={{
                      color: "text.secondary"
                    }}>
                      Action
                    </Typography>
                    <Label variant="soft" color={getActionColor(log.action_type)}>
                      {formatActionType(log.action_type)}
                    </Label>
                  </Stack>
                  <Divider />
                  <Stack direction="row" sx={{
                    justifyContent: "space-between"
                  }}>
                    <Typography variant="body2" sx={{
                      color: "text.secondary"
                    }}>
                      Timestamp
                    </Typography>
                    <Stack sx={{
                      alignItems: "flex-end"
                    }}>
                      <Typography variant="subtitle2">
                        {formatDateTime(log.created_at)}
                      </Typography>
                      <Typography variant="caption" sx={{
                        color: "text.secondary"
                      }}>
                        {new Date(log.created_at).toISOString()} (UTC)
                      </Typography>
                    </Stack>
                  </Stack>
                  <Divider />
                  <Stack direction="row" sx={{
                    justifyContent: "space-between"
                  }}>
                    <Typography variant="body2" sx={{
                      color: "text.secondary"
                    }}>
                      Performed By
                    </Typography>
                    <Stack sx={{
                      alignItems: "flex-end"
                    }}>
                      <Typography variant="subtitle2">
                        {log.actor_email ?? log.actor_label ?? log.actor_type}
                      </Typography>
                      {log.actor_name && (
                        <Typography variant="caption" sx={{
                          color: "text.secondary"
                        }}>
                          {log.actor_name}
                        </Typography>
                      )}
                    </Stack>
                  </Stack>
                  <Divider />
                  <Stack direction="row" sx={{
                    justifyContent: "space-between"
                  }}>
                    <Typography variant="body2" sx={{
                      color: "text.secondary"
                    }}>
                      Target Type
                    </Typography>
                    <Typography variant="subtitle2">{log.target_type}</Typography>
                  </Stack>
                  <Divider />
                  <Stack direction="row" sx={{
                    justifyContent: "space-between"
                  }}>
                    <Typography variant="body2" sx={{
                      color: "text.secondary"
                    }}>
                      Target
                    </Typography>
                    <Typography variant="subtitle2">
                      {log.target_identifier || log.target_id || '-'}
                    </Typography>
                  </Stack>
                  {(log.ip_address || log.user_agent || log.request_id) && (
                    <>
                      <Divider />
                      <Stack direction="row" sx={{
                        justifyContent: "space-between"
                      }}>
                        <Typography variant="body2" sx={{
                          color: "text.secondary"
                        }}>
                          Request
                        </Typography>
                        <Stack sx={{
                          alignItems: "flex-end"
                        }}>
                          <Typography variant="subtitle2">
                            {log.ip_address ?? '-'}
                          </Typography>
                          {(log.user_agent || log.request_id) && (
                            <Typography variant="caption" sx={{
                              color: "text.secondary",
                              maxWidth: 360,
                              textAlign: "right",
                              overflowWrap: "anywhere"
                            }}>
                              {[log.user_agent, log.request_id].filter(Boolean).join(' · ')}
                            </Typography>
                          )}
                        </Stack>
                      </Stack>
                    </>
                  )}
                </Stack>
              </Card>
            </Grid>

            {/* Details JSON */}
            {log.details && (
              <Grid size={12}>
                {renderJsonBlock(log.details, 'Action Details')}
              </Grid>
            )}

            {/* Before/After State */}
            {(log.before_state || log.after_state) && (
              <Grid size={12}>
                <Grid container spacing={2}>
                  {log.before_state && (
                    <Grid size={{ xs: 12, md: 6 }}>
                      {renderJsonBlock(log.before_state, 'Before State')}
                    </Grid>
                  )}
                  {log.after_state && (
                    <Grid size={{ xs: 12, md: 6 }}>
                      {renderJsonBlock(log.after_state, 'After State')}
                    </Grid>
                  )}
                </Grid>
              </Grid>
            )}
          </Grid>
        )}
      </DialogContent>
    </Dialog>
  );
}
