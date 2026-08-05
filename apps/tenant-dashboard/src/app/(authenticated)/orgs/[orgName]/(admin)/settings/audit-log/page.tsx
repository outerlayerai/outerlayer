import { Suspense } from "react";
import { Box, CircularProgress } from "@mui/material";
import { loadRequestServiceContext, checkRequestPermission } from "@/lib/adapters";
import { Permissions } from "@/utils/permissions";
import { listAuditLog } from "@ee/features/audit-log/service";
import { listAuditLogInputSchema } from "@ee/features/audit-log/schemas";
import AuditLogSettings from "@ee/features/audit-log/components/audit-log-settings";
import type { ActionType, TargetType } from "@/types/platform-admin";

export const metadata = {
  title: "Settings: Audit log",
};

type SearchParams = Record<string, string | string[] | undefined>;

function flatten(searchParams: SearchParams): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") flat[key] = value;
  }
  return flat;
}

/**
 * The permission check runs here, server-side, rather than relying on a
 * client action's re-check — navigating here directly without `audit_log.read`
 * renders the denied state on first paint instead of after a client round trip.
 * The entitlement gate (Enterprise `audit_log`) lives inside `listAuditLog`
 * itself, shared with the table's own subsequent fetches.
 */
async function AuditLogList({ searchParams }: { searchParams: Record<string, string> }) {
  const ctx = await loadRequestServiceContext();
  const allowed = await checkRequestPermission(ctx.actor, Permissions.AUDIT_LOG_READ);
  if (!allowed) {
    return <AuditLogSettings initialError="You don't have permission to view the audit log" />;
  }

  // The SAME schema `listAuditLogAction` validates its input against — a
  // malformed `?page=` (NaN, negative, non-integer) must fail closed to the
  // defaults rather than flow into the pagination offset math unchecked.
  const parsedParams = listAuditLogInputSchema
    .pick({ page: true, pageSize: true, actionType: true, targetType: true })
    .safeParse({
      page: searchParams.page,
      pageSize: searchParams.pageSize,
      actionType: searchParams.actionType,
      targetType: searchParams.targetType,
    });
  const {
    page = 1,
    pageSize = 25,
    actionType: parsedActionType,
    targetType: parsedTargetType,
  } = parsedParams.success ? parsedParams.data : {};
  const actionType = parsedActionType as ActionType | undefined;
  const targetType = parsedTargetType as TargetType | undefined;
  const fromDate = searchParams.fromDate;
  const toDate = searchParams.toDate;

  const result = await listAuditLog(ctx.tenantId, {
    page,
    pageSize,
    actionType,
    targetType,
    startDate: fromDate ? `${fromDate}T00:00:00.000Z` : undefined,
    endDate: toDate ? `${toDate}T23:59:59.999Z` : undefined,
  });

  return (
    <AuditLogSettings
      initialData={result.data}
      initialError={result.error}
      initialFilters={{ page, pageSize, actionType: actionType ?? "", targetType: targetType ?? "", fromDate, toDate }}
    />
  );
}

export default async function AuditLogSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const flat = flatten(sp);
  // A distinct key per param set so a filter/page navigation suspends this
  // boundary specifically, mirroring the agent-sessions list precedent.
  const paramsKey = new URLSearchParams(flat).toString();

  return (
    <Suspense
      key={paramsKey}
      fallback={
        <Box sx={{ py: 8, textAlign: "center" }}>
          <CircularProgress size={22} />
        </Box>
      }
    >
      <AuditLogList searchParams={flat} />
    </Suspense>
  );
}
