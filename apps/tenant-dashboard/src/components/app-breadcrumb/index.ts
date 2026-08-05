/**
 * Barrel for the app-breadcrumb compound component.
 *
 * The header breadcrumb `Org ▾ / App ▾ / Env ▾` lives here. Each
 * segment is an interactive selector, not a static label.
 *
 * Only `<AppBreadcrumb>` is exported — `import/no-unused-modules` is enforced
 * at pre-commit, so the `.OrgSelect` / `.AppSelect` / `.EnvSelect` segments
 * stay reachable only as compound members of `AppBreadcrumb`, not as separate
 * barrel exports, until a consumer imports them directly.
 */

export { AppBreadcrumb } from './app-breadcrumb';
