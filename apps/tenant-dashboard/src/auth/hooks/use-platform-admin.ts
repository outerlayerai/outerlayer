'use client';

import { useState, useEffect } from 'react';
import { createSupabaseFontendClient } from '../../supabaseFrontendClient';
import { useAuthContext } from './use-auth-context';
import { isAllowedPlatformAdminEmail } from '../platform-admin-domain';


/**
 * Client-side hook to check if the current user is a platform admin.
 * Returns { isPlatformAdmin, loading } state.
 *
 * Platform admin requirements:
 * 1. User must be on an allowed platform-admin email domain
 * 2. User must have a row in platform_user_role table
 */
export function usePlatformAdmin() {
  const { user } = useAuthContext();
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkPlatformAdmin = async () => {
      if (!user?.id || !user?.email) {
        setIsPlatformAdmin(false);
        setLoading(false);
        return;
      }

      // 1. Email domain check
      if (!isAllowedPlatformAdminEmail(user.email)) {
        setIsPlatformAdmin(false);
        setLoading(false);
        return;
      }

      // 2. Platform role check
      try {
        const supabase = createSupabaseFontendClient();
        const { data } = await supabase
          .from('platform_user_role' as any)
          .select('role')
          .eq('user_id', user.id)
          .maybeSingle();

        setIsPlatformAdmin(!!data);
      } catch {
        setIsPlatformAdmin(false);
      }

      setLoading(false);
    };

    checkPlatformAdmin();
  }, [user?.id, user?.email]);

  return { isPlatformAdmin, loading };
}
