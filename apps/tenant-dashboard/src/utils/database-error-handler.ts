import { PostgrestError } from "@supabase/supabase-js";

interface DatabaseErrorTransformOptions {
  resource?: string;
  resourceName?: string;
  fieldName?: string;
}

/**
 * Transforms database constraint violation errors into user-friendly messages
 */
export function transformDatabaseError(
  error: PostgrestError | Error | string,
  options: DatabaseErrorTransformOptions = {}
): string {
  const errorMessage = typeof error === 'string' ? error : error.message;
  const { resource = 'item', resourceName, fieldName } = options;

  // Check for unique constraint violations
  if (errorMessage.includes('duplicate key value violates unique constraint') || 
      errorMessage.includes('23505')) {
    
    // Extract constraint name for more specific handling
    const constraintMatch = errorMessage.match(/violates unique constraint "([^"]+)"/);
    const constraintName = constraintMatch?.[1];

    // Handle specific known constraints.
    //
    // ORDER MATTERS: most production constraint names follow the pattern
    // `unique_<resource>_name_per_app`. The bare substring `'app'` matches all
    // of those, so the generic app branch MUST come last — otherwise a
    // duplicate-name error on a per-app resource surfaces as "An app with the
    // name … already exists", which has shipped to users as a real UX bug. The
    // specific resources (template, dataset, repository, etc.) are checked
    // first so their per-app constraints route correctly.
    if (constraintName) {
      // API Key name constraint
      if (constraintName === 'uc_api_key' || constraintName.includes('api_key')) {
        const name = resourceName || 'API key';
        return `An API key with the name "${name}" already exists. Please choose a different name.`;
      }

      // Template constraint — checked BEFORE app so any
      // `*_template_*_per_app` constraint is not mis-routed to the app branch.
      if (constraintName.includes('template')) {
        const name = resourceName || 'template';
        return `A template with the name "${name}" already exists. Please choose a different name.`;
      }

      // Dataset constraint — same reason.
      if (constraintName.includes('dataset')) {
        const name = resourceName || 'dataset';
        return `A dataset with the name "${name}" already exists. Please choose a different name.`;
      }

      // Repository constraint
      if (constraintName.includes('repository')) {
        const name = resourceName || 'repository';
        return `The repository "${name}" is already connected to another app. Please choose a different repository.`;
      }

      // GitHub username constraint
      if (constraintName.includes('github_username')) {
        const name = resourceName || 'GitHub username';
        return `The GitHub username "${name}" is already associated with another account.`;
      }

      // Organization name constraint
      if (constraintName.includes('organization_name')) {
        const name = resourceName || 'organization name';
        return `The organization name "${name}" is already taken. Please choose a different name.`;
      }

      // App name constraint — LAST in the chain. The `'app'` substring is
      // very broad; the specific-resource checks above must run first.
      if (constraintName === 'unique_name_per_tenant' || constraintName.includes('app')) {
        const name = resourceName || 'app';
        return `An app with the name "${name}" already exists. Please choose a different name.`;
      }
    }

    // Generic unique constraint message
    const field = fieldName || 'name';
    const itemName = resourceName ? `"${resourceName}"` : 'this value';
    return `${itemName} already exists. Please choose a different ${field}.`;
  }

  // Check for foreign key constraint violations
  if (errorMessage.includes('violates foreign key constraint') || 
      errorMessage.includes('23503')) {
    return `This ${resource} cannot be deleted because it's being used by other items. Please remove its dependencies first.`;
  }

  // Check for not null constraint violations
  if (errorMessage.includes('violates not null constraint') || 
      errorMessage.includes('23502')) {
    const field = fieldName || 'field';
    return `The ${field} is required and cannot be empty.`;
  }

  // Check for limit reached errors (custom trigger)
  if (errorMessage.includes('Max limit reached')) {
    return `You have reached the maximum limit for ${resource}s. Please upgrade your plan or remove existing ${resource}s.`;
  }

  // Check for invalid data type errors
  if (errorMessage.includes('invalid input syntax')) {
    const field = fieldName || 'field';
    return `The ${field} contains invalid characters or format. Please check your input.`;
  }

  // Check for string too long errors
  if (errorMessage.includes('value too long')) {
    const field = fieldName || 'field';
    return `The ${field} is too long. Please shorten your input.`;
  }

  // Check for numeric out of range errors
  if (errorMessage.includes('numeric field overflow') || 
      errorMessage.includes('out of range')) {
    const field = fieldName || 'value';
    return `The ${field} is outside the allowed range. Please enter a valid number.`;
  }

  // Return original error message if no specific transformation is available
  return errorMessage;
}

/**
 * Wrapper for handling database errors in server actions
 */
export function handleDatabaseError(
  error: PostgrestError | Error | string,
  options: DatabaseErrorTransformOptions = {}
): { error: string } {
  const transformedError = transformDatabaseError(error, options);
  return { error: transformedError };
}

/**
 * Specific transformers for common use cases
 */
export const databaseErrorHandlers = {
  apiKey: (error: PostgrestError | Error | string, keyName?: string) =>
    handleDatabaseError(error, { 
      resource: 'API key', 
      resourceName: keyName,
      fieldName: 'name'
    }),
    
  app: (error: PostgrestError | Error | string, appName?: string) =>
    handleDatabaseError(error, { 
      resource: 'app', 
      resourceName: appName,
      fieldName: 'name'
    }),
    
  template: (error: PostgrestError | Error | string, templateName?: string) =>
    handleDatabaseError(error, { 
      resource: 'template', 
      resourceName: templateName,
      fieldName: 'name'
    }),
    
  repository: (error: PostgrestError | Error | string, repoName?: string) =>
    handleDatabaseError(error, { 
      resource: 'repository', 
      resourceName: repoName,
      fieldName: 'URL'
    }),
};