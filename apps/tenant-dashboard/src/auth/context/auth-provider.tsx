"use client";

import React, { useMemo, useEffect, useReducer, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import posthog from "posthog-js";
import * as Sentry from "@/lib/observability/error-reporting/sentry";

import { paths } from "../../routes/paths";

import { createSupabaseFontendClient } from "../../supabaseFrontendClient";
import { AuthContext } from "./auth-context";
import { AuthUserType, ActionMapType, AuthStateType, UserRole } from "../types";
import { getCurrentUserPermissions } from "../../utils/get-user-permissions";
import { revalidateServerPath } from "../../utils/actions";
import { MembershipWithTenant, ActiveTenant } from "../../types/membership";
import { Database } from "../../types/db";
import { EmailChangeResult } from "../../types/email-change";
import { getEmailChangeErrorCode } from "../../utils/email-error-mapper";

// ----------------------------------------------------------------------

/**
 * Initialize PostHog analytics (only once, after user authentication)
 * This ensures we only track users who have agreed to terms
 */
function initPostHogIfNeeded(): boolean {
  // Check if already initialized
  if (posthog.__loaded) {
    return true;
  }

  const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;

  if (posthogKey && posthogHost) {
    posthog.init(posthogKey, {
      api_host: posthogHost,
      capture_pageview: false,
      capture_pageleave: true,
      autocapture: false,
    });
    return true;
  }
  return false;
}

/**
 * Identifies user and associates with tenant group in PostHog
 * Only calls identify if PostHog is initialized
 */
function identifyUserInPostHog(
  userId: string,
  email: string | undefined,
  displayName: string | undefined,
  activeTenant: ActiveTenant | null
) {
  if (!posthog.__loaded) {
    return;
  }

  posthog.identify(userId, {
    email,
    name: displayName,
  });

  if (activeTenant) {
    posthog.group("tenant", activeTenant.tenant_id, {
      name: activeTenant.organization_name,
    });
  }
}

/**
 * Sets user and organization context in Sentry/BetterStack error tracking
 * This allows errors to be associated with specific users and organizations
 */
function setErrorTrackingContext(
  userId: string,
  email: string | undefined,
  activeTenant: ActiveTenant | null
) {
  Sentry.setUser({
    id: userId,
    email: email,
  });

  // Set organization context as tags (visible in error details)
  if (activeTenant) {
    Sentry.setTag("organization_id", activeTenant.tenant_id);
    Sentry.setTag("organization_name", activeTenant.organization_name);
  }
}

type RateLimitedError = Error & {
  status: number;
  code: string;
};

// ----------------------------------------------------------------------
/**
 * NOTE:
 * We only build demo at basic level.
 * Customer will need to do some extra handling yourself if you want to extend the logic and other features...
 */
// ----------------------------------------------------------------------

enum Types {
  INITIAL = "INITIAL",
  LOGIN = "LOGIN",
  REGISTER = "REGISTER",
  LOGOUT = "LOGOUT",
  SESSION_UPDATE = "SESSION_UPDATE",
}

type Payload = {
  [Types.INITIAL]: {
    user: AuthUserType;
  };
  [Types.LOGIN]: {
    user: AuthUserType;
  };
  [Types.REGISTER]: {
    user: AuthUserType;
  };
  [Types.SESSION_UPDATE]: {
    user: AuthUserType;
  };
  [Types.LOGOUT]: undefined;
};

type ActionsType = ActionMapType<Payload>[keyof ActionMapType<Payload>];

// ----------------------------------------------------------------------

const initialState: AuthStateType = {
  user: null,
  loading: true,
};

const reducer = (state: AuthStateType, action: ActionsType) => {
  if (action.type === Types.INITIAL) {
    return {
      loading: false,
      user: action.payload.user,
    };
  }
  if (action.type === Types.LOGIN) {
    return {
      ...state,
      user: action.payload.user,
    };
  }
  if (action.type === Types.REGISTER) {
    return {
      ...state,
      user: action.payload.user,
    };
  }
  if (action.type === Types.SESSION_UPDATE) {
    return {
      ...state,
      user: action.payload.user,
    };
  }

  if (action.type === Types.LOGOUT) {
    // Idempotent: session death can be signalled more than once (an explicit
    // sign-out followed by the auth listener's SIGNED_OUT event). Returning
    // the same reference when already logged out avoids a redundant render.
    if (state.user === null) {
      return state;
    }
    return {
      ...state,
      user: null,
    };
  }
  return state;
};

// ----------------------------------------------------------------------

/**
 * Fetches all memberships for a user with tenant and role information
 * Query membership + tenant, then fetch roles separately
 */
async function fetchUserMemberships(
  supabase: ReturnType<typeof createSupabaseFontendClient>,
  userId: string
): Promise<MembershipWithTenant[]> {
  // First, get memberships with tenant info
  const { data: memberships, error: membershipError } = await supabase
    .from("membership")
    .select(
      `
      id,
      user_id,
      tenant_id,
      role,
      status,
      invited_at,
      invited_by,
      expires_at,
      created_at,
      tenant:tenant_id (
        tenant_id,
        organization_name,
        company_name
      )
    `
    )
    .eq("user_id", userId)
    .eq("status", "active");

  if (membershipError) {
    console.error("Error fetching memberships:", membershipError);
    return [];
  }

  if (!memberships || memberships.length === 0) {
    return [];
  }

  // Transform the data to match MembershipWithTenant interface
  type AppRole = Database["public"]["Enums"]["app_role"];
  return memberships.map((m: any) => ({
    id: m.id,
    user_id: m.user_id,
    tenant_id: m.tenant_id,
    status: m.status,
    invited_at: m.invited_at,
    invited_by: m.invited_by,
    expires_at: m.expires_at,
    created_at: m.created_at,
    tenant: m.tenant,
    role: m.role || ("read" as AppRole),
  }));
}

/**
 * Derives active tenant from memberships based on the resolved tenant id.
 * Active tenant state derived from memberships
 */
function deriveActiveTenant(
  memberships: MembershipWithTenant[],
  activeTenantId: string | undefined
): ActiveTenant | null {
  if (!activeTenantId || memberships.length === 0) {
    return null;
  }

  const activeMembership = memberships.find(
    (m) => m.tenant_id === activeTenantId
  );

  // No membership match (not a member of this org, or no org in view): no
  // fallback to an arbitrary membership — downstream readers see null.
  if (!activeMembership) {
    return null;
  }

  return {
    tenant_id: activeMembership.tenant_id,
    organization_name: activeMembership.tenant.organization_name,
    company_name: activeMembership.tenant.company_name,
    role: activeMembership.role,
  };
}

/** The membership whose org matches the URL slug, resolved through the
 * caller's own active memberships — mirrors `useUrlTenantId` /
 * `getRequestTenantId()`'s server-side counterpart. Undefined when the path
 * carries no org or the user isn't an active member of it. */
function resolveTenantIdForOrgName(
  memberships: MembershipWithTenant[],
  orgName: string | undefined
): string | undefined {
  if (!orgName) return undefined;
  return memberships.find((m) => m.tenant.organization_name === orgName)?.tenant_id;
}

/**
 * Fetches the full tenant row that backs `activeTenant`.
 * Returns null without querying
 * when activeTenantId is undefined (no org in the URL, or not a member of
 * it) — querying anyway sends a literal "undefined" tenant_id to Postgres
 * and 22P02s.
 */
async function fetchActiveTenant(
  supabase: ReturnType<typeof createSupabaseFontendClient>,
  activeTenantId: string | undefined
): Promise<Database["public"]["Tables"]["tenant"]["Row"] | null> {
  if (!activeTenantId) {
    return null;
  }
  const { data: tenant } = await supabase
    .from("tenant")
    .select("*")
    .match({ tenant_id: activeTenantId })
    .single();
  return tenant;
}

// ----------------------------------------------------------------------

/**
 * Tears down client-side session state: clears analytics + error-tracking
 * identity and resets auth context. Shared by the explicit logout() and the
 * auth listener's SIGNED_OUT handling so a session death from any source
 * (revocation, tenant-claim flip, another tab's sign-out) is torn down the
 * same way.
 */
function resetSessionState(dispatch: React.Dispatch<ActionsType>) {
  posthog.reset();
  Sentry.setUser(null);
  dispatch({ type: Types.LOGOUT });
}

// ----------------------------------------------------------------------

type Props = {
  children: React.ReactNode;
};

export function AuthProvider({ children }: Props) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const supabase = createSupabaseFontendClient();

  // The org in the URL — the authoritative tenant source, mirroring
  // getRequestTenantId()'s server-side header derivation. Read into a ref
  // (kept current on every render) so the auth-event handlers below, set up
  // once on mount, always resolve against the URL as of the event rather
  // than whatever it was when the listener was attached.
  const params = useParams<{ orgName?: string | string[] }>();
  const rawOrgName = params?.orgName;
  const orgName = Array.isArray(rawOrgName) ? rawOrgName[0] : rawOrgName;
  const orgNameRef = useRef(orgName);
  useEffect(() => {
    orgNameRef.current = orgName;
  }, [orgName]);

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      // https://supabase.com/docs/reference/javascript/auth-onauthstatechange
      setTimeout(async () => {
        if (event === "INITIAL_SESSION") {
          if (session) {
            const permissions = await getCurrentUserPermissions();
            const memberships = await fetchUserMemberships(
              supabase,
              session.user.id
            );
            const activeTenantId = resolveTenantIdForOrgName(memberships, orgNameRef.current);
            const activeTenant = deriveActiveTenant(memberships, activeTenantId);
            const tenant = await fetchActiveTenant(supabase, activeTenantId);

            // PostHog: Initialize (if not already) and identify user
            // This ensures PostHog only starts after user authentication (terms accepted)
            initPostHogIfNeeded();
            identifyUserInPostHog(
              session.user.id,
              session.user.email,
              session.user.user_metadata?.display_name,
              activeTenant
            );

            // BetterStack Error Tracking: Set user and org context
            setErrorTrackingContext(
              session.user.id,
              session.user.email,
              activeTenant
            );

            dispatch({
              type: Types.INITIAL,
              payload: {
                user: {
                  ...session.user,
                  permissions,
                  tenant,
                  memberships,
                  activeTenant,
                  session: {
                    access_token: session.access_token,
                    expires_at: session.expires_at,
                    expires_in: session.expires_in,
                    refresh_token: session.refresh_token,
                    token_type: session.token_type,
                  },
                },
              },
            });
          } else {
            dispatch({
              type: Types.INITIAL,
              payload: {
                user: null,
              },
            });
          }
        }
        if (event === "TOKEN_REFRESHED" && session) {
          const permissions = await getCurrentUserPermissions();
          const memberships = await fetchUserMemberships(
            supabase,
            session.user.id
          );
          const activeTenantId = resolveTenantIdForOrgName(memberships, orgNameRef.current);
          const activeTenant = deriveActiveTenant(memberships, activeTenantId);
          const tenant = await fetchActiveTenant(supabase, activeTenantId);

          // Note: No identify call on TOKEN_REFRESHED to avoid duplicate calls
          // User was already identified during INITIAL_SESSION

          // BetterStack Error Tracking: Update context on session refresh
          setErrorTrackingContext(
            session.user.id,
            session.user.email,
            activeTenant
          );

          dispatch({
            type: Types.SESSION_UPDATE,
            payload: {
              user: {
                ...session.user,
                tenant,
                memberships,
                activeTenant,
                permissions,
                session: {
                  access_token: session.access_token,
                  expires_at: session.expires_at,
                  expires_in: session.expires_in,
                  refresh_token: session.refresh_token,
                  token_type: session.token_type,
                },
              },
            },
          });
        }
        if (event === "SIGNED_OUT") {
          // A revoked/expired session or another tab's sign-out invalidates the
          // local session without an explicit logout() call here. Tear down
          // identity and context so guards stop treating the user as
          // authenticated.
          resetSessionState(dispatch);
        }
      }, 0);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  // LOGIN
  const login = useCallback(async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      dispatch({
        type: Types.LOGIN,
        payload: {
          user: null,
        },
      });
      console.error(error);
      
      // Enhance rate limiting error messages
      if (error.message?.toLowerCase().includes('too many login attempts') || 
          error.message?.toLowerCase().includes('rate limit') ||
          error.message?.toLowerCase().includes('too many requests') ||
          error.status === 429 ||
          error.code === 'RATE_LIMIT_EXCEEDED') {
        const enhancedError = new Error('Too many login attempts') as RateLimitedError;
        enhancedError.status = 429;
        enhancedError.code = 'RATE_LIMIT_EXCEEDED';
        throw enhancedError;
      }
      
      throw error;
    } else {
      const permissions = await getCurrentUserPermissions();
      revalidateServerPath("/org");
      const memberships = await fetchUserMemberships(supabase, data.user.id);
      const activeTenantId = resolveTenantIdForOrgName(memberships, orgNameRef.current);
      const activeTenant = deriveActiveTenant(memberships, activeTenantId);
      const tenant = await fetchActiveTenant(supabase, activeTenantId);

      dispatch({
        type: Types.LOGIN,
        payload: {
          user: {
            ...data.user,
            tenant: tenant,
            memberships,
            activeTenant,
            permissions,
            session: {
              access_token: data.session.access_token,
              expires_at: data.session.expires_at,
              expires_in: data.session.expires_in,
              refresh_token: data.session.refresh_token,
              token_type: data.session.token_type,
            },
          },
        },
      });
    }
  }, []);

  // REGISTER
  const register = useCallback(
    async (
      email: string,
      password: string,
      firstName: string,
      lastName: string
    ) => {
      const { error, data } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}${paths.dashboard.root}`,
          data: {
            display_name: `${firstName} ${lastName}`,
          },
        },
      });

      if (error) {
        console.error(error);
        throw error;
      }
      return data;
    },
    []
  );

  // LOGOUT
  const logout = useCallback(async () => {
    const { error } = await supabase.auth.signOut();

    if (error) {
      console.error(error);
      throw error;
    }

    resetSessionState(dispatch);
  }, []);

  // FORGOT PASSWORD
  const forgotPassword = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}${paths.auth.newPassword}`,
    });

    if (error) {
      console.error(error);
      throw error;
    }
  }, []);

  // NEW PASSWORD
  const updatePassword = useCallback(async (password: string) => {
    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      console.error(error);
      throw error;
    }
  }, []);

  // UPDATE EMAIL
  const updateEmail = useCallback(
    async (newEmail: string): Promise<EmailChangeResult> => {
      const { error } = await supabase.auth.updateUser(
        { email: newEmail },
        {
          emailRedirectTo: `${window.location.origin}/auth/callback?type=email_change`,
        }
      );

      if (error) {
        console.error("Email update error:", error);
        const errorCode = getEmailChangeErrorCode(error);
        return { success: false, errorCode };
      }

      return { success: true };
    },
    []
  );

  // REFRESH MEMBERSHIPS
  // Fetches fresh memberships and updates auth state. Returns promise that resolves when state is updated.
  const refreshMemberships = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();

    if (!session) {
      return;
    }

    // Refresh the session to pick up any auth-state change (e.g. a role or
    // membership update).
    const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError) {
      console.error("Error refreshing session:", refreshError);
      throw refreshError;
    }

    const currentSession = refreshData.session;
    if (!currentSession) {
      return;
    }

    const permissions = await getCurrentUserPermissions();
    const memberships = await fetchUserMemberships(supabase, currentSession.user.id);
    const activeTenantId = resolveTenantIdForOrgName(memberships, orgNameRef.current);
    const activeTenant = deriveActiveTenant(memberships, activeTenantId);
    const tenant = await fetchActiveTenant(supabase, activeTenantId);

    dispatch({
      type: Types.SESSION_UPDATE,
      payload: {
        user: {
          ...currentSession.user,
          tenant,
          memberships,
          activeTenant,
          permissions,
          session: {
            access_token: currentSession.access_token,
            expires_at: currentSession.expires_at,
            expires_in: currentSession.expires_in,
            refresh_token: currentSession.refresh_token,
            token_type: currentSession.token_type,
          },
        },
      },
    });
  }, []);

  // ----------------------------------------------------------------------

  const checkAuthenticated = state.user ? "authenticated" : "unauthenticated";

  const status = state.loading ? "loading" : checkAuthenticated;

  // Recomputed on every render from the CURRENT URL org, not just on auth
  // events — a navigation via the org switcher changes `orgName` with no auth
  // event to pick it up, and `activeTenant.role` is what client-side role
  // gates read. A non-member org (or no org in the URL) resolves to null.
  const activeTenant = useMemo(
    () =>
      deriveActiveTenant(
        state.user?.memberships ?? [],
        resolveTenantIdForOrgName(state.user?.memberships ?? [], orgName)
      ),
    [state.user?.memberships, orgName]
  );

  const memoizedValue = useMemo(
    () => ({
      user: {
        ...state.user,
        activeTenant,
        role: activeTenant?.role as UserRole,
        displayName: `${state.user?.user_metadata?.display_name}`,
      },
      method: "supabase",
      loading: status === "loading",
      authenticated: status === "authenticated",
      unauthenticated: status === "unauthenticated",
      //
      login,
      register,
      logout,
      forgotPassword,
      updatePassword,
      updateEmail,
      refreshMemberships,
    }),
    [
      forgotPassword,
      login,
      logout,
      updatePassword,
      updateEmail,
      register,
      refreshMemberships,
      state.user,
      activeTenant,
      status,
    ]
  );

  return (
    <AuthContext.Provider value={memoizedValue}>
      {children}
    </AuthContext.Provider>
  );
}
