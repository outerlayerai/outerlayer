import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  SSOConfig,
  SaveSSOConfigInput,
  SSODiagnostics,
  SSOIdentityWithProfile,
  DomainSSOCheck,
} from '@/types/sso';
import { validateMetadataUrl } from '@/utils/validate-metadata-url';
import { fetchSsoMetadataSafely } from '@/utils/safe-metadata-fetch';
import { SUPABASE_API } from '@/config-global';
import { SUPABASE_SECRET_KEY } from '@/config-global.server';

// ---------------------------------------------------------------------------
// Supabase GoTrue SSO Admin API types (not exported by @supabase/auth-js)
// ---------------------------------------------------------------------------

interface GoTrueSAMLProvider {
  id: string;
  metadata_url: string | null;
  domains: Array<{ domain: string }>;
}

interface GoTrueProviderResponse {
  id: string;
  saml: GoTrueSAMLProvider;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

interface SSOConfigServiceDeps {
  db: SupabaseClient;
  adminDb: SupabaseClient;
}

// ---------------------------------------------------------------------------
// Default SAML attribute mapping
// ---------------------------------------------------------------------------
// GoTrue only auto-maps email from SAML assertions. Without explicit mapping,
// name attributes are silently dropped and users show up as their email address.
// The `names` array provides fallback discovery across IdP naming conventions:
// Azure AD (URI claims), Okta (short names), Google Workspace, and LDAP.

const DEFAULT_SAML_ATTRIBUTE_MAPPING = {
  keys: {
    full_name: {
      names: [
        'http://schemas.microsoft.com/identity/claims/displayname',
        'displayName',
        'name',
        'cn',
      ],
    },
    first_name: {
      names: [
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
        'FirstName',
        'givenName',
        'first_name',
      ],
    },
    last_name: {
      names: [
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
        'LastName',
        'sn',
        'surname',
        'last_name',
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SSOConfigService {
  private db: SupabaseClient;
  private adminDb: SupabaseClient;

  constructor(deps: SSOConfigServiceDeps) {
    this.db = deps.db;
    this.adminDb = deps.adminDb;
  }

  // ── Queries ──────────────────────────────────────────────────────────

  async getConfig(tenantId: string): Promise<SSOConfig | null> {
    const { data, error } = await this.db
      .from('sso_config')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to fetch SSO config: ${error.message}`);
    }

    return data as SSOConfig | null;
  }

  // ── Config mutations ─────────────────────────────────────────────────

  async saveConfig(tenantId: string, input: SaveSSOConfigInput): Promise<SSOConfig> {
    validateMetadataUrl(input.metadataUrl);

    const existing = await this.getConfigViaAdmin(tenantId);

    let supabaseProviderId = existing?.supabase_provider_id ?? null;

    // Create or update the Supabase SSO SAML provider via GoTrue admin API
    if (supabaseProviderId) {
      await this.updateSamlProvider(supabaseProviderId, {
        metadataUrl: input.metadataUrl,
        domains: input.allowedDomains,
      });
    } else {
      const provider = await this.createSamlProvider({
        metadataUrl: input.metadataUrl,
        domains: input.allowedDomains,
      });

      supabaseProviderId = provider.id;
    }

    // Upsert the sso_config row
    let savedConfig: SSOConfig;

    if (existing) {
      const { data, error } = await this.adminDb
        .from('sso_config')
        .update({
          metadata_url: input.metadataUrl,
          allowed_domains: input.allowedDomains,
          supabase_provider_id: supabaseProviderId,
          last_validated_at: new Date().toISOString(),
        })
        .eq('tenant_id', tenantId)
        .select('*')
        .single();

      if (error || !data) {
        throw new Error(`Failed to update SSO config: ${error?.message ?? 'No data returned'}`);
      }

      savedConfig = data as SSOConfig;
    } else {
      const { data, error } = await this.adminDb
        .from('sso_config')
        .insert({
          tenant_id: tenantId,
          metadata_url: input.metadataUrl,
          allowed_domains: input.allowedDomains,
          supabase_provider_id: supabaseProviderId,
          last_validated_at: new Date().toISOString(),
        })
        .select('*')
        .single();

      if (error || !data) {
        throw new Error(`Failed to insert SSO config: ${error?.message ?? 'No data returned'}`);
      }

      savedConfig = data as SSOConfig;
    }

    await this.logAuditEvent({
      tenantId,
      ssoConfigId: savedConfig.id,
      eventType: 'config_updated',
    });

    return savedConfig;
  }

  async deleteConfig(tenantId: string): Promise<void> {
    const existing = await this.getConfigViaAdmin(tenantId);

    if (!existing) {
      return;
    }

    // Delete the Supabase SSO provider if it exists
    if (existing.supabase_provider_id) {
      await this.deleteSamlProvider(existing.supabase_provider_id);
    }

    // Delete the config row (cascade handles sso_identity and sso_audit_log)
    const { error } = await this.adminDb
      .from('sso_config')
      .delete()
      .eq('tenant_id', tenantId);

    if (error) {
      throw new Error(`Failed to delete SSO config: ${error.message}`);
    }
  }

  // ── Toggle operations ────────────────────────────────────────────────

  async toggleActive(tenantId: string, active: boolean): Promise<void> {
    const updatePayload: Record<string, boolean> = { is_active: active };

    // If deactivating, also disable enforcement
    if (!active) {
      updatePayload.enforcement_enabled = false;
    }

    const { error } = await this.adminDb
      .from('sso_config')
      .update(updatePayload)
      .eq('tenant_id', tenantId);

    if (error) {
      throw new Error(`Failed to toggle SSO active state: ${error.message}`);
    }

    const config = await this.getConfigViaAdmin(tenantId);

    if (config) {
      await this.logAuditEvent({
        tenantId,
        ssoConfigId: config.id,
        eventType: 'config_updated',
      });
    }
  }

  async toggleEnforcement(tenantId: string, enforced: boolean): Promise<void> {
    const config = await this.getConfigViaAdmin(tenantId);

    if (!config) {
      throw new Error('SSO config not found for this tenant');
    }

    if (!config.is_active) {
      throw new Error('Cannot change enforcement: SSO is not active');
    }

    const { error } = await this.adminDb
      .from('sso_config')
      .update({ enforcement_enabled: enforced })
      .eq('tenant_id', tenantId);

    if (error) {
      throw new Error(`Failed to toggle SSO enforcement: ${error.message}`);
    }

    await this.logAuditEvent({
      tenantId,
      ssoConfigId: config.id,
      eventType: 'enforcement_changed',
    });
  }

  // ── Connection testing ───────────────────────────────────────────────

  async testConnection(tenantId: string): Promise<SSODiagnostics> {
    const config = await this.getConfigViaAdmin(tenantId);

    const baseDiagnostics: SSODiagnostics = {
      metadataReachable: false,
      metadataValid: false,
      certificateValid: false,
      certificateExpiresAt: null,
      entityId: null,
      acsUrl: this.buildAcsUrl(),
      errors: [],
    };

    if (!config || !config.metadata_url) {
      baseDiagnostics.errors.push(
        !config ? 'No SSO configuration found for this tenant' : 'No metadata URL configured',
      );
      return baseDiagnostics;
    }

    try {
      validateMetadataUrl(config.metadata_url);
    } catch (validationError) {
      const message = validationError instanceof Error ? validationError.message : 'Invalid metadata URL';
      baseDiagnostics.errors.push(message);
      return baseDiagnostics;
    }

    let metadataXml: string;

    try {
      // SSRF-safe fetch (security review M2): resolves + vets every IP and pins
      // the connection to a vetted public address, so a metadata host that
      // resolves to an internal IP (or a DNS-rebinding record) can't be probed.
      // Only the numeric status is surfaced — not statusText — to avoid
      // reflecting response detail.
      const { status, body } = await fetchSsoMetadataSafely(config.metadata_url, {
        timeoutMs: 10_000,
      });

      if (status < 200 || status >= 300) {
        baseDiagnostics.errors.push(`Metadata endpoint returned HTTP ${status}`);
        return baseDiagnostics;
      }

      metadataXml = body;
      baseDiagnostics.metadataReachable = true;
    } catch (fetchError) {
      const message =
        fetchError instanceof Error ? fetchError.message : 'Unknown error fetching metadata';
      baseDiagnostics.errors.push(`Failed to reach metadata URL: ${message}`);
      return baseDiagnostics;
    }

    // Validate SAML metadata structure
    const hasEntityDescriptor = metadataXml.includes('EntityDescriptor');
    const hasIDPSSODescriptor =
      metadataXml.includes('IDPSSODescriptor') ||
      metadataXml.includes('SingleSignOnService');

    if (!hasEntityDescriptor || !hasIDPSSODescriptor) {
      baseDiagnostics.errors.push(
        'Metadata XML does not contain required SAML IdP descriptors',
      );
      return baseDiagnostics;
    }

    baseDiagnostics.metadataValid = true;

    // Extract entityID
    const entityIdMatch = metadataXml.match(/entityID="([^"]+)"/);
    baseDiagnostics.entityId = entityIdMatch?.[1] ?? null;

    // Check for X509 certificate presence
    const hasCertificate = metadataXml.includes('X509Certificate');
    baseDiagnostics.certificateValid = hasCertificate;

    if (!hasCertificate) {
      baseDiagnostics.errors.push('No X509Certificate found in metadata');
    }

    return baseDiagnostics;
  }

  // ── Domain check (pre-auth, public) ──────────────────────────────────

  async checkDomainSSO(domain: string): Promise<DomainSSOCheck> {
    const { data, error } = await this.adminDb
      .from('sso_config')
      .select('is_active, enforcement_enabled')
      .contains('allowed_domains', [domain])
      .eq('is_active', true)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to check domain SSO: ${error.message}`);
    }

    if (!data) {
      return { hasSso: false, enforced: false };
    }

    return {
      hasSso: true,
      enforced: (data as { enforcement_enabled: boolean }).enforcement_enabled,
    };
  }

  // ── Identity management ──────────────────────────────────────────────

  async upsertSSOIdentity(params: {
    tenantId: string;
    userId: string;
    ssoConfigId: string;
    externalSubjectId: string;
    idpIssuer?: string;
  }): Promise<void> {
    const now = new Date().toISOString();

    const { error } = await this.adminDb
      .from('sso_identity')
      .upsert(
        {
          tenant_id: params.tenantId,
          user_id: params.userId,
          sso_config_id: params.ssoConfigId,
          external_subject_id: params.externalSubjectId,
          idp_issuer: params.idpIssuer ?? null,
          // first_login_at intentionally excluded — DB DEFAULT handles insert; not updated on conflict
          last_login_at: now,
        },
        { onConflict: 'tenant_id,user_id' },
      );

    if (error) {
      throw new Error(`Failed to upsert SSO identity: ${error.message}`);
    }

    await this.logAuditEvent({
      tenantId: params.tenantId,
      ssoConfigId: params.ssoConfigId,
      userId: params.userId,
      eventType: 'login_success',
    });
  }

  async getSSOMembers(tenantId: string): Promise<SSOIdentityWithProfile[]> {
    const { data: identities, error } = await this.db
      .from('sso_identity')
      .select('user_id, external_subject_id, first_login_at, last_login_at')
      .eq('tenant_id', tenantId);

    if (error) {
      throw new Error(`Failed to fetch SSO members: ${error.message}`);
    }

    if (!identities || identities.length === 0) {
      return [];
    }

    const userIds = identities.map((i) => (i as Record<string, unknown>).user_id as string);
    const { data: profiles } = await this.db
      .from('profile')
      .select('id, email, display_name')
      .in('id', userIds);

    const profileMap = new Map(
      (profiles ?? []).map((p) => {
        const row = p as Record<string, unknown>;
        return [row.id as string, { email: row.email as string, display_name: row.display_name as string | null }];
      }),
    );

    return identities.map((row) => {
      const r = row as Record<string, unknown>;
      const profile = profileMap.get(r.user_id as string);

      return {
        user_id: r.user_id as string,
        email: profile?.email ?? '',
        display_name: profile?.display_name ?? null,
        external_subject_id: r.external_subject_id as string,
        first_login_at: r.first_login_at as string,
        last_login_at: r.last_login_at as string,
      };
    });
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /**
   * Fetch SSO config using admin client (bypasses RLS).
   * Used internally when the caller context doesn't have user auth.
   */
  private async getConfigViaAdmin(tenantId: string): Promise<SSOConfig | null> {
    const { data, error } = await this.adminDb
      .from('sso_config')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to fetch SSO config (admin): ${error.message}`);
    }

    return data as SSOConfig | null;
  }

  private async logAuditEvent(params: {
    tenantId: string;
    ssoConfigId: string;
    userId?: string;
    eventType: string;
    email?: string;
    errorMessage?: string;
  }): Promise<void> {
    const { error } = await this.adminDb.from('sso_audit_log').insert({
      tenant_id: params.tenantId,
      sso_config_id: params.ssoConfigId,
      user_id: params.userId ?? null,
      event_type: params.eventType,
      email: params.email ?? null,
      error_message: params.errorMessage ?? null,
    });

    if (error) {
      // Log audit failures but don't throw - audit should not break primary operations
      console.error(
        `[SSO Audit] Failed to log event type="${params.eventType}" tenant="${params.tenantId}":`,
        error.message,
      );
    }
  }

  /**
   * Build the Supabase ACS (Assertion Consumer Service) URL.
   * This is the endpoint Supabase exposes for receiving SAML assertions.
   */
  private buildAcsUrl(): string {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!supabaseUrl) {
      throw new Error('NEXT_PUBLIC_SUPABASE_URL is not configured — cannot build ACS URL');
    }
    return `${supabaseUrl}/auth/v1/sso/saml/acs`;
  }

  // ── GoTrue SSO Admin REST API ─────────────────────────────────────────
  // The @supabase/auth-js@2.67.3 types don't export the SSO admin API,
  // so we call the GoTrue REST endpoints directly with the service role key.

  /**
   * Returns the GoTrue base URL and auth headers for admin SSO operations.
   */
  private getGoTrueAdminConfig(): { baseUrl: string; headers: Record<string, string> } {
    const supabaseUrl = SUPABASE_API.url;
    const secretKey = SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !secretKey) {
      throw new Error(
        'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY for SSO admin operations',
      );
    }

    return {
      baseUrl: `${supabaseUrl}/auth/v1`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secretKey}`,
        apikey: secretKey,
      },
    };
  }

  private async createSamlProvider(params: {
    metadataUrl: string;
    domains: string[];
  }): Promise<GoTrueProviderResponse> {
    const { baseUrl, headers } = this.getGoTrueAdminConfig();

    const response = await fetch(`${baseUrl}/admin/sso/providers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'saml',
        metadata_url: params.metadataUrl,
        domains: params.domains,
        attribute_mapping: DEFAULT_SAML_ATTRIBUTE_MAPPING,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to create SAML provider (HTTP ${response.status}): ${body}`);
    }

    return (await response.json()) as GoTrueProviderResponse;
  }

  private async updateSamlProvider(
    providerId: string,
    params: { metadataUrl: string; domains: string[] },
  ): Promise<GoTrueProviderResponse> {
    const { baseUrl, headers } = this.getGoTrueAdminConfig();

    const response = await fetch(`${baseUrl}/admin/sso/providers/${providerId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        metadata_url: params.metadataUrl,
        domains: params.domains,
        attribute_mapping: DEFAULT_SAML_ATTRIBUTE_MAPPING,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to update SAML provider (HTTP ${response.status}): ${body}`);
    }

    return (await response.json()) as GoTrueProviderResponse;
  }

  private async deleteSamlProvider(providerId: string): Promise<void> {
    const { baseUrl, headers } = this.getGoTrueAdminConfig();

    const response = await fetch(`${baseUrl}/admin/sso/providers/${providerId}`, {
      method: 'DELETE',
      headers,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to delete SAML provider (HTTP ${response.status}): ${body}`);
    }
  }
}
