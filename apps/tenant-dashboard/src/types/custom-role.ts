// Database row types
type CustomRoleRow = {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string | null;
  updated_by: string | null;
};


// Input types for service methods
export type CreateCustomRoleInput = {
  name: string;
  description?: string;
  permissions: string[];
};

export type UpdateCustomRoleInput = {
  name?: string;
  description?: string;
  permissions?: string[];
};



// Display types
export type CustomRoleWithPermissions = CustomRoleRow & {
  permissions: string[];
  memberCount: number;
};

export type CustomRoleDetail = CustomRoleRow & {
  permissions: string[];
  members: Array<{
    membershipId: string;
    userName: string;
    userEmail: string;
  }>;
};
