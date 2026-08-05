/**
 * Barrel for the environments hook suite.
 *
 * Hooks here target the gateway `/v1/environments/*` routes directly.
 */

export { useSelectedEnv } from './use-selected-env';
// `DEFAULT_ENV_NAME` and the `SelectedEnv` type are imported directly from
// `./use-selected-env` by the env-selector / hook layer — they are not part
// of the public barrel surface, so they are intentionally not re-exported
// here (re-exporting them would trip `import/no-unused-modules`).
