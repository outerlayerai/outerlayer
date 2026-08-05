import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { server } from './msw-server';
import { resetMswState } from './msw-handlers';

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

beforeEach(() => {
  resetMswState();
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});
