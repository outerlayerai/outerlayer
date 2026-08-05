import { User } from '@supabase/supabase-js';

export const mockUser: User = {
  id: 'test-user-123',
  app_metadata: {
    provider: 'email',
    providers: ['email'],
    tenant_id: 'test-tenant-123',
    role: 'admin',
  },
  user_metadata: {
    display_name: 'Test User',
    email: 'test@example.com',
  },
  aud: 'authenticated',
  confirmation_sent_at: undefined,
  recovery_sent_at: undefined,
  email_change_sent_at: undefined,
  new_email: undefined,
  invited_at: undefined,
  action_link: undefined,
  email: 'test@example.com',
  phone: undefined,
  created_at: '2024-01-01T00:00:00Z',
  confirmed_at: '2024-01-01T00:00:00Z',
  email_confirmed_at: '2024-01-01T00:00:00Z',
  phone_confirmed_at: undefined,
  last_sign_in_at: '2024-01-01T00:00:00Z',
  role: 'authenticated',
  updated_at: '2024-01-01T00:00:00Z',
  identities: [],
  is_anonymous: false,
  factors: [],
};
