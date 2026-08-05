// Types
export type { DatabaseType, Severity, ValidationRule, ValidationViolation, ValidationResult, ValidationSummary } from './types.js';

// Rules
export { validationRules, getRulesForDatabase, getAllRules } from './rules.js';

// Validator
export {
  validateContent,
  validateFile,
  validateDirectory,
  validateFiles,
  formatResults,
  formatGitHubAnnotations,
  type ValidatorOptions,
} from './validator.js';
