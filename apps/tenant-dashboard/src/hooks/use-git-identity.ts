import { useEffect, useState, useCallback } from "react";
import { useAuthContext } from "../auth/hooks";
import { createSupabaseFontendClient } from "../supabaseFrontendClient";
import type { GitProviderType } from "@/lib/adapters/git-provider-type";

// ----------------------------------------------------------------------

interface GitIdentity {
  provider: GitProviderType;
  username: string;
  email: string | null;
}

interface UseGitIdentityReturn {
  /** Git identity for the specified provider, or null if not linked */
  identity: GitIdentity | null;
  /** All git identities for the current user */
  identities: GitIdentity[];
  /** Loading state */
  isLoading: boolean;
  /** Refresh the identity data */
  refresh: () => Promise<void>;
  /** Remove identity for a specific provider */
  removeIdentity: (provider: GitProviderType) => Promise<void>;
}

/**
 * Hook to fetch and manage git identities from user_git_identity table.
 *
 * @param provider - Optional provider to filter by (github)
 * @returns Git identity data and management functions
 */
const useGitIdentity = (provider?: GitProviderType): UseGitIdentityReturn => {
  const [identities, setIdentities] = useState<GitIdentity[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const { user } = useAuthContext();
  const supabase = createSupabaseFontendClient();

  const fetchIdentities = useCallback(async () => {
    if (!user?.id) {
      setIdentities([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      let query = supabase
        .from("user_git_identity")
        .select("provider, username, email")
        .eq("profile_id", user.id);

      if (provider) {
        query = query.eq("provider", provider);
      }

      const { data, error } = await query;

      if (error) {
        console.error("Error fetching git identities:", error);
        setIdentities([]);
      } else {
        setIdentities(
          (data || []).map((row) => ({
            provider: row.provider as GitProviderType,
            username: row.username,
            email: row.email,
          }))
        );
      }
    } finally {
      setIsLoading(false);
    }
  }, [user?.id, provider, supabase]);

  const removeIdentity = useCallback(
    async (providerToRemove: GitProviderType) => {
      if (!user?.id) return;

      const { error } = await supabase
        .from("user_git_identity")
        .delete()
        .match({ profile_id: user.id, provider: providerToRemove });

      if (error) {
        throw new Error(error.message);
      }

      // Refresh the list
      await fetchIdentities();
    },
    [user?.id, supabase, fetchIdentities]
  );

  useEffect(() => {
    fetchIdentities();
  }, [fetchIdentities]);

  // Get the identity for the specified provider (or first one if no provider specified)
  const identity = provider
    ? identities.find((i) => i.provider === provider) || null
    : identities[0] || null;

  return {
    identity,
    identities,
    isLoading,
    refresh: fetchIdentities,
    removeIdentity,
  };
};

/**
 * Get a specific provider's identity.
 */
export const useGitHubIdentity = () => useGitIdentity("github");
