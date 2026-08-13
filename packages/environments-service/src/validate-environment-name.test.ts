import { validateEnvironmentName } from './validate-environment-name';

describe('validateEnvironmentName', () => {
  describe('valid names', () => {
    test.each([
      'dev',
      'prod',
      'staging',
      'qa',                            // 2 chars (minimum)
      'a'.repeat(40),                  // 40 chars (maximum)
      'pr-1',                          // hyphen ok in middle
      'pull-request-123',              // multiple hyphens + digits
      'a1',                            // letter + digit minimum
    ])('accepts %s', (name) => {
      expect(validateEnvironmentName(name)).toEqual({ valid: true });
    });
  });

  describe('invalid names — length', () => {
    // proves AC-069-12
    test('rejects single char (under 2-char minimum)', () => {
      const r = validateEnvironmentName('a');
      expect(r.valid).toBe(false);
      if (!r.valid) {
        expect(r.reason).toBe('env_name_invalid');
        expect(r.message).toMatch(/2-40 characters/);
      }
    });

    test('rejects 41 chars (over 40-char max)', () => {
      const r = validateEnvironmentName('a'.repeat(41));
      expect(r.valid).toBe(false);
    });

    test('rejects empty string', () => {
      const r = validateEnvironmentName('');
      expect(r.valid).toBe(false);
    });
  });

  describe('invalid names — character set', () => {
    test('rejects uppercase letters', () => {
      const r = validateEnvironmentName('Prod');
      expect(r.valid).toBe(false);
      if (!r.valid) {
        expect(r.message).toMatch(/start with a letter; lowercase/);
      }
    });

    test('rejects starting with digit', () => {
      expect(validateEnvironmentName('1prod').valid).toBe(false);
    });

    test('rejects starting with hyphen', () => {
      expect(validateEnvironmentName('-prod').valid).toBe(false);
    });

    test('rejects internal whitespace', () => {
      expect(validateEnvironmentName('pr od').valid).toBe(false);
    });

    test('rejects underscores', () => {
      expect(validateEnvironmentName('my_env').valid).toBe(false);
    });

    test('rejects dots', () => {
      expect(validateEnvironmentName('my.env').valid).toBe(false);
    });

    test('rejects forward slashes', () => {
      expect(validateEnvironmentName('my/env').valid).toBe(false);
    });
  });

  describe('non-string inputs', () => {
    test('rejects null', () => {
      // @ts-expect-error — testing runtime guard
      expect(validateEnvironmentName(null).valid).toBe(false);
    });

    test('rejects undefined', () => {
      // @ts-expect-error — testing runtime guard
      expect(validateEnvironmentName(undefined).valid).toBe(false);
    });

    test('rejects number', () => {
      // @ts-expect-error — testing runtime guard
      expect(validateEnvironmentName(42).valid).toBe(false);
    });
  });
});
