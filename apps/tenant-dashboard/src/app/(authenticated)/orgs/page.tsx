"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslate } from "@outerlayer/locales";
import {
  Avatar,
  Box,
  Card,
  CardActionArea,
  Chip,
  InputAdornment,
  Skeleton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import Button from "@mui/material/Button";
import Iconify from "@/components/iconify";

import { useAuthContext } from "../../../auth/hooks";
import type { SupabaseContextType } from "../../../auth/types";
import { useMemberships } from "../../../auth/hooks/use-memberships";
import { paths } from "../../../routes/paths";
import { AppLayout } from "../../../layouts/app/app-layout";
import FormProvider, { RHFTextField } from "@/components/hook-form";
import { CreateOrgDialog } from "@/features/org-lifecycle";
import { useCreateOrg } from "@/features/org-lifecycle/hooks";

// Most-recently-used ordering is a per-user client-only preference, keyed by
// user id so it never leaks across accounts on a shared browser. Reads/writes
// are guarded — a private-mode / disabled localStorage just falls back to the
// alphabetical order.
const MRU_STORAGE_KEY = (userId: string) => `org-last-visited:${userId}`;

function readMru(userId: string): string[] {
  try {
    const raw = window.localStorage.getItem(MRU_STORAGE_KEY(userId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((o): o is string => typeof o === "string") : [];
  } catch {
    return [];
  }
}

function pushMru(userId: string, orgName: string): void {
  try {
    const next = [orgName, ...readMru(userId).filter((o) => o !== orgName)].slice(0, 20);
    window.localStorage.setItem(MRU_STORAGE_KEY(userId), JSON.stringify(next));
  } catch {
    /* localStorage unavailable — ordering silently stays alphabetical */
  }
}

// Below this many orgs a search field is noise; at/above it the list is long
// enough that scanning is slower than typing.
const SEARCH_THRESHOLD = 5;

/**
 * Organization picker page.
 *
 * Skip-company-setup: No auto-redirect to /create-organization
 * - 0 orgs: show welcoming empty state with embedded create org form
 * - 1+ orgs: show picker
 */
export default function OrgsPage() {
  const router = useRouter();
  const { loading, user } = useAuthContext() as SupabaseContextType;
  const { memberships, isAtOrgLimit } = useMemberships();
  const { t: translate } = useTranslate();

  const t = (key: string) => translate(`org.${key}`);

  const searchParams = useSearchParams();
  const forcePicker = searchParams.get("picker") === "1";

  const userId = user?.id ?? "";
  const [mru, setMru] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  // Empty-state create form shares its submit logic with the create-org dialog.
  const {
    methods: createMethods,
    onSubmit: onCreateSubmit,
    isSubmitting: isCreating,
  } = useCreateOrg();

  // Read MRU after mount only — reading localStorage during render would
  // diverge from the server render and trip a hydration mismatch.
  useEffect(() => {
    if (userId) setMru(readMru(userId));
  }, [userId]);

  // Single-org users skip the picker and land directly in their org. The picker
  // stays reachable with ?picker=1 (e.g. to create another org). No redirect
  // loop: the target (/orgs/<org>/apps) is a different route, so /orgs does not
  // re-mount unless the user navigates back explicitly.
  useEffect(() => {
    if (loading || forcePicker || memberships.length !== 1) return;
    const soleOrg = memberships[0]?.tenant?.organization_name;
    if (soleOrg) router.replace(paths.orgs.org.apps.root(soleOrg));
  }, [loading, forcePicker, memberships, router]);

  // While that redirect is in flight, show skeletons rather than flash a
  // one-row picker.
  const redirectingToSoleOrg =
    !loading && !forcePicker && memberships.length === 1;

  const rows = useMemo(() => {
    const items = memberships
      .map((membership) => {
        const orgName = membership.tenant?.organization_name;
        if (!orgName) return null;
        const companyName = membership.tenant?.company_name;
        return {
          id: membership.tenant_id,
          orgName,
          title: companyName || orgName,
          role: membership.role,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    const query = search.trim().toLowerCase();
    const filtered = query
      ? items.filter(
          (item) =>
            item.title.toLowerCase().includes(query) ||
            item.orgName.toLowerCase().includes(query)
        )
      : items;

    // MRU first (index order), everything else alphabetical by display title.
    const mruRank = (orgName: string) => {
      const idx = mru.indexOf(orgName);
      return idx === -1 ? Number.POSITIVE_INFINITY : idx;
    };
    return [...filtered].sort((a, b) => {
      const rankDelta = mruRank(a.orgName) - mruRank(b.orgName);
      return rankDelta !== 0 ? rankDelta : a.title.localeCompare(b.title);
    });
  }, [memberships, search, mru]);

  const handleEnter = (orgName: string) => {
    if (userId) pushMru(userId, orgName);
    router.push(paths.orgs.org.apps.root(orgName));
  };

  // Loading state — skeleton rows shaped like the real picker. Also covers the
  // single-org redirect so the picker never flashes for those users.
  if (loading || redirectingToSoleOrg) {
    return (
      <AppLayout>
        <Box sx={{ height: "100%", display: "flex", justifyContent: "center", p: 3 }}>
          <Box sx={{ maxWidth: 560, width: "100%", pt: { xs: 4, md: 8 } }}>
            <Stack spacing={3}>
              <Stack spacing={0.5}>
                <Skeleton variant="text" width={220} height={32} />
                <Skeleton variant="text" width={300} />
              </Stack>
              <Stack spacing={2}>
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} variant="rounded" height={80} data-testid="org-skeleton" />
                ))}
              </Stack>
            </Stack>
          </Box>
        </Box>
      </AppLayout>
    );
  }

  // Skip-company-setup: Empty state with embedded create org form
  if (memberships.length === 0) {
    return (
      <AppLayout>
        <Box
          sx={{
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Card sx={{ maxWidth: 480, width: "100%", p: 4 }}>
            <Stack spacing={3}>
              <Stack spacing={1} sx={{ textAlign: "center" }}>
                <Typography variant="h4">
                  {translate("org.createOrganization.welcome")}
                </Typography>
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  {translate("org.createOrganization.description")}
                </Typography>
              </Stack>

              <FormProvider methods={createMethods} onSubmit={onCreateSubmit}>
                <Stack spacing={2.5}>
                  <RHFTextField
                    name="companyName"
                    label={t("companyName")}
                    placeholder={t("companyNamePlaceholder")}
                    autoFocus
                  />

                  <Button
                    fullWidth
                    size="large"
                    type="submit"
                    variant="contained"
                    loading={isCreating}
                  >
                    {t("saveButton")}
                  </Button>
                </Stack>
              </FormProvider>
            </Stack>
          </Card>
        </Box>
      </AppLayout>
    );
  }

  // Show org picker
  const showSearch = memberships.length >= SEARCH_THRESHOLD;

  return (
    <AppLayout>
      <Box sx={{ height: "100%", display: "flex", justifyContent: "center", p: 3 }}>
        <Box sx={{ maxWidth: 560, width: "100%", pt: { xs: 4, md: 8 } }}>
          <Stack spacing={3}>
            <Stack
              direction="row"
              spacing={2}
              sx={{ alignItems: "flex-start", justifyContent: "space-between" }}
            >
              <Stack spacing={0.5}>
                <Typography variant="h4">Select Organization</Typography>
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  Choose which organization you want to work in
                </Typography>
              </Stack>

              <Tooltip title={isAtOrgLimit ? t("orgLimitReached") : ""}>
                <Box component="span">
                  <Button
                    variant="outlined"
                    size="medium"
                    startIcon={<Iconify icon="mdi:plus" />}
                    disabled={isAtOrgLimit}
                    onClick={() => setCreateOpen(true)}
                    sx={{ flexShrink: 0, whiteSpace: "nowrap" }}
                  >
                    New organization
                  </Button>
                </Box>
              </Tooltip>
            </Stack>

            {showSearch && (
              <TextField
                fullWidth
                size="small"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search organizations"
                slotProps={{
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">
                        <Iconify icon="mdi:magnify" width={20} />
                      </InputAdornment>
                    ),
                  },
                }}
              />
            )}

            <Stack spacing={2}>
              {rows.map((row) => (
                <Card key={row.id} variant="outlined">
                  <CardActionArea onClick={() => handleEnter(row.orgName)} sx={{ p: 2 }}>
                    <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
                      <Avatar
                        variant="rounded"
                        sx={{
                          width: 48,
                          height: 48,
                          borderRadius: 1,
                          bgcolor: "background.neutral",
                          color: "text.primary",
                          fontWeight: 600,
                        }}
                      >
                        {row.title.charAt(0).toUpperCase()}
                      </Avatar>
                      <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
                        <Typography
                          variant="subtitle1"
                          component="p"
                          noWrap
                          data-testid="org-card-title"
                        >
                          {row.title}
                        </Typography>
                        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                          <Chip label={row.role} size="small" variant="outlined" />
                          <Typography variant="caption" sx={{ color: "text.secondary" }} noWrap>
                            {row.orgName}
                          </Typography>
                        </Stack>
                      </Stack>
                      <Iconify
                        icon="mdi:chevron-right"
                        width={24}
                        sx={{ color: "text.secondary" }}
                      />
                    </Stack>
                  </CardActionArea>
                </Card>
              ))}

              {showSearch && rows.length === 0 && (
                <Typography
                  variant="body2"
                  sx={{ color: "text.secondary", textAlign: "center", py: 2 }}
                >
                  No organizations match your search
                </Typography>
              )}
            </Stack>
          </Stack>
        </Box>
      </Box>

      <CreateOrgDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </AppLayout>
  );
}
