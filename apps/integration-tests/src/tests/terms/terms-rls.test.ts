/**
 * Terms Agreement RLS Contract Tests
 *
 * Verifies the Row Level Security policies on the terms_agreement table against
 * a real local Supabase, asserting the resulting rows rather than the absence of
 * an error.
 *
 * These tests verify:
 * - Users can only SELECT their own terms agreement records
 * - Service role has full access for admin operations
 * - No UPDATE or DELETE allowed (append-only audit table)
 */

import {
  getSupabaseAdmin,
  createAuthenticatedUser,
  cleanupTestUsers,
  checkTableExists,
  requirePrerequisite,
  PrerequisiteCheck,
} from "../../lib/test-utils";
import { TermsAgreementService } from "tenant-dashboard/src/lib/system/terms-agreement";

describe("Terms Agreement RLS Contract Tests", () => {
  const supabaseAdmin = getSupabaseAdmin();
  let service: TermsAgreementService;
  let prerequisiteCheck: PrerequisiteCheck;

  beforeAll(async () => {
    prerequisiteCheck = await checkTableExists("terms_agreement");
    service = new TermsAgreementService({ supabaseAdmin });
  });

  afterAll(async () => {
    await cleanupTestUsers();
  });

  describe("Service Role Access (Admin Operations)", () => {
    it("should allow service role to INSERT and retrieve terms agreement records", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");
      const testVersion = `rls-insert-${Date.now()}`;

      // Use service to record agreement
      const record = await service.recordAgreement({
        userId: testUser.id,
        termsVersion: testVersion,
        ipAddress: "192.168.1.1",
        userAgent: "Integration Test",
      });

      // Assert record was created with correct data
      expect(record.id).toEqual(expect.any(String));
      expect(record.userId).toBe(testUser.id);
      expect(record.termsVersion).toBe(testVersion);
      expect(record.ipAddress).toBe("192.168.1.1");

      // Cleanup
      await supabaseAdmin.from("terms_agreement").delete().eq("id", record.id);
    });

    it("should allow service role to SELECT all terms agreement records", async () => {
      requirePrerequisite(prerequisiteCheck);

      const { data } = await supabaseAdmin
        .from("terms_agreement")
        .select("*")
        .limit(10);

      // Assert query returned an array (service role can query)
      expect(Array.isArray(data)).toBe(true);
    });

    it("should allow service role to DELETE terms agreement records (for testing cleanup)", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");
      const testVersion = `rls-delete-${Date.now()}`;

      // Create record via service
      const record = await service.recordAgreement({
        userId: testUser.id,
        termsVersion: testVersion,
      });

      // Service role should be able to delete (bypasses RLS)
      const { error: deleteError } = await supabaseAdmin
        .from("terms_agreement")
        .delete()
        .eq("id", record.id);

      // Assert delete succeeded
      expect(deleteError).toBeNull();

      // Verify record no longer exists
      const { data: verifyData } = await supabaseAdmin
        .from("terms_agreement")
        .select("id")
        .eq("id", record.id);

      expect(verifyData).toHaveLength(0);
    });
  });

  describe("Authenticated User Access (RLS Enforced)", () => {
    it("should allow user to SELECT only their own terms agreement records", async () => {
      requirePrerequisite(prerequisiteCheck);

      const user1 = await createAuthenticatedUser("read");
      const user2 = await createAuthenticatedUser("read");

      // Create agreement records for both users
      const record1 = await service.recordAgreement({
        userId: user1.id,
        termsVersion: `user1-${Date.now()}`,
      });

      const record2 = await service.recordAgreement({
        userId: user2.id,
        termsVersion: `user2-${Date.now()}`,
      });

      // User 1 queries - should only see their own records
      const { data: user1Records } = await user1.client
        .from("terms_agreement")
        .select("*");

      // Assert user1 only sees their own records
      expect(Array.isArray(user1Records)).toBe(true);
      const user1SeesOwnRecord = user1Records?.some((r) => r.id === record1.id);
      const user1SeesUser2Record = user1Records?.some((r) => r.id === record2.id);
      expect(user1SeesOwnRecord).toBe(true);
      expect(user1SeesUser2Record).toBe(false);

      // User 2 queries - should only see their own records
      const { data: user2Records } = await user2.client
        .from("terms_agreement")
        .select("*");

      // Assert user2 only sees their own records
      expect(Array.isArray(user2Records)).toBe(true);
      const user2SeesOwnRecord = user2Records?.some((r) => r.id === record2.id);
      const user2SeesUser1Record = user2Records?.some((r) => r.id === record1.id);
      expect(user2SeesOwnRecord).toBe(true);
      expect(user2SeesUser1Record).toBe(false);

      // Cleanup
      await supabaseAdmin.from("terms_agreement").delete().eq("id", record1.id);
      await supabaseAdmin.from("terms_agreement").delete().eq("id", record2.id);
    });

    it("should block authenticated user from UPDATE on terms agreement records", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");

      // Create a record via service
      const record = await service.recordAgreement({
        userId: testUser.id,
        termsVersion: `no-update-${Date.now()}`,
      });

      // Attempt to update using authenticated user client
      const { data: updateData } = await testUser.client
        .from("terms_agreement")
        .update({ terms_version: "modified-version" })
        .eq("id", record.id)
        .select();

      // RLS blocks update - returns empty array (no rows affected)
      expect(updateData).toEqual([]);

      // Verify the record was NOT modified
      const { data: unchanged } = await supabaseAdmin
        .from("terms_agreement")
        .select("terms_version")
        .eq("id", record.id)
        .single();

      expect(unchanged?.terms_version).not.toBe("modified-version");

      // Cleanup
      await supabaseAdmin.from("terms_agreement").delete().eq("id", record.id);
    });

    it("should block authenticated user from DELETE on terms agreement records", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");

      // Create a record via service
      const record = await service.recordAgreement({
        userId: testUser.id,
        termsVersion: `no-delete-${Date.now()}`,
      });

      // Attempt to delete using authenticated user client
      await testUser.client
        .from("terms_agreement")
        .delete()
        .eq("id", record.id);

      // Verify the record still exists (delete was blocked)
      const { data: stillExists } = await supabaseAdmin
        .from("terms_agreement")
        .select("id")
        .eq("id", record.id)
        .single();

      expect(stillExists).not.toBeNull();
      expect(stillExists?.id).toBe(record.id);

      // Cleanup
      await supabaseAdmin.from("terms_agreement").delete().eq("id", record.id);
    });
  });

  describe("Unique Constraint Behavior", () => {
    it("should enforce unique constraint on (user_id, terms_version)", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");
      const uniqueVersion = `unique-${Date.now()}`;

      // First insert should succeed
      const firstRecord = await service.recordAgreement({
        userId: testUser.id,
        termsVersion: uniqueVersion,
      });

      expect(firstRecord.id).toEqual(expect.any(String));

      // Second insert with same user_id and terms_version should fail
      await expect(
        service.recordAgreement({
          userId: testUser.id,
          termsVersion: uniqueVersion,
        })
      ).rejects.toThrow(/already agreed/);

      // Cleanup
      await supabaseAdmin.from("terms_agreement").delete().eq("id", firstRecord.id);
    });

    it("should allow same user to agree to different terms versions", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");
      const version1 = `v1-${Date.now()}`;
      const version2 = `v2-${Date.now()}`;

      // Record first version
      const first = await service.recordAgreement({
        userId: testUser.id,
        termsVersion: version1,
      });

      // Record second version - should succeed
      const second = await service.recordAgreement({
        userId: testUser.id,
        termsVersion: version2,
      });

      // Assert both records exist
      expect(first.termsVersion).toBe(version1);
      expect(second.termsVersion).toBe(version2);

      // Cleanup
      await supabaseAdmin.from("terms_agreement").delete().eq("id", first.id);
      await supabaseAdmin.from("terms_agreement").delete().eq("id", second.id);
    });
  });

  describe("Append-Only Audit Trail", () => {
    it("should preserve complete history of all terms agreements", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");
      const versions = [
        `v1-${Date.now()}`,
        `v2-${Date.now()}`,
        `v3-${Date.now()}`,
      ];

      const createdRecords: Array<{ id: string; termsVersion: string }> = [];

      // Create multiple agreement records via service
      for (const version of versions) {
        const record = await service.recordAgreement({
          userId: testUser.id,
          termsVersion: version,
        });
        createdRecords.push({ id: record.id, termsVersion: record.termsVersion });
      }

      // Verify all records are preserved
      const { data: history } = await supabaseAdmin
        .from("terms_agreement")
        .select("*")
        .eq("user_id", testUser.id)
        .in("terms_version", versions)
        .order("agreed_at", { ascending: true });

      // Assert all three versions exist
      expect(history).toHaveLength(3);

      const recordedVersions = history?.map((r) => r.terms_version) || [];
      expect(recordedVersions).toContain(versions[0]);
      expect(recordedVersions).toContain(versions[1]);
      expect(recordedVersions).toContain(versions[2]);

      // Cleanup
      for (const record of createdRecords) {
        await supabaseAdmin.from("terms_agreement").delete().eq("id", record.id);
      }
    });
  });
});
