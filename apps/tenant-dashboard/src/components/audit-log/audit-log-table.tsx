'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Box,
  Card,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableRow,
  TextField,
  MenuItem,
  Stack,
  InputAdornment,
  Typography,
  IconButton,
  Tooltip,
} from '@mui/material';
import Iconify from '@/components/iconify';
import {
  TableHeadCustom,
  TablePaginationCustom,
  useTable,
} from '@/components/table';
import Label from '@/components/label';
import type { ServerActionResponse } from '../../types/server-action';
import type {
  AuditLogListItem,
  PaginatedResponse,
  ActionType,
  TargetType,
} from '../../types/platform-admin';
import { LocalDate } from '@/components/local-date';

/**
 * Presentational audit log table shared by the internal platform-admin viewer
 * and the tenant Settings -> Audit log page. The data source and the filter
 * vocabularies are injected — scoping (all rows vs one tenant's trail) is the
 * caller's server action's responsibility, never this component's.
 */

const TABLE_HEAD = [
  { id: 'timestamp', label: 'Time' },
  { id: 'actor_email', label: 'Actor' },
  { id: 'action_type', label: 'Action' },
  { id: 'target', label: 'Target' },
  { id: 'actions', label: '', width: 60 },
];

interface AuditLogPageParams {
  page: number;
  pageSize: number;
  actionType?: ActionType;
  targetType?: TargetType;
  /** ISO bounds derived from the date filters (To is end-of-day inclusive). */
  startDate?: string;
  endDate?: string;
}

export interface AuditLogFilterOption<T extends string> {
  value: T | '';
  label: string;
}

/** Server-rendered seed for the first paint — a React Server Component (RSC) caller that already
 *  fetched page one (from `searchParams`) skips this component's own first
 *  client round trip. Every filter/page value defaults independently, so a
 *  caller can seed only the ones it resolved. */
interface AuditLogTableInitialFilters {
  page?: number;
  pageSize?: number;
  actionType?: ActionType | '';
  targetType?: TargetType | '';
  fromDate?: string;
  toDate?: string;
}

interface AuditLogTableProps {
  fetchPage: (
    params: AuditLogPageParams
  ) => Promise<ServerActionResponse<PaginatedResponse<AuditLogListItem>>>;
  actionTypes: AuditLogFilterOption<ActionType>[];
  targetTypes: AuditLogFilterOption<TargetType>[];
  onViewDetail?: (logId: string) => void;
  emptyLabel?: string;
  /** RSC-seeded first page. Omit to keep the original fully client-fetched
   *  behavior (platform-admin's usage). */
  initialData?: PaginatedResponse<AuditLogListItem>;
  initialError?: string;
  initialFilters?: AuditLogTableInitialFilters;
}

export function AuditLogTable({
  fetchPage,
  actionTypes,
  targetTypes,
  onViewDetail,
  emptyLabel = 'No audit logs found',
  initialData,
  initialError,
  initialFilters,
}: AuditLogTableProps) {
  const table = useTable({
    defaultRowsPerPage: initialFilters?.pageSize ?? 25,
    defaultCurrentPage: (initialFilters?.page ?? 1) - 1,
  });

  const [actionTypeFilter, setActionTypeFilter] = useState<ActionType | ''>(
    initialFilters?.actionType ?? ''
  );
  const [targetTypeFilter, setTargetTypeFilter] = useState<TargetType | ''>(
    initialFilters?.targetType ?? ''
  );
  const [fromDate, setFromDate] = useState(initialFilters?.fromDate ?? '');
  const [toDate, setToDate] = useState(initialFilters?.toDate ?? '');
  const [data, setData] = useState<PaginatedResponse<AuditLogListItem> | null>(initialData ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  // The seeded page is already on screen; the effect below still runs on
  // mount (its deps include the seeded filter state), so this skips exactly
  // that one redundant fetch and lets every later filter/page change through.
  const skipNextFetch = useRef(Boolean(initialData ?? initialError));

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    const result = await fetchPage({
      page: table.page + 1,
      pageSize: table.rowsPerPage,
      actionType: actionTypeFilter || undefined,
      targetType: targetTypeFilter || undefined,
      startDate: fromDate ? `${fromDate}T00:00:00.000Z` : undefined,
      endDate: toDate ? `${toDate}T23:59:59.999Z` : undefined,
    });

    if (result?.error) {
      setError(result.error);
    } else if (result?.data) {
      setData(result.data);
    }

    setLoading(false);
  }, [fetchPage, table.page, table.rowsPerPage, actionTypeFilter, targetTypeFilter, fromDate, toDate]);

  useEffect(() => {
    if (skipNextFetch.current) {
      skipNextFetch.current = false;
      return;
    }
    fetchData();
  }, [fetchData]);

  const getActionColor = (actionType: string): 'error' | 'success' | 'warning' | 'info' => {
    if (actionType.includes('delete') || actionType.includes('denied') || actionType.includes('removed')) return 'error';
    if (actionType.includes('grant') || actionType.includes('create') || actionType.includes('invited')) return 'success';
    if (actionType.includes('revoke')) return 'warning';
    return 'info';
  };

  const getActionIcon = (actionType: string): string => {
    if (actionType.includes('denied')) return 'mdi:cancel';
    if (actionType.includes('delete') || actionType.includes('removed')) return 'mdi:delete';
    if (actionType.includes('grant') || actionType.includes('assigned')) return 'mdi:key-plus';
    if (actionType.includes('revoke') || actionType.includes('unassigned')) return 'mdi:key-remove';
    if (actionType.includes('create') || actionType.includes('invited')) return 'mdi:plus-circle';
    if (actionType.includes('update') || actionType.includes('changed')) return 'mdi:pencil';
    return 'mdi:information';
  };

  const formatActionType = (actionType: string): string => {
    return actionType
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  return (
    <Card>
      {/* Filters */}
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{ p: 3, pb: 0 }}
      >
        <TextField
          select
          size="small"
          label="Action"
          value={actionTypeFilter}
          onChange={(e) => setActionTypeFilter(e.target.value as ActionType | '')}
          sx={{ minWidth: 180 }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <Iconify icon="mdi:filter" width={20} />
                </InputAdornment>
              ),
            }
          }}
        >
          {actionTypes.map((option) => (
            <MenuItem key={option.value} value={option.value}>
              {option.label}
            </MenuItem>
          ))}
        </TextField>

        <TextField
          select
          size="small"
          label="Target"
          value={targetTypeFilter}
          onChange={(e) => setTargetTypeFilter(e.target.value as TargetType | '')}
          sx={{ minWidth: 180 }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <Iconify icon="mdi:target" width={20} />
                </InputAdornment>
              ),
            }
          }}
        >
          {targetTypes.map((option) => (
            <MenuItem key={option.value} value={option.value}>
              {option.label}
            </MenuItem>
          ))}
        </TextField>

        <TextField
          type="date"
          size="small"
          label="From"
          value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
          sx={{ minWidth: 160 }}
          slotProps={{ inputLabel: { shrink: true } }}
        />

        <TextField
          type="date"
          size="small"
          label="To"
          value={toDate}
          onChange={(e) => setToDate(e.target.value)}
          sx={{ minWidth: 160 }}
          slotProps={{ inputLabel: { shrink: true } }}
        />
      </Stack>
      <TableContainer sx={{ overflow: 'unset' }}>
        <Box sx={{ flexGrow: 1, height: '100%', maxHeight: '100%', overflow: 'auto' }}>
        <Box sx={{ minHeight: '100%' }}>
          <Table sx={{ minWidth: 800 }}>
            <TableHeadCustom headLabel={TABLE_HEAD} />

            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={5} align="center" sx={{ py: 10 }}>
                    <Typography sx={{
                      color: "text.secondary"
                    }}>Loading...</Typography>
                  </TableCell>
                </TableRow>
              ) : error ? (
                <TableRow>
                  <TableCell colSpan={5} align="center" sx={{ py: 10 }}>
                    <Typography color="error">{error}</Typography>
                  </TableCell>
                </TableRow>
              ) : data?.items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} align="center" sx={{ py: 10 }}>
                    <Box sx={{ textAlign: 'center' }}>
                      <Iconify
                        icon="mdi:clipboard-text-off"
                        width={48}
                        sx={{ color: 'text.disabled', mb: 2 }}
                      />
                      <Typography sx={{
                        color: "text.secondary"
                      }}>{emptyLabel}</Typography>
                    </Box>
                  </TableCell>
                </TableRow>
              ) : (
                data?.items.map((log) => (
                  <TableRow key={log.id} hover>
                    <TableCell>
                      <Typography variant="body2" sx={{
                        color: "text.secondary"
                      }}>
                        <LocalDate value={log.created_at} format="dateTime" absent="-" />
                      </Typography>
                    </TableCell>

                    <TableCell>
                      <Stack>
                        <Typography variant="body2" sx={{
                          fontWeight: "medium"
                        }}>
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
                    </TableCell>

                    <TableCell>
                      <Label
                        variant="soft"
                        color={getActionColor(log.action_type)}
                        startIcon={<Iconify icon={getActionIcon(log.action_type)} />}
                      >
                        {formatActionType(log.action_type)}
                      </Label>
                    </TableCell>

                    <TableCell>
                      <Stack>
                        <Typography variant="body2">
                          {log.target_identifier || log.target_id || '-'}
                        </Typography>
                        <Typography variant="caption" sx={{
                          color: "text.secondary"
                        }}>
                          {log.target_type}
                        </Typography>
                      </Stack>
                    </TableCell>

                    <TableCell align="right">
                      <Tooltip title="View details">
                        <IconButton
                          size="small"
                          onClick={() => onViewDetail?.(log.id)}
                        >
                          <Iconify icon="mdi:eye" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Box>
        </Box>
      </TableContainer>
      <TablePaginationCustom
        count={data?.total || 0}
        page={table.page}
        rowsPerPage={table.rowsPerPage}
        onPageChange={table.onChangePage}
        onRowsPerPageChange={table.onChangeRowsPerPage}
      />
    </Card>
  );
}
