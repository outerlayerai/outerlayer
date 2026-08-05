'use client';

import { useState } from 'react';
import {
  Avatar,
  Button,
  Card,
  CardHeader,
  Chip,
  Grid,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import Link from 'next/link';
import Iconify from '@/components/iconify';
import Label from '@/components/label';
import type { UserDetail } from '@/types/platform-admin';
import { paths } from '@/routes/paths';
import { getPostHogPersonUrl } from '@/utils/posthog-urls';
import { DeleteUserModal } from './delete-user-modal';
import { LocalDate } from '@/components/local-date';

interface UserDetailProps {
  user: UserDetail;
}

export function UserDetailView({ user }: UserDetailProps) {
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

  // Get sole owner organizations for the delete modal warning
  const soleOwnerOrgs = user.organizations
    .filter((org) => org.is_sole_owner)
    .map((org) => ({
      tenant_id: org.tenant_id,
      organization_name: org.organization_name,
    }));

  const posthogPersonUrl = getPostHogPersonUrl(user.email);

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
    <Grid container spacing={3}>
      {/* User Profile Card */}
      <Grid size={{ xs: 12, md: 4 }}>
        <Card sx={{ p: 3 }}>
          <Stack spacing={2} sx={{
            alignItems: "center"
          }}>
            <Avatar
              src={user.avatar_url || undefined}
              alt={user.name || user.email}
              sx={{ width: 96, height: 96 }}
            >
              {(user.name || user.email).charAt(0).toUpperCase()}
            </Avatar>

            <Stack spacing={0.5} sx={{
              alignItems: "center"
            }}>
              <Typography variant="h6">{user.name || 'No name'}</Typography>
              <Typography variant="body2" sx={{
                color: "text.secondary"
              }}>
                {user.email}
              </Typography>
            </Stack>

            {user.is_platform_admin && (
              <Label variant="soft" color="primary">
                Platform Admin
              </Label>
            )}

            {user.github_username && (
              <Stack direction="row" spacing={1} sx={{
                alignItems: "center"
              }}>
                <Iconify icon="mdi:github" width={20} />
                <Typography variant="body2">{user.github_username}</Typography>
              </Stack>
            )}

            <Button
              variant="outlined"
              color="error"
              startIcon={<Iconify icon="mdi:delete" />}
              onClick={() => setDeleteModalOpen(true)}
              disabled={user.is_platform_admin}
              sx={{ mt: 2 }}
              data-testid="delete-user-button"
            >
              Delete User
            </Button>
            {user.is_platform_admin && (
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                  mt: 0.5
                }}>
                Revoke platform admin role first
              </Typography>
            )}
          </Stack>
        </Card>
      </Grid>
      {/* User Info Card */}
      <Grid size={{ xs: 12, md: 8 }}>
        <Card>
          <CardHeader title="User Details" />
          <Stack spacing={2} sx={{ p: 3 }}>
            <Stack direction="row" sx={{
              justifyContent: "space-between"
            }}>
              <Typography variant="body2" sx={{
                color: "text.secondary"
              }}>
                User ID
              </Typography>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                {user.id}
              </Typography>
            </Stack>

            {posthogPersonUrl && (
              <Stack
                direction="row"
                sx={{
                  justifyContent: "space-between",
                  alignItems: "center"
                }}>
                <Typography variant="body2" sx={{
                  color: "text.secondary"
                }}>
                  Analytics
                </Typography>
                <Button
                  component="a"
                  href={posthogPersonUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  size="small"
                  variant="outlined"
                  startIcon={<Iconify icon="simple-icons:posthog" width={16} />}
                >
                  View User
                </Button>
              </Stack>
            )}

            <Stack direction="row" sx={{
              justifyContent: "space-between"
            }}>
              <Typography variant="body2" sx={{
                color: "text.secondary"
              }}>
                Created
              </Typography>
              <Typography variant="subtitle2">
                <LocalDate value={user.created_at} format="dateTime" absent="-" />
              </Typography>
            </Stack>

            <Stack direction="row" sx={{
              justifyContent: "space-between"
            }}>
              <Typography variant="body2" sx={{
                color: "text.secondary"
              }}>
                Last Sign In
              </Typography>
              <Stack sx={{
                alignItems: "flex-end"
              }}>
                <Typography variant="subtitle2">
                  {formatRelativeTime(user.last_sign_in_at)}
                </Typography>
                {user.last_sign_in_at && (
                  <Typography variant="caption" sx={{
                    color: "text.secondary"
                  }}>
                    <LocalDate value={user.last_sign_in_at} format="dateTime" absent="-" />
                  </Typography>
                )}
              </Stack>
            </Stack>

            <Stack direction="row" sx={{
              justifyContent: "space-between"
            }}>
              <Typography variant="body2" sx={{
                color: "text.secondary"
              }}>
                Organizations
              </Typography>
              <Typography variant="subtitle2">
                {user.organizations.length}
              </Typography>
            </Stack>
          </Stack>
        </Card>
      </Grid>
      {/* Organizations Table */}
      <Grid size={12}>
        <Card>
          <CardHeader title="Organization Memberships" />
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Organization</TableCell>
                  <TableCell>Role</TableCell>
                  <TableCell>Status</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {user.organizations.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} align="center">
                      <Typography sx={{
                        color: "text.secondary"
                      }}>
                        No organization memberships
                      </Typography>
                    </TableCell>
                  </TableRow>
                ) : (
                  user.organizations.map((org) => (
                    <TableRow key={org.tenant_id}>
                      <TableCell>
                        <Link
                          href={paths.platformAdmin.organizationDetail(org.tenant_id)}
                          style={{ textDecoration: 'none', color: 'inherit' }}
                        >
                          <Typography
                            variant="subtitle2"
                            sx={{
                              '&:hover': { textDecoration: 'underline' },
                            }}
                          >
                            {org.organization_name}
                          </Typography>
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Label
                          variant="soft"
                          color={
                            org.role === 'owner'
                              ? 'primary'
                              : org.role === 'admin'
                                ? 'success'
                                : org.role === 'disabled'
                                  ? 'error'
                                  : 'default'
                          }
                        >
                          {org.role}
                        </Label>
                      </TableCell>
                      <TableCell>
                        {org.is_sole_owner && (
                          <Chip
                            size="small"
                            color="warning"
                            icon={<Iconify icon="mdi:alert" width={16} />}
                            label="Sole Owner"
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      </Grid>
      {/* Delete User Modal */}
      <DeleteUserModal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        userId={user.id}
        userEmail={user.email}
        userName={user.name}
        organizationCount={user.organizations.length}
        soleOwnerOrgs={soleOwnerOrgs}
        isPlatformAdmin={user.is_platform_admin}
      />
    </Grid>
  );
}
