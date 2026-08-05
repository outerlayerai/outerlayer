// Stub for 'cloudflare:workers' — used by Vitest (Node.js) to resolve the
// virtual CF Workers module so that vi.mock('cloudflare:workers') can intercept it.

export class DurableObject {
  ctx: unknown;
  env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class DurableObjectState {}
