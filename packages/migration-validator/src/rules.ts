import type { DatabaseType, ValidationRule } from './types.js';

/**
 * Validation rules for expand-contract pattern compliance.
 *
 * Rules are categorized by severity:
 * - error: Breaking changes that WILL cause downtime
 * - warning: Potentially breaking changes that need review
 */
export const validationRules: ValidationRule[] = [
  // ============================================
  // DROP operations (both databases)
  // ============================================
  {
    id: 'DROP_TABLE',
    name: 'Drop Table',
    description: 'Dropping a table removes data and breaks existing code',
    severity: 'error',
    pattern: /DROP\s+TABLE(?!\s+IF\s+EXISTS\s+[\w.]+_(?:old|deprecated|backup|tmp|temp))/gi,
    databases: ['supabase', 'clickhouse'],
    message: 'DROP TABLE detected - this will cause data loss and break existing code',
    suggestion:
      'Use expand-contract: 1) Stop writing to table, 2) Deploy code that doesn\'t read from it, 3) Then drop in a separate migration',
  },
  {
    id: 'DROP_COLUMN',
    name: 'Drop Column',
    description: 'Dropping a column breaks existing code that reads from it',
    severity: 'error',
    // Exclude DROP CONSTRAINT and DROP PROJECTION (ClickHouse) from this rule
    pattern: /ALTER\s+TABLE\s+\S+\s+DROP\s+(?:COLUMN\s+)?(?!CONSTRAINT|PROJECTION)(\w+)/gi,
    databases: ['supabase', 'clickhouse'],
    message: 'DROP COLUMN detected - this will break existing code that reads this column',
    suggestion:
      'Use expand-contract: 1) Deploy code that doesn\'t read the column, 2) Wait for old code to drain, 3) Then drop in a separate migration',
  },
  {
    id: 'DROP_INDEX',
    name: 'Drop Index',
    description: 'Dropping an index may cause performance issues but is generally safe',
    severity: 'warning',
    pattern: /DROP\s+INDEX/gi,
    databases: ['supabase', 'clickhouse'],
    message: 'DROP INDEX detected - may cause performance degradation',
    suggestion: 'Ensure queries don\'t rely on this index before dropping',
  },

  // ============================================
  // RENAME operations (both databases)
  // ============================================
  {
    id: 'RENAME_TABLE',
    name: 'Rename Table',
    description: 'Renaming a table breaks existing code that references it',
    severity: 'error',
    pattern: /ALTER\s+TABLE\s+\S+\s+RENAME\s+TO/gi,
    databases: ['supabase', 'clickhouse'],
    message: 'RENAME TABLE detected - this will break existing code',
    suggestion:
      'Use expand-contract: 1) Create new table, 2) Migrate data, 3) Update code to use new table, 4) Drop old table later',
  },
  {
    id: 'RENAME_TABLE_DIRECT',
    name: 'Rename Table (Direct Syntax)',
    description: 'Renaming a table breaks existing code that references it',
    severity: 'error',
    pattern: /RENAME\s+TABLE\s+\S+\s+TO/gi,
    databases: ['clickhouse'],
    message: 'RENAME TABLE detected - this will break existing code',
    suggestion:
      'Use expand-contract: 1) Create new table, 2) Migrate data, 3) Update code to use new table, 4) Drop old table later',
  },
  {
    id: 'RENAME_COLUMN',
    name: 'Rename Column',
    description: 'Renaming a column breaks existing code that references it',
    severity: 'error',
    pattern: /ALTER\s+TABLE\s+\S+\s+RENAME\s+(?:COLUMN\s+)?\S+\s+TO/gi,
    databases: ['supabase', 'clickhouse'],
    message: 'RENAME COLUMN detected - this will break existing code',
    suggestion:
      'Use expand-contract: 1) Add new column, 2) Backfill data, 3) Update code to use new column, 4) Drop old column later',
  },

  // ============================================
  // NOT NULL constraints (Supabase/PostgreSQL)
  // ============================================
  {
    id: 'ADD_NOT_NULL_NO_DEFAULT',
    name: 'Add NOT NULL without default',
    description: 'Adding NOT NULL without a default will fail for existing rows',
    severity: 'error',
    pattern:
      /ALTER\s+TABLE\s+\S+\s+(?:ALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL|ADD\s+(?:COLUMN\s+)?\S+\s+\S+(?:\([^)]*\))?\s+NOT\s+NULL(?!\s+DEFAULT))/gi,
    databases: ['supabase'],
    message: 'Adding NOT NULL constraint without DEFAULT - this will fail if table has existing rows',
    suggestion: 'Either add a DEFAULT value, or backfill existing rows first, then add the constraint',
  },

  // ============================================
  // Type changes (both databases)
  // ============================================
  {
    id: 'CHANGE_COLUMN_TYPE',
    name: 'Change Column Type',
    description: 'Changing column type may cause data loss or break existing code',
    severity: 'error',
    pattern: /ALTER\s+TABLE\s+\S+\s+ALTER\s+(?:COLUMN\s+)?\S+\s+(?:SET\s+DATA\s+)?TYPE/gi,
    databases: ['supabase'],
    message: 'Changing column type detected - may cause data loss or break existing code',
    suggestion:
      'Use expand-contract: 1) Add new column with new type, 2) Backfill data, 3) Update code, 4) Drop old column later',
  },
  {
    id: 'MODIFY_COLUMN',
    name: 'Modify Column (ClickHouse)',
    description: 'Modifying column type in ClickHouse may cause issues',
    severity: 'error',
    pattern: /ALTER\s+TABLE\s+\S+\s+MODIFY\s+COLUMN/gi,
    databases: ['clickhouse'],
    message: 'MODIFY COLUMN detected - may cause data issues in ClickHouse',
    suggestion: 'Consider creating a new table with the correct schema and migrating data',
  },

  // ============================================
  // Truncate operations (both databases)
  // ============================================
  {
    id: 'TRUNCATE_TABLE',
    name: 'Truncate Table',
    description: 'Truncating a table removes all data',
    severity: 'error',
    pattern: /TRUNCATE\s+(?:TABLE\s+)?/gi,
    databases: ['supabase', 'clickhouse'],
    message: 'TRUNCATE detected - this will remove all data from the table',
    suggestion: 'Truncate should only be used in development/testing, never in production migrations',
  },

  // ============================================
  // ClickHouse-specific dangerous operations
  // ============================================
  {
    id: 'CLICKHOUSE_DROP_PARTITION',
    name: 'Drop Partition (ClickHouse)',
    description: 'Dropping a partition removes data',
    severity: 'error',
    pattern: /ALTER\s+TABLE\s+\S+\s+DROP\s+PARTITION/gi,
    databases: ['clickhouse'],
    message: 'DROP PARTITION detected - this will remove data',
    suggestion: 'Ensure this is intentional data cleanup, not part of schema migration',
  },
  {
    id: 'CLICKHOUSE_CLEAR_COLUMN',
    name: 'Clear Column (ClickHouse)',
    description: 'Clearing a column removes all values in it',
    severity: 'error',
    pattern: /ALTER\s+TABLE\s+\S+\s+CLEAR\s+COLUMN/gi,
    databases: ['clickhouse'],
    message: 'CLEAR COLUMN detected - this will remove all values in the column',
    suggestion: 'This is destructive; consider if you really need to clear the data',
  },
  {
    id: 'CLICKHOUSE_DROP_PROJECTION',
    name: 'Drop Projection (ClickHouse)',
    description: 'Dropping a projection removes a query optimization',
    severity: 'warning',
    pattern: /ALTER\s+TABLE\s+\S+\s+DROP\s+PROJECTION/gi,
    databases: ['clickhouse'],
    message: 'DROP PROJECTION detected - this removes a query optimization',
    suggestion: 'Projections are optimizations; dropping may impact query performance but is generally safe',
  },

  // ============================================
  // Constraint modifications (Supabase/PostgreSQL)
  // ============================================
  {
    id: 'DROP_CONSTRAINT',
    name: 'Drop Constraint',
    description: 'Dropping constraints may allow invalid data',
    severity: 'warning',
    pattern: /ALTER\s+TABLE\s+\S+\s+DROP\s+CONSTRAINT/gi,
    databases: ['supabase'],
    message: 'DROP CONSTRAINT detected - may allow invalid data',
    suggestion: 'Ensure application code validates data before removing database constraints',
  },
  {
    id: 'ADD_UNIQUE_CONSTRAINT',
    name: 'Add Unique Constraint',
    description: 'Adding unique constraint will fail if duplicates exist',
    severity: 'warning',
    pattern: /ALTER\s+TABLE\s+\S+\s+ADD\s+(?:CONSTRAINT\s+\S+\s+)?UNIQUE/gi,
    databases: ['supabase'],
    message: 'Adding UNIQUE constraint - will fail if duplicate values exist',
    suggestion: 'Verify no duplicates exist before adding constraint, or use CREATE UNIQUE INDEX CONCURRENTLY',
  },
  {
    id: 'ADD_FOREIGN_KEY',
    name: 'Add Foreign Key',
    description: 'Adding foreign key will fail if orphaned rows exist',
    severity: 'warning',
    pattern: /ALTER\s+TABLE\s+\S+\s+ADD\s+(?:CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY/gi,
    databases: ['supabase'],
    message: 'Adding FOREIGN KEY constraint - will fail if orphaned rows exist',
    suggestion: 'Clean up orphaned rows before adding the constraint',
  },

  // ============================================
  // Enum modifications (Supabase/PostgreSQL)
  // ============================================
  {
    id: 'DROP_ENUM_VALUE',
    name: 'Alter Enum (Remove Value)',
    description: 'Removing enum values is not directly supported and breaks existing data',
    severity: 'error',
    pattern: /DROP\s+TYPE\s+\S+/gi,
    databases: ['supabase'],
    message: 'DROP TYPE detected - if this is an enum, existing data using it will be affected',
    suggestion: 'To modify enums: 1) Create new enum, 2) Migrate columns, 3) Drop old enum',
  },

  // ============================================
  // Index creation warnings (both databases)
  // ============================================
  {
    id: 'CREATE_INDEX_NOT_CONCURRENT',
    name: 'Create Index (Blocking)',
    description: 'Creating index without CONCURRENTLY blocks writes',
    severity: 'warning',
    pattern: /CREATE\s+(?:UNIQUE\s+)?INDEX(?!\s+CONCURRENTLY)/gi,
    databases: ['supabase'],
    message: 'CREATE INDEX without CONCURRENTLY - this will lock the table during creation',
    suggestion: 'Use CREATE INDEX CONCURRENTLY to avoid blocking writes (note: cannot run in transaction)',
  },
];

/**
 * Get rules applicable to a specific database type
 */
export function getRulesForDatabase(database: DatabaseType): ValidationRule[] {
  return validationRules.filter((rule) => rule.databases.includes(database));
}

/**
 * Get all rules
 */
export function getAllRules(): ValidationRule[] {
  return validationRules;
}
