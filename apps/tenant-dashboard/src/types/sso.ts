/**
 * SSO Configuration for a tenant organization.
 * Maps to the sso_config database table.
 */
export interface SSOConfig {
  id: string;
  tenant_id: string;
  supabase_provider_id: string | null;
  metadata_url: string | null;
  entity_id: string | null;
  allowed_domains: string[];
  enforcement_enabled: boolean;
  is_active: boolean;
  last_validated_at: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

/**
 * SSO Identity mapping between external IdP user and internal user.
 * Maps to the sso_identity database table.
 */
// eslint-disable-next-line import/no-unused-modules -- consumed by future SSO admin audit UI
export interface SSOIdentity {
  id: string;
  tenant_id: string;
  user_id: string;
  sso_config_id: string;
  external_subject_id: string;
  idp_issuer: string | null;
  first_login_at: string;
  last_login_at: string;
  created_at: string;
}

/**
 * SSO audit log event.
 * Maps to the sso_audit_log database table.
 */
// eslint-disable-next-line import/no-unused-modules -- consumed by future SSO audit log viewer
export interface SSOAuditEvent {
  id: string;
  tenant_id: string;
  sso_config_id: string;
  user_id: string | null;
  event_type: 'login_success' | 'login_failure' | 'config_updated' | 'enforcement_changed';
  email: string | null;
  error_message: string | null;
  ip_address: string | null;
  created_at: string;
}

/**
 * Input for saving SSO configuration.
 */
export interface SaveSSOConfigInput {
  metadataUrl: string;
  allowedDomains: string[];
}

/**
 * Result of testing an SSO connection.
 */
export interface SSODiagnostics {
  metadataReachable: boolean;
  metadataValid: boolean;
  certificateValid: boolean;
  certificateExpiresAt: string | null;
  entityId: string | null;
  acsUrl: string;
  errors: string[];
}

/**
 * SSO identity joined with profile info for admin display.
 */
export interface SSOIdentityWithProfile {
  user_id: string;
  email: string;
  display_name: string | null;
  external_subject_id: string;
  first_login_at: string;
  last_login_at: string;
}

/**
 * Result of checking if a domain has SSO configured.
 */
export interface DomainSSOCheck {
  hasSso: boolean;
  enforced: boolean;
}
