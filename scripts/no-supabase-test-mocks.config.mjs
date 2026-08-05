export const WORKSPACES = {
  'tenant-dashboard': {
    root: 'apps/tenant-dashboard/src',
    message:
      'New Supabase module-level mocks are not allowed in tenant-dashboard tests. Use shared MSW handlers under src/test-helpers/msw-handlers/ instead.',
  },
  gateway: {
    root: 'apps/gateway/src',
    message:
      'New Supabase module-level mocks are not allowed in gateway tests. Use MSW for boundary tests and narrower spies or injected seams for service-level client construction tests.',
  },
  'gateway-core': {
    root: 'packages/gateway-core/src',
    message:
      'New Supabase module-level mocks are not allowed in gateway-core tests. Use MSW for boundary tests and narrower spies or injected seams for service-level client construction tests.',
  },
};
