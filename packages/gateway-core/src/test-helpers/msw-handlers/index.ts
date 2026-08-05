import {
  gatewaySupabaseHandlers,
  resetGatewaySupabaseMswState,
} from './supabase';

export {
  getGatewaySupabaseMswState,
  seedGatewaySupabaseMswState,
} from './supabase';

export const mswHandlers = [...gatewaySupabaseHandlers];

export function resetMswState() {
  resetGatewaySupabaseMswState();
}
