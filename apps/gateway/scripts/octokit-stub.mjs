/**
 * Stub for `octokit` used during OpenAPI schema generation.
 *
 * Chanfana's `getGeneratedSchema()` never invokes handler code — it walks
 * the registered routes' Zod schemas. The octokit client is constructed
 * inside `src/git/github.ts::GitHubProvider.create()`, which only runs
 * from the template-service dataset streamer during real requests. A stub
 * App class is enough to satisfy the module load; any call path that
 * actually reaches it will throw, which is the correct failure mode for a
 * schema-only codepath.
 */

export class App {
  constructor() {
    throw new Error(
      'octokit App was instantiated during OpenAPI generation — this should not happen. ' +
        'generate-openapi.ts only walks Zod schemas and should not call route handlers.',
    );
  }
}

export default { App };
