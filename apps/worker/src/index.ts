/**
 * Cloud worker runner entry: load local dotenv (a no-op on a Fly machine,
 * where env comes from the machine config), then
 * hand off to the runner. A fatal error exits non-zero so the machine's
 * auto_destroy still fires and the reaper can reconcile the run.
 */

import { config } from 'dotenv';

config({ path: '.env.local' });
config({ path: '.env' });

const { runWorker } = await import('./worker-runner.js');

runWorker().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal worker runner error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
