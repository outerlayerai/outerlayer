/**
 * Terms Agreement Service Integration Tests
 *
 * These tests verify TermsAgreementService methods against a real local Supabase.
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

describe("TermsAgreementService Integration Tests", () => {
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

  describe("hasAnyAgreement", () => {
    it("should return true when user has any agreement", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");
      const testVersion = `test-any-${Date.now()}`;

      // Arrange: Create an agreement via service
      await service.recordAgreement({
        userId: testUser.id,
        termsVersion: testVersion,
      });

      // Act
      const result = await service.hasAnyAgreement(testUser.id);

      // Assert
      expect(result).toBe(true);

      // Cleanup
      await supabaseAdmin
        .from("terms_agreement")
        .delete()
        .eq("user_id", testUser.id);
    });

    it("should return false when user has no agreement", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");

      // Ensure no agreement exists
      await supabaseAdmin
        .from("terms_agreement")
        .delete()
        .eq("user_id", testUser.id);

      // Act
      const result = await service.hasAnyAgreement(testUser.id);

      // Assert
      expect(result).toBe(false);
    });

    it("should return true regardless of terms version (non-blocking policy)", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");
      const oldVersion = "2024-01-01"; // Old version

      // Arrange: Create agreement with OLD version
      await service.recordAgreement({
        userId: testUser.id,
        termsVersion: oldVersion,
      });

      // Act: Check if user has ANY agreement
      const result = await service.hasAnyAgreement(testUser.id);

      // Assert: Should be true even with old version
      expect(result).toBe(true);

      // Cleanup
      await supabaseAdmin
        .from("terms_agreement")
        .delete()
        .eq("user_id", testUser.id);
    });
  });

  describe("recordAgreement", () => {
    it("should record agreement with explicit consent by default", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");
      const testVersion = `test-explicit-${Date.now()}`;

      // Act
      const result = await service.recordAgreement({
        userId: testUser.id,
        termsVersion: testVersion,
      });

      // Assert
      expect(result.userId).toBe(testUser.id);
      expect(result.termsVersion).toBe(testVersion);
      expect(result.consentType).toBe("explicit");
      expect(result.id).toEqual(expect.any(String));

      // Cleanup
      await supabaseAdmin.from("terms_agreement").delete().eq("id", result.id);
    });

    it("should record agreement with implicit consent when specified", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");
      const testVersion = `test-implicit-${Date.now()}`;

      // Act
      const result = await service.recordAgreement({
        userId: testUser.id,
        termsVersion: testVersion,
        consentType: "implicit",
      });

      // Assert
      expect(result.consentType).toBe("implicit");

      // Cleanup
      await supabaseAdmin.from("terms_agreement").delete().eq("id", result.id);
    });

    it("should throw error when duplicate agreement for same version", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");
      const testVersion = `test-duplicate-${Date.now()}`;

      // Arrange: Create first agreement
      const first = await service.recordAgreement({
        userId: testUser.id,
        termsVersion: testVersion,
      });

      // Act & Assert: Second agreement should throw
      await expect(
        service.recordAgreement({
          userId: testUser.id,
          termsVersion: testVersion,
        })
      ).rejects.toThrow(/already agreed/);

      // Cleanup
      await supabaseAdmin.from("terms_agreement").delete().eq("id", first.id);
    });

    it("should allow multiple agreements for different versions", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");
      const version1 = `v1-${Date.now()}`;
      const version2 = `v2-${Date.now()}`;

      // Act: Create agreements for different versions
      const first = await service.recordAgreement({
        userId: testUser.id,
        termsVersion: version1,
        consentType: "explicit",
      });

      const second = await service.recordAgreement({
        userId: testUser.id,
        termsVersion: version2,
        consentType: "implicit",
      });

      // Assert: Both should exist
      expect(first.termsVersion).toBe(version1);
      expect(second.termsVersion).toBe(version2);

      // Cleanup
      await supabaseAdmin.from("terms_agreement").delete().eq("id", first.id);
      await supabaseAdmin.from("terms_agreement").delete().eq("id", second.id);
    });
  });

  describe("checkTermsStatus", () => {
    it("should return needsCurrentVersion=true when user has no agreement", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");

      // Ensure no agreement
      await supabaseAdmin
        .from("terms_agreement")
        .delete()
        .eq("user_id", testUser.id);

      // Act
      const result = await service.checkTermsStatus(testUser.id, "2026-01-10");

      // Assert
      expect(result).toEqual({
        hasAgreed: false,
        needsCurrentVersion: true,
      });
    });

    it("should return needsCurrentVersion=false when user has any agreement (non-blocking)", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");
      const oldVersion = "2020-01-01";
      const currentVersion = "2026-01-10";

      // Arrange: Create agreement with OLD version
      const agreement = await service.recordAgreement({
        userId: testUser.id,
        termsVersion: oldVersion,
      });

      // Act: Check status against CURRENT version
      const result = await service.checkTermsStatus(testUser.id, currentVersion);

      // Assert: Should NOT need current version (non-blocking policy)
      expect(result.hasAgreed).toBe(true);
      expect(result.needsCurrentVersion).toBe(false);
      expect(result.agreedVersion).toBe(oldVersion);
      expect(result.consentType).toBe("explicit");

      // Cleanup
      await supabaseAdmin.from("terms_agreement").delete().eq("id", agreement.id);
    });

    it("should return latest agreement info when multiple exist", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");
      const version1 = "2024-01-01";
      const version2 = "2025-01-01";

      // Arrange: Create multiple agreements
      const first = await service.recordAgreement({
        userId: testUser.id,
        termsVersion: version1,
        consentType: "explicit",
      });

      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 10));

      const second = await service.recordAgreement({
        userId: testUser.id,
        termsVersion: version2,
        consentType: "implicit",
      });

      // Act
      const result = await service.checkTermsStatus(testUser.id, "2026-01-10");

      // Assert: Should return latest (version2)
      expect(result.agreedVersion).toBe(version2);
      expect(result.consentType).toBe("implicit");

      // Cleanup
      await supabaseAdmin.from("terms_agreement").delete().eq("id", first.id);
      await supabaseAdmin.from("terms_agreement").delete().eq("id", second.id);
    });
  });

  describe("getLatestAgreement", () => {
    it("should return most recent agreement", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");
      const version1 = `old-${Date.now()}`;
      const version2 = `new-${Date.now()}`;

      // Arrange
      const first = await service.recordAgreement({
        userId: testUser.id,
        termsVersion: version1,
      });

      await new Promise((r) => setTimeout(r, 10));

      const second = await service.recordAgreement({
        userId: testUser.id,
        termsVersion: version2,
      });

      // Act
      const latest = await service.getLatestAgreement(testUser.id);

      // Assert
      expect(latest).not.toBeNull();
      expect(latest!.termsVersion).toBe(version2);

      // Cleanup
      await supabaseAdmin.from("terms_agreement").delete().eq("id", first.id);
      await supabaseAdmin.from("terms_agreement").delete().eq("id", second.id);
    });

    it("should return null when no agreements exist", async () => {
      requirePrerequisite(prerequisiteCheck);

      const testUser = await createAuthenticatedUser("read");

      // Ensure no agreements
      await supabaseAdmin
        .from("terms_agreement")
        .delete()
        .eq("user_id", testUser.id);

      // Act
      const latest = await service.getLatestAgreement(testUser.id);

      // Assert
      expect(latest).toBeNull();
    });
  });

});
