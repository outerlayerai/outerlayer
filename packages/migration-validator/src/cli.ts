#!/usr/bin/env node

import { validateDirectory, validateFiles, formatResults, formatGitHubAnnotations } from './validator.js';

interface CliArgs {
  supabasePath?: string;
  clickhousePath?: string;
  files: string[];
  failOnWarnings: boolean;
  githubOutput: boolean;
  skipRules: string[];
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    files: [],
    failOnWarnings: false,
    githubOutput: false,
    skipRules: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--supabase': {
        const value = args[++i];
        if (value) result.supabasePath = value;
        break;
      }
      case '--clickhouse': {
        const value = args[++i];
        if (value) result.clickhousePath = value;
        break;
      }
      case '--fail-on-warnings':
        result.failOnWarnings = true;
        break;
      case '--github':
        result.githubOutput = true;
        break;
      case '--skip-rule': {
        const value = args[++i];
        if (value) result.skipRules.push(value);
        break;
      }
      case '--files': {
        // Consume all remaining args as file paths
        for (let j = i + 1; j < args.length; j++) {
          const file = args[j];
          if (file && !file.startsWith('--')) {
            result.files.push(file);
          } else {
            i = j - 1;
            break;
          }
          i = j;
        }
        break;
      }
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`
Migration Validator - Validate database migrations follow expand-contract pattern

Usage:
  validate-migrations [options]

Options:
  --supabase <path>      Path to Supabase migrations directory
  --clickhouse <path>    Path to ClickHouse migrations directory
  --files <file...>      Only validate these specific files (for PR-scoped checks)
  --fail-on-warnings     Exit with error code on warnings (not just errors)
  --github               Output GitHub Actions annotations
  --skip-rule <id>       Skip a specific rule (can be used multiple times)
  --help, -h             Show this help message

Examples:
  validate-migrations --supabase ./supabase/migrations
  validate-migrations --clickhouse ./clickhouse/migrations --files file1.sql file2.sql
  validate-migrations --supabase ./migrations --fail-on-warnings --github
  validate-migrations --supabase ./migrations --skip-rule DROP_INDEX

Rules:
  ERROR rules (breaking changes):
    - DROP_TABLE, DROP_COLUMN
    - RENAME_TABLE, RENAME_COLUMN
    - ADD_NOT_NULL_NO_DEFAULT
    - CHANGE_COLUMN_TYPE, MODIFY_COLUMN
    - TRUNCATE_TABLE
    - CLICKHOUSE_DROP_PARTITION, CLICKHOUSE_CLEAR_COLUMN
    - DROP_ENUM_VALUE

  WARNING rules (review needed):
    - DROP_INDEX, DROP_CONSTRAINT
    - ADD_UNIQUE_CONSTRAINT, ADD_FOREIGN_KEY
    - CREATE_INDEX_NOT_CONCURRENT
`);
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (!args.supabasePath && !args.clickhousePath) {
    console.error('Error: At least one of --supabase or --clickhouse must be specified');
    console.error('Run with --help for usage information');
    process.exit(1);
  }

  let hasErrors = false;
  let hasWarnings = false;

  const options = {
    failOnWarnings: args.failOnWarnings,
    skipRules: args.skipRules,
  };

  // Validate Supabase migrations
  if (args.supabasePath) {
    const summary = args.files.length > 0
      ? (() => {
          console.log(`\n📦 Validating ${args.files.length} changed Supabase migration(s)\n`);
          return validateFiles(args.files, 'supabase', options);
        })()
      : await (async () => {
          console.log(`\n📦 Validating Supabase migrations: ${args.supabasePath}\n`);
          return validateDirectory(args.supabasePath!, 'supabase', options);
        })();

    if (args.githubOutput) {
      const annotations = formatGitHubAnnotations(summary);
      if (annotations) {
        console.log(annotations);
      }
    }

    console.log(formatResults(summary));

    if (summary.errors > 0) hasErrors = true;
    if (summary.warnings > 0) hasWarnings = true;
  }

  // Validate ClickHouse migrations
  if (args.clickhousePath) {
    // If --files provided, only validate those specific files
    const summary = args.files.length > 0
      ? (() => {
          console.log(`\n📦 Validating ${args.files.length} changed ClickHouse migration(s)\n`);
          return validateFiles(args.files, 'clickhouse', options);
        })()
      : await (async () => {
          console.log(`\n📦 Validating ClickHouse migrations: ${args.clickhousePath}\n`);
          return validateDirectory(args.clickhousePath!, 'clickhouse', options);
        })();

    if (args.githubOutput) {
      const annotations = formatGitHubAnnotations(summary);
      if (annotations) {
        console.log(annotations);
      }
    }

    console.log(formatResults(summary));

    if (summary.errors > 0) hasErrors = true;
    if (summary.warnings > 0) hasWarnings = true;
  }

  // Exit with appropriate code
  if (hasErrors) {
    process.exit(1);
  } else if (hasWarnings && args.failOnWarnings) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
