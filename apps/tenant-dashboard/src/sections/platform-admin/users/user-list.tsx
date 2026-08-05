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
  Avatar,
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
import { getPostHogPersonUrl } from '@/utils/posthog-urls';
import { listUsers } from './actions';
import type { UserListItem, PaginatedResponse } from '@/types/platform-admin';
import Label from '@/components/label';
import { LocalDate } from '@/components/local-date';

const TABLE_HEAD = [
  { id: 'email', label: 'User' },
  { id: 'organization_count', label: 'Organizations' },
  { id: 'last_sign_in_at', label: 'Last Sign In' },
  { id: 'created_at', label: 'Created' },
  { id: 'status', label: 'Status' },
  ...(POSTHOG_UI_HOST && POSTHOG_PROJECT_ID ? [{ id: 'posthog', label: '', width: 48 }] : []),
];

interface UserListProps {
  initialData?: PaginatedResponse<UserListItem>;
}

export function UserList({ initialData }: UserListProps) {
  const router = useRouter();
  const table = useTable({ defaultRowsPerPage: 25 });

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [data, setData] = useState<PaginatedResponse<UserListItem> | null>(
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

    const result = await listUsers({
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

  const handleRowClick = (userId: string) => {
    router.push(paths.platformAdmin.userDetail(userId));
  };

  const formatRelativeTime = (dateString: string | null) => {
    if (!dateString) return 'Never';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
    return `${Math.floor(diffDays / 365)} years ago`;
  };

  return (
    <Stack spacing={3}>
      <Card sx={{ p: 3 }}>
        <TextField
          fullWidth
          placeholder="Search users by email or name..."
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
                      }}>No users found</Typography>
                    </TableCell>
                  </TableRow>
                ) : (
                  data?.items.map((user) => {
                    const posthogUrl = getPostHogPersonUrl(user.email);
                    return (
                      <TableRow
                        key={user.id}
                        hover
                        onClick={() => handleRowClick(user.id)}
                        sx={{ cursor: 'pointer' }}
                      >
                        <TableCell>
                          <Stack direction="row" spacing={2} sx={{
                            alignItems: "center"
                          }}>
                            <Avatar
                              src={user.avatar_url || undefined}
                              alt={user.name || user.email}
                              sx={{ width: 40, height: 40 }}
                            >
                              {(user.name || user.email).charAt(0).toUpperCase()}
                            </Avatar>
                            <Stack>
                              <Typography variant="subtitle2">
                                {user.name || 'No name'}
                              </Typography>
                              <Typography variant="body2" sx={{
                                color: "text.secondary"
                              }}>
                                {user.email}
                              </Typography>
                            </Stack>
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <Label variant="soft" color="default">
                            {user.organization_count}
                          </Label>
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" sx={{
                            color: "text.secondary"
                          }}>
                            {formatRelativeTime(user.last_sign_in_at)}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <LocalDate value={user.created_at} format="date" absent="-" />
                        </TableCell>
                        <TableCell>
                          {user.is_platform_admin && (
                            <Label variant="soft" color="primary">
                              Platform Admin
                            </Label>
                          )}
                        </TableCell>
                        {posthogUrl && (
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <Tooltip title="View user in PostHog">
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
