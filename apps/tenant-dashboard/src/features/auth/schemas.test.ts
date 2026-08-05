import { describe, it, expect } from 'vitest';

import {
  buildRegisterSchema,
  buildNewPasswordSchema,
  buildLoginSchema,
  buildForgotPasswordSchema,
} from './schemas';

// Identity `t` → messages equal their keys, so each assertion pins the rule.
const t = (key: string) => key;

/** `path:message` pairs for a failed parse (empty on success). */
function issues(schema: { safeParse: (v: unknown) => any }, input: unknown): string[] {
  const r = schema.safeParse(input);
  if (r.success) return [];
  return r.error.issues.map((i: any) => `${i.path.join('.')}:${i.message}`);
}

describe('buildRegisterSchema', () => {
  const schema = buildRegisterSchema(t);
  const valid = {
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    password: 'Str0ng!pw',
    agreedToTerms: true,
  };

  it('accepts a fully valid registration', () => {
    expect(schema.safeParse(valid).success).toBe(true);
  });

  it('requires firstName and lastName', () => {
    // Only the name is blank → removing that .min(1) would flip this to pass.
    expect(issues(schema, { ...valid, firstName: '' })).toContain(
      'firstName:auth.validation.firstName.required',
    );
    expect(issues(schema, { ...valid, lastName: '' })).toContain(
      'lastName:auth.validation.lastName.required',
    );
  });

  it('rejects a non-email that is otherwise present', () => {
    expect(issues(schema, { ...valid, email: 'not-an-email' })).toContain(
      'email:auth.validation.email.invalid',
    );
  });

  it('enforces each password rule in isolation', () => {
    // Each input satisfies every rule EXCEPT one, so removing that single
    // constraint would make it pass — killing that specific mutant.
    expect(issues(schema, { ...valid, password: 'Aa1!bcd' })).toContain(
      'password:Password must be at least 8 characters', // 7 chars, all classes
    );
    expect(issues(schema, { ...valid, password: 'aaa1!bcd' })).toContain(
      'password:Password must contain at least one uppercase letter',
    );
    expect(issues(schema, { ...valid, password: 'AAA1!BCD' })).toContain(
      'password:Password must contain at least one lowercase letter',
    );
    expect(issues(schema, { ...valid, password: 'Aaa!bcde' })).toContain(
      'password:Password must contain at least one number',
    );
    expect(issues(schema, { ...valid, password: 'Aaa1bcde' })).toContain(
      'password:Password must contain at least one special character',
    );
  });

  it('requires agreeing to the terms (true, not merely truthy)', () => {
    expect(issues(schema, { ...valid, agreedToTerms: false })).toContain(
      'agreedToTerms:You must agree to the Terms of Service and Privacy Policy',
    );
    // And the positive branch passes — pins the `=== true` predicate both ways.
    expect(schema.safeParse({ ...valid, agreedToTerms: true }).success).toBe(true);
  });
});

describe('buildNewPasswordSchema', () => {
  const schema = buildNewPasswordSchema(t);

  it('accepts matching passwords of adequate length', () => {
    expect(schema.safeParse({ password: 'secret', confirmPassword: 'secret' }).success).toBe(true);
  });

  it('enforces the 6-char minimum', () => {
    // 5 chars, matching → only .min(6) fails.
    const found = issues(schema, { password: 'short', confirmPassword: 'short' });
    expect(found).toContain('password:auth.validation.password.min');
  });

  it('rejects a confirmation that does not match, on the confirmPassword path', () => {
    expect(issues(schema, { password: 'secret1', confirmPassword: 'secret2' })).toContain(
      'confirmPassword:auth.validation.password.match',
    );
    // Matching passes — pins the `confirmPassword === password` predicate.
    expect(schema.safeParse({ password: 'secret1', confirmPassword: 'secret1' }).success).toBe(true);
  });
});

describe('buildLoginSchema', () => {
  it('requires a password when SSO is NOT enforced', () => {
    const schema = buildLoginSchema(t, false);
    expect(issues(schema, { email: 'ada@example.com', password: '' })).toContain(
      'password:auth.validation.password.required',
    );
    expect(schema.safeParse({ email: 'ada@example.com', password: 'pw' }).success).toBe(true);
  });

  it('allows a blank password when SSO IS enforced', () => {
    const schema = buildLoginSchema(t, true);
    expect(schema.safeParse({ email: 'ada@example.com', password: '' }).success).toBe(true);
  });

  it('rejects a malformed email in both modes', () => {
    for (const enforced of [false, true]) {
      const schema = buildLoginSchema(t, enforced);
      expect(issues(schema, { email: 'nope', password: 'pw' })).toContain(
        'email:auth.validation.email.invalid',
      );
    }
  });
});

describe('buildForgotPasswordSchema', () => {
  const schema = buildForgotPasswordSchema(t);

  it('accepts a valid email and rejects a malformed one', () => {
    expect(schema.safeParse({ email: 'ada@example.com' }).success).toBe(true);
    expect(issues(schema, { email: 'not-an-email' })).toContain(
      'email:auth.validation.email.invalid',
    );
  });
});
