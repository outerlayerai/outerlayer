import { getSupabaseAdmin, createAuthenticatedUser, cleanupTestUsers } from '../lib/test-utils';

/**
 * Tests the database trigger that syncs auth.users.email → public.profile.email.
 *
 * Migration: 20260204184217_sync_auth_email_to_profile.sql
 * Trigger: on_auth_user_updated_sync_email (AFTER UPDATE on auth.users)
 */
describe('Profile email sync trigger', () => {
  const admin = getSupabaseAdmin();

  afterAll(async () => {
    await cleanupTestUsers();
  });

  it('should sync email to profile when auth.users email is updated', async () => {
    // Arrange - create a user with a profile
    const user = await createAuthenticatedUser('owner');
    const newEmail = `updated-${crypto.randomUUID()}@testcompany.com`;

    // Verify initial state: profile email matches auth email
    const { data: profileBefore } = await admin
      .from('profile')
      .select('email')
      .eq('id', user.id)
      .single();
    expect(profileBefore?.email).toBe(user.email);

    // Act - update auth email via admin API (simulates completed email verification)
    const { error } = await admin.auth.admin.updateUserById(user.id, {
      email: newEmail,
    });
    expect(error).toBeNull();

    // Assert - profile email should be updated by the trigger
    const { data: profileAfter } = await admin
      .from('profile')
      .select('email')
      .eq('id', user.id)
      .single();
    expect(profileAfter?.email).toBe(newEmail);
  });

  it('should not update profile when non-email auth fields change', async () => {
    // Arrange
    const user = await createAuthenticatedUser('owner');

    // Act - update a non-email field on auth.users
    const { error } = await admin.auth.admin.updateUserById(user.id, {
      user_metadata: { display_name: 'New Display Name' },
    });
    expect(error).toBeNull();

    // Assert - profile email should remain unchanged
    const { data: profile } = await admin
      .from('profile')
      .select('email')
      .eq('id', user.id)
      .single();
    expect(profile?.email).toBe(user.email);
  });
});
