// @vitest-environment jsdom
import React from 'react';
import { render, screen } from '@testing-library/react';
import SupabaseLoginView from '../features/auth/components/login-view';
import SupabaseRegisterView from '../features/auth/components/register-view';

// Mock the modules
vi.mock('next/navigation');
vi.mock('./hooks', () => ({
  useAuthContext: vi.fn(() => ({
    login: vi.fn(),
    logout: vi.fn(),
    user: null,
    loading: false,
  })),
}));

describe('Authentication Components Rendering', () => {
  describe('Login Component', () => {
    it('should render login form with all essential elements', () => {
      render(
        <SupabaseLoginView
          loginWithGithub={vi.fn()}
          loginWithGoogle={vi.fn()}
        />
      );

      // Check headings using translation keys
      expect(screen.getByText('auth.login.heading')).toBeInTheDocument();
      expect(screen.getByText('auth.login.newUser')).toBeInTheDocument();
      expect(screen.getByText('auth.login.createAnAccountLink')).toBeInTheDocument();
      
      // Check form inputs exist by label text (translation keys)
      expect(screen.getByLabelText('auth.login.emailPlaceholder')).toBeInTheDocument();
      expect(screen.getByLabelText('auth.login.passwordPlaceholder')).toBeInTheDocument();
      
      // Check buttons by text (translation keys)
      expect(screen.getByRole('button', { name: 'auth.login.loginButton' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'auth.login.loginWithGoogle' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'auth.login.loginWithGitHub' })).toBeInTheDocument();
      
      // Check links
      expect(screen.getByText('auth.login.forgotPassword')).toBeInTheDocument();
    });
  });

  describe('Register Component', () => {
    it('should render register form with all essential elements', () => {
      render(
        <SupabaseRegisterView
          finalizeRegistration={vi.fn()}
          registerWithGithub={vi.fn()}
          registerWithGoogle={vi.fn()}
        />
      );

      // Check headings using translation keys
      expect(screen.getByText('auth.register.heading')).toBeInTheDocument();
      expect(screen.getByText('auth.register.subtitle')).toBeInTheDocument();
      expect(screen.getByText('auth.register.signInLink')).toBeInTheDocument();
      
      // Check form inputs (no companyName field)
      expect(screen.getByLabelText('auth.register.firstNamePlaceholder')).toBeInTheDocument();
      expect(screen.getByLabelText('auth.register.lastNamePlaceholder')).toBeInTheDocument();
      expect(screen.getByLabelText('auth.register.emailPlaceholder')).toBeInTheDocument();
      expect(screen.getByLabelText('auth.register.passwordPlaceholder')).toBeInTheDocument();
      
      // Check buttons
      expect(screen.getByRole('button', { name: 'auth.register.createButton' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'auth.register.registerWithGoogle' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'auth.register.registerWithGitHub' })).toBeInTheDocument();
      
      // Check terms agreement checkbox for legal compliance
      // The TermsCheckbox now provides an interactive checkbox with links
      const termsCheckbox = screen.getByTestId('terms-checkbox');
      expect(termsCheckbox).toBeInTheDocument();

      // Validate Terms of Service link exists and points to correct URL
      const termsLink = screen.getByTestId('terms-link');
      expect(termsLink).toBeInTheDocument();
      expect(termsLink).toHaveAttribute('href', 'https://www.agentmark.co/terms');

      // Validate Privacy Policy link exists and points to correct URL
      const privacyLink = screen.getByTestId('privacy-link');
      expect(privacyLink).toBeInTheDocument();
      expect(privacyLink).toHaveAttribute('href', 'https://www.agentmark.co/privacy');

      // Validate version is displayed for legal traceability
      const versionDisplay = screen.getByTestId('terms-version');
      expect(versionDisplay).toBeInTheDocument();
    });

    it('should have proper legal compliance for registration', () => {
      render(
        <SupabaseRegisterView
          finalizeRegistration={vi.fn()}
          registerWithGithub={vi.fn()}
          registerWithGoogle={vi.fn()}
        />
      );

      // Verify terms agreement checkbox is present (required for legal compliance)
      const termsCheckbox = screen.getByTestId('terms-checkbox');
      expect(termsCheckbox).toBeInTheDocument();
      expect(termsCheckbox).not.toBeChecked(); // Should start unchecked

      // Verify Terms of Service link exists with correct URL
      const termsLink = screen.getByTestId('terms-link');
      expect(termsLink).toBeInTheDocument();
      expect(termsLink).toHaveAttribute('href', 'https://www.agentmark.co/terms');
      expect(termsLink).toHaveAttribute('target', '_blank'); // Should open in new tab
      expect(termsLink).toHaveAttribute('rel', 'noopener noreferrer'); // Security best practice

      // Verify Privacy Policy link exists with correct URL
      const privacyLink = screen.getByTestId('privacy-link');
      expect(privacyLink).toBeInTheDocument();
      expect(privacyLink).toHaveAttribute('href', 'https://www.agentmark.co/privacy');
      expect(privacyLink).toHaveAttribute('target', '_blank'); // Should open in new tab
      expect(privacyLink).toHaveAttribute('rel', 'noopener noreferrer'); // Security best practice

      // Verify terms version is displayed for audit trail
      const versionDisplay = screen.getByTestId('terms-version');
      expect(versionDisplay).toBeInTheDocument();
    });
  });
});