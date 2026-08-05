"use client";

import { useState } from "react";
import { UserList, type User } from "@/features/members/components/user-list";
import { ManageAppAccessDialog } from "@ee/features/app-access/components/manage-app-access-dialog";

type CustomRoleOption = { id: string; name: string };
type AppOption = { id: string; name: string };

type Props = {
  users: User[];
  appLevelRolesEnabled: boolean;
  customRolesEnabled: boolean;
  customRoles: CustomRoleOption[];
  apps: AppOption[];
};

/**
 * Composes the core members list with the EE app-access dialog. `UserList`
 * (src/features/members) never imports `ee/**` directly — a feature is a
 * leaf and may not reach a sibling feature, EE or otherwise — so this
 * client module in the route tree owns the dialog's open state and renders
 * both.
 */
export function MembersView({ users, appLevelRolesEnabled, customRolesEnabled, customRoles, apps }: Props) {
  const [target, setTarget] = useState<{ membershipId: string; name: string | null; email: string | null } | null>(
    null,
  );

  return (
    <>
      <UserList
        users={users}
        appLevelRolesEnabled={appLevelRolesEnabled}
        customRolesEnabled={customRolesEnabled}
        customRoles={customRoles}
        apps={apps}
        onManageAppAccess={setTarget}
      />
      {target && (
        <ManageAppAccessDialog
          open
          onClose={() => setTarget(null)}
          membershipId={target.membershipId}
          userName={target.name ?? ""}
          userEmail={target.email ?? ""}
          customRoles={customRoles}
        />
      )}
    </>
  );
}
