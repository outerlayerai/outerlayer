'use client';

import ForbiddenView from '../../sections/error/403-view';
import { useAuthContext } from '../hooks';
import { useAppPermissions } from '../hooks/use-app-permissions';
import { useAppContext } from '@/lib/app-shell/app-context';
import type { Permission } from '../../utils/permissions';

// ----------------------------------------------------------------------

type Props = {
  /** Single permission or array of permissions (user must have ALL). */
  permission: Permission | Permission[];
  children: React.ReactNode;
};

/**
 * Client-side permission guard for page/route content.
 *
 * Permissions are resolved through `useAppPermissions(app.id)`:
 *  - Inside an app route (an app is in context) it returns the user's
 *    APP-SCOPED effective permissions via the `get_current_user_app_permissions`
 *    RPC — the SAME source the sidebar nav uses, so a route guard and its tab
 *    can never disagree. This is what makes the guard correct for app-scoped
 *    users whose org-level role is broader than their per-app role.
 *  - With no app in context (org-level routes) `useAppPermissions(null)` falls
 *    back to the org-level `user.permissions` from AuthContext — today's
 *    behavior for non-app routes.
 *
 * Renders children when the user has ALL required permission(s), ForbiddenView
 * otherwise, and null while auth/permission state is still loading (avoids a
 * flash of forbidden content).
 */
export default function PermissionGuard({ permission, children }: Props) {
  const { loading } = useAuthContext();
  const { app } = useAppContext();
  const { hasPermission, isLoading } = useAppPermissions(app?.id ?? null);

  if (loading || isLoading) {
    return null;
  }

  const required = Array.isArray(permission) ? permission : [permission];
  const hasAll = required.every((p) => hasPermission(p));

  if (!hasAll) {
    return <ForbiddenView />;
  }

  return <>{children}</>;
}
