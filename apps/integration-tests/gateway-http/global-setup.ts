import { startGateway, stopGateway } from './setup-gateway';

/**
 * Vitest globalSetup: start wrangler dev + seed tenant once before any test
 * file runs. The returned function is the teardown — Vitest invokes it
 * after the last test completes (or on interrupt).
 */
export default async function globalSetup() {
  console.log('\nGlobal Setup: Starting gateway-http test environment...');
  await startGateway();
  console.log('Global Setup: gateway ready\n');

  return async () => {
    console.log('\nGlobal Teardown: Stopping gateway...');
    await stopGateway();
    console.log('Global Teardown: gateway stopped\n');
  };
}
