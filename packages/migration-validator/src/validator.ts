import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import type { DatabaseType, ValidationResult, ValidationSummary, ValidationViolation } from './types.js';
import { getRulesForDatabase } from './rules.js';

export interface ValidatorOptions {
  /** Fail on warnings as well as errors */
  failOnWarnings?: boolean;
  /** Patterns to exclude from validation */
  excludePatterns?: string[];
  /** Rule IDs to skip */
  skipRules?: string[];
}

/**
 * Check if a line is suppressed by an inline `-- validator:allow RULE_ID` comment.
 * Checks both the matched line and the line immediately before it.
 */
function isLineSuppressed(content: string, matchIndex: number, ruleId: string): boolean {
  const lines = content.split('\n');
  let charCount = 0;
  let lineIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined) {
      charCount += line.length + 1;
      if (charCount > matchIndex) {
        lineIndex = i;
        break;
      }
    }
  }

  const allowPattern = new RegExp(`--\\s*validator:allow\\b[^\\n]*\\b${ruleId}\\b`);

  // Check the matched line itself
  const currentLine = lines[lineIndex];
  if (currentLine !== undefined && allowPattern.test(currentLine)) {
    return true;
  }
  // Check the line immediately before
  const prevLine = lineIndex > 0 ? lines[lineIndex - 1] : undefined;
  if (prevLine !== undefined && allowPattern.test(prevLine)) {
    return true;
  }

  return false;
}

/**
 * Get context around a match (the line containing the match plus surrounding lines)
 */
function getContext(content: string, matchIndex: number, contextLines: number = 1): { line: number; context: string } {
  const lines = content.split('\n');
  let charCount = 0;
  let lineNumber = 0;

  // Find which line the match is on
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined) {
      charCount += line.length + 1; // +1 for newline
      if (charCount > matchIndex) {
        lineNumber = i + 1; // 1-indexed
        break;
      }
    }
  }

  // Get surrounding context
  const startLine = Math.max(0, lineNumber - 1 - contextLines);
  const endLine = Math.min(lines.length, lineNumber + contextLines);
  const contextSlice = lines.slice(startLine, endLine);

  return {
    line: lineNumber,
    context: contextSlice.join('\n'),
  };
}

/**
 * Validate a single migration file content
 */
export function validateContent(
  content: string,
  database: DatabaseType,
  filePath: string = 'input.sql',
  options: ValidatorOptions = {}
): ValidationResult {
  const rules = getRulesForDatabase(database);
  const violations: ValidationViolation[] = [];

  for (const rule of rules) {
    // Skip if rule is in skip list
    if (options.skipRules?.includes(rule.id)) {
      continue;
    }

    // Create a new regex to avoid lastIndex issues
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);

    let match;
    while ((match = pattern.exec(content)) !== null) {
      // Check for inline suppression comment
      if (isLineSuppressed(content, match.index, rule.id)) {
        if (match.index === pattern.lastIndex) {
          pattern.lastIndex++;
        }
        continue;
      }

      const { line, context } = getContext(content, match.index);

      violations.push({
        rule,
        file: filePath,
        line,
        match: match[0],
        context,
      });

      // Prevent infinite loops with zero-length matches
      if (match.index === pattern.lastIndex) {
        pattern.lastIndex++;
      }
    }
  }

  const hasErrors = violations.some((v) => v.rule.severity === 'error');
  const hasWarnings = violations.some((v) => v.rule.severity === 'warning');

  return {
    file: filePath,
    violations,
    passed: !hasErrors && (!options.failOnWarnings || !hasWarnings),
  };
}

/**
 * Validate a single migration file
 */
export function validateFile(filePath: string, database: DatabaseType, options: ValidatorOptions = {}): ValidationResult {
  const content = fs.readFileSync(filePath, 'utf-8');
  return validateContent(content, database, filePath, options);
}

/**
 * Validate all migrations in a directory
 */
export async function validateDirectory(
  directory: string,
  database: DatabaseType,
  options: ValidatorOptions = {}
): Promise<ValidationSummary> {
  const pattern = path.join(directory, '**/*.sql');
  const files = await glob(pattern, {
    ignore: options.excludePatterns,
  });

  const results: ValidationResult[] = [];
  let errors = 0;
  let warnings = 0;

  for (const file of files) {
    const result = validateFile(file, database, options);
    results.push(result);

    for (const violation of result.violations) {
      if (violation.rule.severity === 'error') {
        errors++;
      } else {
        warnings++;
      }
    }
  }

  const passedFiles = results.filter((r) => r.passed).length;
  const failedFiles = results.filter((r) => !r.passed).length;

  return {
    totalFiles: files.length,
    passedFiles,
    failedFiles,
    errors,
    warnings,
    results,
  };
}

/**
 * Validate specific files (useful for git diff integration)
 */
export function validateFiles(
  files: string[],
  database: DatabaseType,
  options: ValidatorOptions = {}
): ValidationSummary {
  const results: ValidationResult[] = [];
  let errors = 0;
  let warnings = 0;

  for (const file of files) {
    if (!fs.existsSync(file)) {
      continue;
    }

    const result = validateFile(file, database, options);
    results.push(result);

    for (const violation of result.violations) {
      if (violation.rule.severity === 'error') {
        errors++;
      } else {
        warnings++;
      }
    }
  }

  const passedFiles = results.filter((r) => r.passed).length;
  const failedFiles = results.filter((r) => !r.passed).length;

  return {
    totalFiles: files.length,
    passedFiles,
    failedFiles,
    errors,
    warnings,
    results,
  };
}

/**
 * Format validation results for console output
 */
export function formatResults(summary: ValidationSummary): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('  Migration Validation Report');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');

  for (const result of summary.results) {
    if (result.violations.length === 0) {
      lines.push(`✓ ${result.file}`);
      continue;
    }

    lines.push(`✗ ${result.file}`);

    for (const violation of result.violations) {
      const icon = violation.rule.severity === 'error' ? '🔴' : '🟡';
      lines.push(`  ${icon} Line ${violation.line}: ${violation.rule.name}`);
      lines.push(`     ${violation.rule.message}`);
      lines.push(`     Match: ${violation.match.trim()}`);
      if (violation.rule.suggestion) {
        lines.push(`     💡 ${violation.rule.suggestion}`);
      }
      lines.push('');
    }
  }

  lines.push('───────────────────────────────────────────────────────────────');
  lines.push(`  Files: ${summary.totalFiles} total, ${summary.passedFiles} passed, ${summary.failedFiles} failed`);
  lines.push(`  Issues: ${summary.errors} errors, ${summary.warnings} warnings`);
  lines.push('───────────────────────────────────────────────────────────────');

  if (summary.errors > 0) {
    lines.push('');
    lines.push('❌ Validation FAILED - breaking changes detected');
    lines.push('   These changes will cause downtime. Use expand-contract pattern.');
  } else if (summary.warnings > 0) {
    lines.push('');
    lines.push('⚠️  Validation PASSED with warnings - please review');
  } else if (summary.totalFiles > 0) {
    lines.push('');
    lines.push('✅ Validation PASSED - no breaking changes detected');
  }

  lines.push('');

  return lines.join('\n');
}

/**
 * Format results as GitHub Actions annotations
 */
export function formatGitHubAnnotations(summary: ValidationSummary): string {
  const lines: string[] = [];

  for (const result of summary.results) {
    for (const violation of result.violations) {
      const level = violation.rule.severity === 'error' ? 'error' : 'warning';
      const file = violation.file;
      const line = violation.line;
      const message = `${violation.rule.name}: ${violation.rule.message}`;

      lines.push(`::${level} file=${file},line=${line}::${message}`);
    }
  }

  return lines.join('\n');
}
