import { describe, expect, it } from 'vitest';
import { resolveToggle } from '../toggle';

// Two representative seams exercise different features of the primitive:
//  - "errors": default-on-iff-connection + an `offBackend` ('none').
//  - "email":  explicit opt-in (defaultEnabled:false), multi-backend, no offBackend.
const ERRORS = ['sentry', 'none'] as const;
const EMAIL = ['resend', 'smtp'] as const;

describe('resolveToggle — backend selection', () => {
  it('defaults to backends[0] when no backend value is given', () => {
    expect(resolveToggle({ backends: EMAIL }).backend).toBe('resend');
  });

  it('selects a matching backend', () => {
    expect(resolveToggle({ backendValue: 'smtp', backends: EMAIL }).backend).toBe(
      'smtp'
    );
  });

  it('matches case-insensitively', () => {
    expect(resolveToggle({ backendValue: '  SMTP ', backends: EMAIL }).backend).toBe(
      'smtp'
    );
  });

  it('falls back to backends[0] for an unknown backend', () => {
    expect(
      resolveToggle({ backendValue: 'mailgun', backends: EMAIL }).backend
    ).toBe('resend');
  });
});

describe('resolveToggle — errors-style (default on iff connection)', () => {
  it('enables by default when a connection exists', () => {
    expect(
      resolveToggle({
        backends: ERRORS,
        offBackend: 'none',
        hasConnection: true,
      })
    ).toEqual({ enabled: true, backend: 'sentry' });
  });

  it('disables when there is no connection, even though default would be on', () => {
    expect(
      resolveToggle({
        backends: ERRORS,
        offBackend: 'none',
        hasConnection: false,
      })
    ).toEqual({ enabled: false, backend: 'sentry' });
  });

  it('the off backend forces disabled even with a connection and explicit enable', () => {
    expect(
      resolveToggle({
        enabledOverride: 'true',
        backendValue: 'none',
        backends: ERRORS,
        offBackend: 'none',
        hasConnection: true,
      })
    ).toEqual({ enabled: false, backend: 'none' });
  });

  it('explicit ENABLED=false overrides the default-on', () => {
    expect(
      resolveToggle({
        enabledOverride: 'false',
        backends: ERRORS,
        offBackend: 'none',
        hasConnection: true,
      })
    ).toEqual({ enabled: false, backend: 'sentry' });
  });

  it('explicit ENABLED=true cannot beat the missing-connection clamp', () => {
    expect(
      resolveToggle({
        enabledOverride: 'true',
        backends: ERRORS,
        offBackend: 'none',
        hasConnection: false,
      })
    ).toEqual({ enabled: false, backend: 'sentry' });
  });

  it('an unrecognised ENABLED value falls through to the default', () => {
    expect(
      resolveToggle({
        enabledOverride: 'sometimes',
        backends: ERRORS,
        offBackend: 'none',
        hasConnection: true,
      })
    ).toEqual({ enabled: true, backend: 'sentry' });
  });
});

describe('resolveToggle — email-style (explicit opt-in)', () => {
  it('stays disabled by default even though a connection is assumed present', () => {
    expect(
      resolveToggle({ backends: EMAIL, defaultEnabled: false })
    ).toEqual({ enabled: false, backend: 'resend' });
  });

  it('enables on explicit ENABLED=true and honours the selected backend', () => {
    expect(
      resolveToggle({
        enabledOverride: 'true',
        backendValue: 'smtp',
        backends: EMAIL,
        defaultEnabled: false,
      })
    ).toEqual({ enabled: true, backend: 'smtp' });
  });

  it('defaultEnabled=false is not overridden by an unrecognised ENABLED value', () => {
    expect(
      resolveToggle({
        enabledOverride: 'maybe',
        backends: EMAIL,
        defaultEnabled: false,
      })
    ).toEqual({ enabled: false, backend: 'resend' });
  });
});
