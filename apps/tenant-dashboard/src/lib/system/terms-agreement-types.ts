import "server-only";

/**
 * Types for Terms Agreement Service
 */

/**
 * Type of consent recorded in the terms agreement.
 * - explicit: User clicked checkbox to agree (registration, blocking screen)
 * - implicit: Continued use after terms update, or "by signing up you agree" language
 */
export type ConsentType = 'explicit' | 'implicit';

/**
 * Parameters for recording a terms agreement
 */
export interface RecordAgreementParams {
  userId: string;
  termsVersion: string;
  ipAddress?: string;
  userAgent?: string;
  /** Type of consent - defaults to 'explicit' if not provided */
  consentType?: ConsentType;
}

/**
 * Represents a terms agreement record from the database
 */
export interface TermsAgreementRecord {
  id: string;
  userId: string;
  termsVersion: string;
  agreedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  /** Type of consent that was recorded */
  consentType: ConsentType;
  createdAt: Date;
  createdBy: string | null;
}

/**
 * Result of checking a user's terms agreement status
 */
export interface TermsCheckResult {
  /** Whether the user has agreed to any version */
  hasAgreed: boolean;
  /** The version the user agreed to (if any) */
  agreedVersion?: string;
  /** When the user agreed (if any) */
  agreedAt?: Date;
  /** The type of consent for the latest agreement (if any) */
  consentType?: ConsentType;
  /** Whether the user needs to agree to the current version */
  needsCurrentVersion: boolean;
}

/**
 * Interface for the Terms Agreement Service
 */
export interface ITermsAgreementService {
  /**
   * Records user agreement to terms
   * @throws Error if agreement already exists for this version
   */
  recordAgreement(params: RecordAgreementParams): Promise<TermsAgreementRecord>;

  /**
   * Checks if user has agreed to ANY version of terms.
   * Used for non-blocking policy - users with any agreement are never blocked.
   */
  hasAnyAgreement(userId: string): Promise<boolean>;

  /**
   * Gets the latest agreement for a user
   */
  getLatestAgreement(userId: string): Promise<TermsAgreementRecord | null>;

  /**
   * Checks user's terms agreement status against current version
   */
  checkTermsStatus(userId: string, currentVersion: string): Promise<TermsCheckResult>;
}
