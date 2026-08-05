import { installRetryingGlobalFetch } from './lib/global-fetch-retry-setup';

// Runs after `test-setup.ts`, before any acceptance spec's own module graph
// loads — see `global-fetch-retry-setup.ts` for why this project needs it.
installRetryingGlobalFetch();
