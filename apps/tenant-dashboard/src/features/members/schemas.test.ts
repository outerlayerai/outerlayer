import {
  sendInviteInputSchema,
  resendInviteInputSchema,
  changeMemberRoleInputSchema,
  removeMemberInputSchema,
} from "./schemas";

const VALID_INVITE = {
  name: "Ryan",
  email: "ryan@example.com",
  role: "write" as const,
};

describe("sendInviteInputSchema", () => {
  it("accepts a minimal valid invite with no appRoles", () => {
    const result = sendInviteInputSchema.safeParse(VALID_INVITE);
    expect(result.success).toBe(true);
  });

  it("accepts every app-member role in appRoles", () => {
    for (const role of ["read", "write", "admin"]) {
      const result = sendInviteInputSchema.safeParse({
        ...VALID_INVITE,
        appRoles: [{ appId: "app-1", role }],
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an appRoles entry with a role outside read/write/admin", () => {
    const result = sendInviteInputSchema.safeParse({
      ...VALID_INVITE,
      appRoles: [{ appId: "app-1", role: "owner" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an appRoles entry with an empty appId", () => {
    const result = sendInviteInputSchema.safeParse({
      ...VALID_INVITE,
      appRoles: [{ appId: "", role: "read" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an appRoles entry missing appId or role", () => {
    const result = sendInviteInputSchema.safeParse({
      ...VALID_INVITE,
      appRoles: [{}],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty customRoleId", () => {
    const result = sendInviteInputSchema.safeParse({ ...VALID_INVITE, customRoleId: "" });
    expect(result.success).toBe(false);
  });

  it("accepts a non-empty customRoleId", () => {
    const result = sendInviteInputSchema.safeParse({ ...VALID_INVITE, customRoleId: "cr-1" });
    expect(result.success).toBe(true);
  });
});

describe("resendInviteInputSchema", () => {
  it("rejects an empty email", () => {
    expect(resendInviteInputSchema.safeParse({ email: "" }).success).toBe(false);
  });
});

describe("changeMemberRoleInputSchema", () => {
  it("accepts a null customRoleId (clearing a custom role)", () => {
    const result = changeMemberRoleInputSchema.safeParse({
      userId: "user-1",
      role: "read",
      customRoleId: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty customRoleId", () => {
    const result = changeMemberRoleInputSchema.safeParse({
      userId: "user-1",
      role: "read",
      customRoleId: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("removeMemberInputSchema", () => {
  it("rejects an empty userId", () => {
    expect(removeMemberInputSchema.safeParse({ userId: "" }).success).toBe(false);
  });
});
