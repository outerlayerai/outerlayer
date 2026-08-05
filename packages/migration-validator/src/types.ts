export type Severity = 'error' | 'warning';

export type DatabaseType = 'supabase' | 'clickhouse';

export interface ValidationRule {
  id: string;
  name: string;
  description: string;
  severity: Severity;
  pattern: RegExp;
  databases: DatabaseType[];
  /** If true, the pattern indicates a safe operation that should NOT be flagged */
  isAllowPattern?: boolean;
  /** Message to show when violation is found */
  message: string;
  /** Suggested fix or alternative approach */
  suggestion?: string;
}

export interface ValidationViolation {
  rule: ValidationRule;
  file: string;
  line: number;
  match: string;
  context: string;
}

export interface ValidationResult {
  file: string;
  violations: ValidationViolation[];
  passed: boolean;
}

export interface ValidationSummary {
  totalFiles: number;
  passedFiles: number;
  failedFiles: number;
  errors: number;
  warnings: number;
  results: ValidationResult[];
}
