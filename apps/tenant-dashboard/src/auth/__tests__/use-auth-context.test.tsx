// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { useAuthContext } from '../hooks/use-auth-context';
import { AuthContext } from '../context/auth-context';
import { ReactNode } from 'react';

describe('useAuthContext', () => {
  // NOTE: Testing "throw when outside provider" is not possible because
  // the global test setup (unit-test-setup.ts) mocks useAuthContext globally.

  describe('when used inside AuthProvider', () => {
    it('should return context value when used inside provider', () => {
      const mockContextValue = {
        user: null,
        method: 'supabase',
        loading: false,
        authenticated: false,
        unauthenticated: true,
        login: vi.fn(),
        register: vi.fn(),
        logout: vi.fn(),
        forgotPassword: vi.fn(),
        updatePassword: vi.fn(),
        updateEmail: vi.fn(),
        refreshMemberships: vi.fn(),
      };

      const wrapper = ({ children }: { children: ReactNode }) => (
        <AuthContext.Provider value={mockContextValue as any}>
          {children}
        </AuthContext.Provider>
      );

      const { result } = renderHook(() => useAuthContext(), { wrapper });

      expect(result.current).toEqual(mockContextValue);
      expect(result.current.method).toBe('supabase');
      expect(result.current.loading).toBe(false);
      expect(result.current.authenticated).toBe(false);
      expect(result.current.unauthenticated).toBe(true);
    });

    it('should provide access to auth methods', () => {
      const mockLogin = vi.fn();
      const mockLogout = vi.fn();
      const mockRegister = vi.fn();

      const mockContextValue = {
        user: null,
        method: 'supabase',
        loading: false,
        authenticated: false,
        unauthenticated: true,
        login: mockLogin,
        register: mockRegister,
        logout: mockLogout,
        forgotPassword: vi.fn(),
        updatePassword: vi.fn(),
        updateEmail: vi.fn(),
        refreshMemberships: vi.fn(),
      };

      const wrapper = ({ children }: { children: ReactNode }) => (
        <AuthContext.Provider value={mockContextValue as any}>
          {children}
        </AuthContext.Provider>
      );

      const { result } = renderHook(() => useAuthContext(), { wrapper });

      expect(result.current.login).toBe(mockLogin);
      expect(result.current.logout).toBe(mockLogout);
      expect(result.current.register).toBe(mockRegister);
    });

    it('should provide user data when authenticated', () => {
      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
        role: 'owner',
        displayName: 'Test User',
        memberships: [],
        activeTenant: null,
      };

      const mockContextValue = {
        user: mockUser,
        method: 'supabase',
        loading: false,
        authenticated: true,
        unauthenticated: false,
        login: vi.fn(),
        register: vi.fn(),
        logout: vi.fn(),
        forgotPassword: vi.fn(),
        updatePassword: vi.fn(),
        updateEmail: vi.fn(),
        refreshMemberships: vi.fn(),
      };

      const wrapper = ({ children }: { children: ReactNode }) => (
        <AuthContext.Provider value={mockContextValue as any}>
          {children}
        </AuthContext.Provider>
      );

      const { result } = renderHook(() => useAuthContext(), { wrapper });

      expect(result.current.user).toEqual(mockUser);
      expect(result.current.authenticated).toBe(true);
      expect(result.current.unauthenticated).toBe(false);
    });
  });
});
