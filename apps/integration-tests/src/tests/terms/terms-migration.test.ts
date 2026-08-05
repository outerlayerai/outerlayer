/**
 * Terms Agreement Migration Tests
 *
 * Tests for the consent_type column and database constraints. The assertions
 * exercise the real constraints rather than reimplementing them, and take no
 * branches.
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

describe("Terms Agreement Migration Tests", () => {
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

  describe("consent_type Column Schema", () => {
    it("should have consent_type column that can be queried", async () => {
      requirePrerequisite(prerequisiteCheck);

      // Verify column exists by querying it successfully
      const { data } = await supabaseAdmin
        .from("terms_agreement")
        .select("consent_type")
        .limit(1);

      // Assert query succeeded (column exists)
      expect(Array.isArray(data)).toBe(true);
    });

    it("should default consent_type to 'explicit' for new records", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");
      const testVersion = `test-default-${Date.now()}`;

      // Use service to record agreement WITHOUT specifying consentType
      const record = await service.recordAgreement({
        userId: testUser.id,
        termsVersion: testVersion,
      });

      // Assert default is 'explicit'
      expect(record.consentType).toBe("explicit");
      expect(record.userId).toBe(testUser.id);
      expect(record.termsVersion).toBe(testVersion);

      // Cleanup
      await supabaseAdmin.from("terms_agreement").delete().eq("id", record.id);
    });

    it("should accept 'implicit' as valid consent_type", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");
      const testVersion = `test-implicit-${Date.now()}`;

      // Use service to record agreement with implicit consent
      const record = await service.recordAgreement({
        userId: testUser.id,
        termsVersion: testVersion,
        consentType: "implicit",
      });

      // Assert implicit consent was recorded
      expect(record.consentType).toBe("implicit");
      expect(record.userId).toBe(testUser.id);

      // Cleanup
      await supabaseAdmin.from("terms_agreement").delete().eq("id", record.id);
    });

    it("should reject invalid consent_type values via database constraint", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");
      const testVersion = `test-invalid-${Date.now()}`;

      // Direct insert to test DB constraint (service would validate before hitting DB)
      const { error } = await supabaseAdmin.from("terms_agreement").insert({
        user_id: testUser.id,
        terms_version: testVersion,
        agreed_at: new Date().toISOString(),
        consent_type: "invalid_type",
        created_by: testUser.id,
      });

      // Assert constraint violation
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/check|violates/i);
    });
  });

  describe("Unique Constraint", () => {
    it("should prevent duplicate agreements for same user and version", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");
      const testVersion = `test-unique-${Date.now()}`;

      // First agreement should succeed
      const firstRecord = await service.recordAgreement({
        userId: testUser.id,
        termsVersion: testVersion,
      });

      expect(firstRecord.id).toEqual(expect.any(String));

      // Second agreement for same version should throw
      await expect(
        service.recordAgreement({
          userId: testUser.id,
          termsVersion: testVersion,
        })
      ).rejects.toThrow(/already agreed/);

      // Cleanup
      await supabaseAdmin.from("terms_agreement").delete().eq("id", firstRecord.id);
    });

    it("should allow same user to agree to different versions", async () => {
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

      // Assert both exist
      expect(first.termsVersion).toBe(version1);
      expect(second.termsVersion).toBe(version2);

      // Cleanup
      await supabaseAdmin.from("terms_agreement").delete().eq("id", first.id);
      await supabaseAdmin.from("terms_agreement").delete().eq("id", second.id);
    });
  });

  describe("Idempotent Backfill Pattern", () => {
    /**
     * Migration MUST be idempotent (can be safely run multiple times)
     *
     * This tests the upsert pattern used by migrations - direct DB operation
     * is appropriate here because we're testing the DATABASE behavior, not the service.
     */
    it("should not error when upserting same user/version twice", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");
      const testVersion = `idempotent-${Date.now()}`;

      // First upsert
      const { data: firstData, error: _firstError } = await supabaseAdmin
        .from("terms_agreement")
        .upsert(
          {
            user_id: testUser.id,
            terms_version: testVersion,
            agreed_at: new Date().toISOString(),
            consent_type: "implicit",
            created_by: testUser.id,
          },
          { onConflict: "user_id,terms_version", ignoreDuplicates: true }
        )
        .select()
        .single();

      expect(firstData).not.toBeNull();
      expect(firstData.user_id).toBe(testUser.id);

      // Second upsert - should succeed without error (idempotent)
      const { error: secondError } = await supabaseAdmin
        .from("terms_agreement")
        .upsert(
          {
            user_id: testUser.id,
            terms_version: testVersion,
            agreed_at: new Date().toISOString(),
            consent_type: "implicit",
            created_by: testUser.id,
          },
          { onConflict: "user_id,terms_version", ignoreDuplicates: true }
        );

      // Assert no error on second attempt
      expect(secondError).toBeNull();

      // Verify only ONE record exists
      const { data: allRecords } = await supabaseAdmin
        .from("terms_agreement")
        .select("id")
        .eq("user_id", testUser.id)
        .eq("terms_version", testVersion);

      expect(allRecords).toHaveLength(1);

      // Cleanup
      await supabaseAdmin
        .from("terms_agreement")
        .delete()
        .eq("user_id", testUser.id);
    });
  });

  describe("Query Performance", () => {
    it("should query by consent_type efficiently", async () => {
      requirePrerequisite(prerequisiteCheck);

      const startTime = Date.now();

      const { data } = await supabaseAdmin
        .from("terms_agreement")
        .select("id")
        .eq("consent_type", "explicit")
        .limit(100);

      const queryTime = Date.now() - startTime;

      // Assert query completed and was fast
      expect(Array.isArray(data)).toBe(true);
      expect(queryTime).toBeLessThan(1000);
    });
  });
});
