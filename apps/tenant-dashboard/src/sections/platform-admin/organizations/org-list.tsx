'use client';

import { useState, useCallback, useEffect } from 'react';
import {
  Box,
  Card,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableRow,
  TextField,
  InputAdornment,
  Tooltip,
  Typography,
  Stack,
  Chip,
} from '@mui/material';
import { useRouter } from 'next/navigation';
import Iconify from '@/components/iconify';
import {
  TableHeadCustom,
  TablePaginationCustom,
  useTable,
} from '@/components/table';
import { paths } from '@/routes/paths';
import { POSTHOG_UI_HOST, POSTHOG_PROJECT_ID } from '@/config-global';
import { getPostHogTenantGroupUrl } from '@/utils/posthog-urls';
import { listOrganizations } from './actions';
import type { OrganizationListItem, PaginatedResponse } from '@/types/platform-admin';
import Label from '@/components/label';
import { LocalDate } from '@/components/local-date';

const TABLE_HEAD = [
  { id: 'organization_name', label: 'Organization' },
  { id: 'company_name', label: 'Company' },
  { id: 'user_count', label: 'Users' },
  { id: 'subscription_tier', label: 'Plan' },
  { id: 'created_at', label: 'Created' },
  ...(POSTHOG_UI_HOST && POSTHOG_PROJECT_ID ? [{ id: 'posthog', label: '', width: 48 }] : []),
];

interface OrgListProps {
  initialData?: PaginatedResponse<OrganizationListItem>;
}

export function OrgList({ initialData }: OrgListProps) {
  const router = useRouter();
  const table = useTable({ defaultRowsPerPage: 25 });

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [data, setData] = useState<PaginatedResponse<OrganizationListItem> | null>(
    initialData || null
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounce search input
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);

    return () => clearTimeout(handler);
  }, [search]);

  // Fetch data when search or pagination changes
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    const result = await listOrganizations({
      page: table.page + 1,
      pageSize: table.rowsPerPage,
      search: debouncedSearch || undefined,
      sortBy: 'created_at',
      sortOrder: 'desc',
    });

    if (result.error) {
      setError(result.error);
    } else if (result.data) {
      setData(result.data);
    }

    setLoading(false);
  }, [table.page, table.rowsPerPage, debouncedSearch]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleRowClick = (tenantId: string) => {
    router.push(paths.platformAdmin.organizationDetail(tenantId));
  };

  return (
    <Stack spacing={3}>
      <Card sx={{ p: 3 }}>
        <TextField
          fullWidth
          placeholder="Search organizations..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
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
      </Card>
      <Card>
        {error && (
          <Box sx={{ p: 3, textAlign: 'center' }}>
            <Typography color="error">{error}</Typography>
          </Box>
        )}

        <TableContainer>
          <Box sx={{ flexGrow: 1, height: '100%', maxHeight: '100%', overflow: 'auto' }}>
          <Box sx={{ minHeight: '100%' }}>
            <Table size={table.dense ? 'small' : 'medium'}>
              <TableHeadCustom headLabel={TABLE_HEAD} />
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={TABLE_HEAD.length} align="center">
                      <Typography sx={{
                        color: "text.secondary"
                      }}>Loading...</Typography>
                    </TableCell>
                  </TableRow>
                ) : data?.items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={TABLE_HEAD.length} align="center">
                      <Typography sx={{
                        color: "text.secondary"
                      }}>
                        No organizations found
                      </Typography>
                    </TableCell>
                  </TableRow>
                ) : (
                  data?.items.map((org) => {
                    const posthogUrl = getPostHogTenantGroupUrl(org.tenant_id);
                    return (
                      <TableRow
                        key={org.tenant_id}
                        hover
                        onClick={() => handleRowClick(org.tenant_id)}
                        sx={{ cursor: 'pointer' }}
                      >
                        <TableCell>
                          <Typography variant="subtitle2">
                            {org.organization_name}
                          </Typography>
                        </TableCell>
                        <TableCell>{org.company_name}</TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            label={org.user_count}
                            color="default"
                            variant="outlined"
                          />
                        </TableCell>
                        <TableCell>
                          <Label
                            variant="soft"
                            color={
                              org.subscription_tier === 'pro'
                                ? 'success'
                                : org.subscription_tier === 'enterprise'
                                ? 'info'
                                : 'default'
                            }
                          >
                            {org.subscription_tier || 'free'}
                          </Label>
                        </TableCell>
                        <TableCell>
                          <LocalDate value={org.created_at} format="date" absent="-" />
                        </TableCell>
                        {posthogUrl && (
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <Tooltip title="View tenant in PostHog">
                              <IconButton
                                component="a"
                                href={posthogUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                size="small"
                              >
                                <Iconify icon="simple-icons:posthog" width={18} />
                              </IconButton>
                            </Tooltip>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })
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
          dense={table.dense}
          onChangeDense={table.onChangeDense}
        />
      </Card>
    </Stack>
  );
}
