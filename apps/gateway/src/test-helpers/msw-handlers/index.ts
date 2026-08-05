import {
  gatewaySupabaseHandlers,
  resetGatewaySupabaseMswState,
} from './supabase';

export { seedGatewaySupabaseMswState } from './supabase';

export const mswHandlers = [...gatewaySupabaseHandlers];

export function resetMswState() {
  resetGatewaySupabaseMswState();
}
