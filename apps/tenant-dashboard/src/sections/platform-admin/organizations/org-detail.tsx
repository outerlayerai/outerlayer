'use client';

import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardHeader,
  Chip,
  Divider,
  Grid,
  Link,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import Iconify from '@/components/iconify';
import Label from '@/components/label';
import { createSupabaseFontendClient } from '@/supabaseFrontendClient';
import type { OrganizationDetail } from '@/types/platform-admin';
import { getPostHogTenantGroupUrl } from '@/utils/posthog-urls';
import { DeleteOrgModal } from './delete-org-modal';
import { GrantAccessModal } from '../temp-access/grant-access-modal';
import { EntitlementCard } from './entitlement-card';
import { LocalDate } from '@/components/local-date';

interface OrgDetailProps {
  organization: OrganizationDetail;
}

export function OrgDetail({ organization }: OrgDetailProps) {
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [grantAccessModalOpen, setGrantAccessModalOpen] = useState(false);
  const [ssoStatus, setSsoStatus] = useState<{
    configured: boolean;
    is_active: boolean;
    enforcement_enabled: boolean;
    allowed_domains: string[];
  } | null>(null);
  const posthogTenantUrl = getPostHogTenantGroupUrl(organization.tenant_id);

  useEffect(() => {
    const fetchSSOStatus = async () => {
      const supabase = createSupabaseFontendClient();
      // SSO tables not in generated types yet
      const { data, error } = await (supabase as any)
        .from('sso_config')
        .select('is_active, enforcement_enabled, allowed_domains')
        .eq('tenant_id', organization.tenant_id)
        .maybeSingle();

      if (error) {
        console.error('[OrgDetail] Failed to fetch SSO status for tenant:', organization.tenant_id, error);
        // Leave ssoStatus as null so the UI renders an explicit "unavailable" state
        return;
      }

      if (data) {
        setSsoStatus({
          configured: true,
          is_active: data.is_active,
          enforcement_enabled: data.enforcement_enabled,
          allowed_domains: data.allowed_domains || [],
        });
      } else {
        setSsoStatus({ configured: false, is_active: false, enforcement_enabled: false, allowed_domains: [] });
      }
    };
    fetchSSOStatus();
  }, [organization.tenant_id]);
  return (
    <>
      <Grid container spacing={3}>
        {/* Organization Info */}
        <Grid size={{ xs: 12, md: 8 }}>
          <Card>
            <CardHeader title="Organization Details" />
            <Stack spacing={2} sx={{ p: 3 }}>
              <Stack direction="row" sx={{
                justifyContent: "space-between"
              }}>
                <Typography variant="body2" sx={{
                  color: "text.secondary"
                }}>
                  Organization Name
                </Typography>
                <Typography variant="subtitle2">
                  {organization.organization_name}
                </Typography>
              </Stack>
              <Divider />
              <Stack direction="row" sx={{
                justifyContent: "space-between"
              }}>
                <Typography variant="body2" sx={{
                  color: "text.secondary"
                }}>
                  Company Name
                </Typography>
                <Typography variant="subtitle2">
                  {organization.company_name}
                </Typography>
              </Stack>
              <Divider />
              <Stack direction="row" sx={{
                justifyContent: "space-between"
              }}>
                <Typography variant="body2" sx={{
                  color: "text.secondary"
                }}>
                  Created
                </Typography>
                <Typography variant="subtitle2">
                  <LocalDate value={organization.created_at} format="dateTime" absent="-" />
                </Typography>
              </Stack>
              <Divider />
              <Stack direction="row" sx={{
                justifyContent: "space-between"
              }}>
                <Typography variant="body2" sx={{
                  color: "text.secondary"
                }}>
                  Created By
                </Typography>
                <Typography variant="subtitle2">
                  {organization.created_by?.email || '-'}
                </Typography>
              </Stack>
              <Divider />
              <Stack direction="row" sx={{
                justifyContent: "space-between"
              }}>
                <Typography variant="body2" sx={{
                  color: "text.secondary"
                }}>
                  Tenant ID
                </Typography>
                <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                  {organization.tenant_id}
                </Typography>
              </Stack>
              {posthogTenantUrl && (
                <>
                  <Divider />
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
                      href={posthogTenantUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      size="small"
                      variant="outlined"
                      startIcon={<Iconify icon="simple-icons:posthog" width={16} />}
                    >
                      View Tenant
                    </Button>
                  </Stack>
                </>
              )}
            </Stack>
          </Card>
        </Grid>

        {/* Stats */}
        <Grid size={{ xs: 12, md: 4 }}>
          <Stack spacing={3}>
            <Card sx={{ p: 3 }}>
              <Stack spacing={2}>
                <Stack direction="row" spacing={1} sx={{
                  alignItems: "center"
                }}>
                  <Iconify icon="mdi:account-group" width={24} />
                  <Typography variant="h4">{organization.users.length}</Typography>
                  <Typography variant="body2" sx={{
                    color: "text.secondary"
                  }}>
                    Users
                  </Typography>
                </Stack>
                <Stack direction="row" spacing={1} sx={{
                  alignItems: "center"
                }}>
                  <Iconify icon="mdi:application" width={24} />
                  <Typography variant="h4">{organization.apps_count}</Typography>
                  <Typography variant="body2" sx={{
                    color: "text.secondary"
                  }}>
                    Apps
                  </Typography>
                </Stack>
                <Stack direction="row" spacing={1} sx={{
                  alignItems: "center"
                }}>
                  <Iconify icon="mdi:key" width={24} />
                  <Typography variant="h4">{organization.api_keys_count}</Typography>
                  <Typography variant="body2" sx={{
                    color: "text.secondary"
                  }}>
                    API Keys
                  </Typography>
                </Stack>
              </Stack>
            </Card>

            {/* Billing */}
            <Card sx={{ p: 3 }}>
              <Typography variant="subtitle1" sx={{ mb: 2 }}>
                Billing
              </Typography>
              <Stack spacing={1}>
                <Stack direction="row" sx={{
                  justifyContent: "space-between"
                }}>
                  <Typography variant="body2" sx={{
                    color: "text.secondary"
                  }}>
                    Plan
                  </Typography>
                  <Label
                    variant="soft"
                    color={
                      organization.billing?.subscription_status === 'active'
                        ? 'success'
                        : 'default'
                    }
                  >
                    {organization.billing?.tier_display_name || 'Free'}
                  </Label>
                </Stack>
                {organization.billing?.stripe_customer_id && (
                  <Stack direction="row" sx={{
                    justifyContent: "space-between"
                  }}>
                    <Typography variant="body2" sx={{
                      color: "text.secondary"
                    }}>
                      Customer ID
                    </Typography>
                    <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
                      {organization.billing.stripe_customer_id.slice(0, 20)}...
                    </Typography>
                  </Stack>
                )}
              </Stack>
            </Card>

            {/* SSO Status */}
            <Card sx={{ p: 3 }}>
              <Typography variant="subtitle1" sx={{ mb: 2 }}>
                SSO Status
              </Typography>
              <Stack spacing={1}>
                <Stack direction="row" sx={{
                  justifyContent: "space-between"
                }}>
                  <Typography variant="body2" sx={{
                    color: "text.secondary"
                  }}>
                    Configured
                  </Typography>
                  <Label variant="soft" color={ssoStatus?.configured ? 'success' : 'default'}>
                    {ssoStatus?.configured ? 'Yes' : 'No'}
                  </Label>
                </Stack>
                {ssoStatus?.configured && (
                  <>
                    <Stack direction="row" sx={{
                      justifyContent: "space-between"
                    }}>
                      <Typography variant="body2" sx={{
                        color: "text.secondary"
                      }}>
                        Active
                      </Typography>
                      <Label variant="soft" color={ssoStatus.is_active ? 'success' : 'default'}>
                        {ssoStatus.is_active ? 'Yes' : 'No'}
                      </Label>
                    </Stack>
                    <Stack direction="row" sx={{
                      justifyContent: "space-between"
                    }}>
                      <Typography variant="body2" sx={{
                        color: "text.secondary"
                      }}>
                        Enforced
                      </Typography>
                      <Label variant="soft" color={ssoStatus.enforcement_enabled ? 'warning' : 'default'}>
                        {ssoStatus.enforcement_enabled ? 'Yes' : 'No'}
                      </Label>
                    </Stack>
                    {ssoStatus.allowed_domains.length > 0 && (
                      <Stack
                        direction="row"
                        sx={{
                          justifyContent: "space-between",
                          alignItems: "center"
                        }}>
                        <Typography variant="body2" sx={{
                          color: "text.secondary"
                        }}>
                          Domains
                        </Typography>
                        <Stack
                          direction="row"
                          sx={{
                            gap: 0.5,
                            flexWrap: "wrap",
                            justifyContent: "flex-end"
                          }}>
                          {ssoStatus.allowed_domains.map((domain: string) => (
                            <Chip key={domain} label={domain} size="small" variant="outlined" />
                          ))}
                        </Stack>
                      </Stack>
                    )}
                  </>
                )}
              </Stack>
            </Card>
          </Stack>
        </Grid>

        {/* Users Table */}
        <Grid size={12}>
          <Card>
            <CardHeader title="Users" />
            <TableContainer>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>Email</TableCell>
                    <TableCell>Name</TableCell>
                    <TableCell>Role</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {organization.users.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} align="center">
                        <Typography sx={{
                          color: "text.secondary"
                        }}>No users</Typography>
                      </TableCell>
                    </TableRow>
                  ) : (
                    organization.users.map((user) => (
                      <TableRow key={user.id}>
                        <TableCell>{user.email}</TableCell>
                        <TableCell>{user.name || '-'}</TableCell>
                        <TableCell>
                          <Label
                            variant="soft"
                            color={
                              user.role === 'owner'
                                ? 'primary'
                                : user.role === 'admin'
                                ? 'success'
                                : user.role === 'disabled'
                                ? 'error'
                                : 'default'
                            }
                          >
                            {user.role}
                          </Label>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Card>
        </Grid>

        {/* Managed Deployments */}
        {organization.managed_deployments.length > 0 && (
          <Grid size={12}>
            <Card>
              <CardHeader
                title="Managed Deployments"
                avatar={<Iconify icon="mdi:rocket-launch" />}
              />
              <TableContainer>
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableCell>App Name</TableCell>
                      <TableCell>Runtime</TableCell>
                      <TableCell>Fly App</TableCell>
                      <TableCell>Deploy Status</TableCell>
                      <TableCell>Fly Machine</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {organization.managed_deployments.map((dep) => (
                      <TableRow key={dep.app_id}>
                        <TableCell>
                          <Typography variant="subtitle2">{dep.app_name}</Typography>
                        </TableCell>
                        <TableCell>
                          <Chip label={dep.runtime} size="small" variant="outlined" />
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                            {dep.fly_app_name}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Label
                            variant="soft"
                            color={
                              dep.latest_code_status === 'deployed'
                                ? 'success'
                                : dep.latest_code_status === 'building'
                                ? 'warning'
                                : dep.latest_code_status === 'failed'
                                ? 'error'
                                : 'default'
                            }
                          >
                            {dep.latest_code_status || 'No deployments'}
                          </Label>
                        </TableCell>
                        <TableCell>
                          {dep.fly_machine_id ? (
                            <Link
                              href={`https://fly.io/apps/${dep.fly_app_name}/machines/${dep.fly_machine_id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              underline="hover"
                              sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}
                            >
                              View on Fly
                              <Iconify icon="mdi:open-in-new" width={14} />
                            </Link>
                          ) : (
                            <Typography variant="body2" sx={{
                              color: "text.disabled"
                            }}>
                              Not deployed
                            </Typography>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>
          </Grid>
        )}

        {/* Active Temp Access Grants */}
        {organization.temp_access_grants.length > 0 && (
          <Grid size={12}>
            <Card>
              <CardHeader
                title="Active Temporary Access Grants"
                avatar={<Iconify icon="mdi:shield-key" />}
              />
              <TableContainer>
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableCell>Admin Email</TableCell>
                      <TableCell>Granted At</TableCell>
                      <TableCell>Expires At</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {organization.temp_access_grants.map((grant) => (
                      <TableRow key={grant.id}>
                        <TableCell>{grant.admin_email}</TableCell>
                        <TableCell>
                          <LocalDate value={grant.created_at} format="dateTime" absent="-" />
                        </TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            color="warning"
                            label={<LocalDate value={grant.expires_at} format="dateTime" absent="-" />}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>
          </Grid>
        )}

        {/* Entitlements */}
        <Grid size={12}>
          <EntitlementCard
            tenantId={organization.tenant_id}
            organizationName={organization.organization_name}
            currentTierId={organization.billing?.tier_id || 'hobby'}
          />
        </Grid>

        {/* Admin Actions */}
        <Grid size={12}>
          <Card>
            <CardHeader title="Admin Actions" />
            <Stack sx={{ p: 3 }} spacing={2}>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={2}
                sx={{
                  justifyContent: "space-between",
                  alignItems: { xs: 'flex-start', sm: 'center' }
                }}>
                <Box>
                  <Typography variant="subtitle2">Grant Temporary Access</Typography>
                  <Typography variant="body2" sx={{
                    color: "text.secondary"
                  }}>
                    Grant yourself 24-hour read-only access to view this organization&apos;s data.
                  </Typography>
                </Box>
                <Button
                  variant="outlined"
                  startIcon={<Iconify icon="mdi:key-plus" />}
                  onClick={() => setGrantAccessModalOpen(true)}
                >
                  Grant Access
                </Button>
              </Stack>
            </Stack>
          </Card>
        </Grid>

        {/* Danger Zone */}
        <Grid size={12}>
          <Card sx={{ borderColor: 'error.main', borderWidth: 1, borderStyle: 'solid' }}>
            <CardHeader
              title="Danger Zone"
              slotProps={{ title: { color: 'error.main' } }}
            />
            <Stack sx={{ p: 3 }} spacing={2}>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={2}
                sx={{
                  justifyContent: "space-between",
                  alignItems: { xs: 'flex-start', sm: 'center' }
                }}>
                <Box>
                  <Typography variant="subtitle2">Delete this organization</Typography>
                  <Typography variant="body2" sx={{
                    color: "text.secondary"
                  }}>
                    Permanently delete this organization and all associated data. This action
                    cannot be undone.
                  </Typography>
                </Box>
                <Button
                  variant="outlined"
                  color="error"
                  startIcon={<Iconify icon="mdi:delete" />}
                  onClick={() => setDeleteModalOpen(true)}
                  data-testid="delete-org-button"
                >
                  Delete Organization
                </Button>
              </Stack>
            </Stack>
          </Card>
        </Grid>
      </Grid>
      <DeleteOrgModal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        tenantId={organization.tenant_id}
        organizationName={organization.organization_name}
        userCount={organization.users.length}
        appsCount={organization.apps_count}
        apiKeysCount={organization.api_keys_count}
        hasActiveSubscription={!!organization.billing?.stripe_subscription_id}
      />
      <GrantAccessModal
        open={grantAccessModalOpen}
        onClose={() => setGrantAccessModalOpen(false)}
        tenantId={organization.tenant_id}
        organizationName={organization.organization_name}
      />
    </>
  );
}
