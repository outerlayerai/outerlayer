import { createClient } from '@supabase/supabase-js';
import { retryingFetch } from './retrying-fetch';

// Integration test Supabase configuration
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

// Absorb transient local-Supabase gateway 502s under parallel CI load.
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: { fetch: retryingFetch },
});
