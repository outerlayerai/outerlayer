'use client';

import { createContext } from 'react';

import { SupabaseContextType } from '../types';

// ----------------------------------------------------------------------

/**
 * The `{}` default is deliberate, not laziness: it is what lets
 * `useAuthContext` be called with no `AuthProvider` above it, which
 * `app/global-error.tsx` does. That boundary replaces the root layout, so no
 * provider is mounted around it, and it reaches this context transitively
 * through the client logger.
 *
 * Switching this to `null` makes `useAuthContext`'s `if (!context) throw` reachable
 * and crashes the last-resort error boundary — a blank page with the fault never
 * reported. Consumers must keep treating the fields as possibly absent.
 */
export const AuthContext = createContext({} as SupabaseContextType);
