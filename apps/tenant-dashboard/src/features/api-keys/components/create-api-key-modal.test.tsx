// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ---------------------------------------------------------------------------
// MUI mocks -- MUI 7.x Dialog/Select/etc fail in jsdom
// ---------------------------------------------------------------------------
vi.mock('@mui/material', async () => {
  const actual = await vi.importActual<typeof import('@mui/material')>('@mui/material');
  return {
    ...actual,
    Dialog: ({ children, open }: any) =>
      open ? <div data-testid="dialog">{children}</div> : null,
    DialogTitle: ({ children }: any) => <div>{children}</div>,
    DialogContent: ({ children }: any) => <div>{children}</div>,
    DialogActions: ({ children }: any) => <div>{children}</div>,
    Select: ({ children, value, onChange, ...props }: any) => (
      <select
        data-testid={props['data-testid'] || 'select'}
        value={value}
        onChange={(e: any) => onChange?.({ target: { value: e.target.value } })}
      >
        {children}
      </select>
    ),
    MenuItem: ({ children, value }: any) => <option value={value}>{children}</option>,
  };
});

// ---------------------------------------------------------------------------
// Mock server action
// ---------------------------------------------------------------------------
const mockCreateApiKeyAction = vi.fn();
vi.mock('../actions', () => ({
  createApiKeyAction: (...args: any[]) => mockCreateApiKeyAction(...args),
}));

// ---------------------------------------------------------------------------
// Mock app context
// ---------------------------------------------------------------------------
vi.mock('@/lib/app-shell/app-context', () => ({
  useAppContext: () => ({ app: { id: 'app-1', name: 'Test App' } }),
}));

// ---------------------------------------------------------------------------
// Mock the selected-env hook — a true seam (a hook with a stable signature,
// not an HTTP boundary). The modal binds a created key to this env.
// ---------------------------------------------------------------------------
vi.mock('@/hooks/environments', () => ({
  useSelectedEnv: () => ({
    name: 'dev',
    id: 'env-default',
    isPinned: false,
    pinnedVersion: null,
    isDefault: true,
    isUnknown: false,
  }),
}));

// ---------------------------------------------------------------------------
// Mock the hook-form seam (FormProvider default + RHFTextField). The component
// pulls both from `@/components/hook-form`, which re-exports this index module.
// ---------------------------------------------------------------------------
vi.mock('@/components/hook-form', () => ({
  __esModule: true,
  default: ({ children, onSubmit }: any) => (
    <form onSubmit={onSubmit}>{children}</form>
  ),
  RHFTextField: ({ name, label }: any) => (
    <div>
      <label htmlFor={name}>{label}</label>
      <input id={name} name={name} aria-label={label} />
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Mock UpgradePrompt
// ---------------------------------------------------------------------------
vi.mock('@/components/upgrade-prompt', () => ({
  UpgradePrompt: ({ info }: any) => (
    <div data-testid="upgrade-prompt">{info?.message}</div>
  ),
}));

import { CreateApiKeyModal } from './create-api-key-modal';

describe('CreateApiKeyModal', () => {
  beforeEach(() => {
    mockCreateApiKeyAction.mockReset();
  });

  describe('create button visibility', () => {
    it('should render Create button when canCreateApiKey is true', () => {
      render(<CreateApiKeyModal canCreateApiKey={true} />);
      const button = screen.getByRole('button', {
        name: /dashboard\.developers\.createButton/i,
      });
      expect(button).toBeInTheDocument();
    });

    it('should not render Create button when canCreateApiKey is false', () => {
      render(<CreateApiKeyModal canCreateApiKey={false} />);
      const button = screen.queryByRole('button', {
        name: /dashboard\.developers\.createButton/i,
      });
      expect(button).not.toBeInTheDocument();
    });
  });

  describe('dialog initial state', () => {
    it('should not show create dialog when useBoolean returns false', () => {
      render(<CreateApiKeyModal canCreateApiKey={true} />);
      // The dialog mock only renders children when open=true.
      // useBoolean is mocked to return value: false, so dialog should not render.
      const dialogs = screen.queryAllByTestId('dialog');
      // The ShowApiKeyDialog is also controlled by a useBoolean mock (value: false),
      // so neither dialog should be open.
      expect(dialogs).toHaveLength(0);
    });
  });
});
