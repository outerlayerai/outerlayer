import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs gate script, no type declarations; plain JS exports.
import { scanWorkflow } from '../ci/check-workflow-secret-literals.mjs';

type Offender = { line: number; key: string; value: string };

const wf = (...lines: string[]) => lines.join('\n');

/**
 * The bug class: a credential-shaped workflow `env:` value written as a literal
 * instead of a `${{ secrets.* }}` reference. Entropy-based scanners cannot see
 * it (a human-chosen password is low-entropy prose with no prefix), so position
 * is the only signal — which is why the indentation tracking below carries the
 * whole gate rather than being an incidental detail.
 */
describe('scanWorkflow', () => {
  it('catches a password literal in an env block, with key, line, and value', () => {
    const source = wf(
      'jobs:',
      '  deploy:',
      '    steps:',
      '      - name: Seed CD probe fixture',
      '        env:',
      '          E2E_HIST_LOGIN_EMAIL: cd-probe@agentmark.co',
      '          E2E_HIST_LOGIN_PASSWORD: SynthFixturePw123!',
      '          E2E_HIST_USER_NAME: Synthetic Fixture Name',
    );
    expect(scanWorkflow(source) as Offender[]).toEqual([
      { line: 7, key: 'E2E_HIST_LOGIN_PASSWORD', value: 'SynthFixturePw123!' },
    ]);
  });

  it('accepts every expression form and rejects only the literal', () => {
    const source = wf(
      '    env:',
      '      A_TOKEN: ${{ secrets.SOME_TOKEN }}',
      '      B_SECRET: ${{ vars.SOME_VAR }}',
      '      C_PASSWORD: ${{ env.UPSTREAM }}',
      '      D_API_KEY: ${{ steps.mint.outputs.key }}',
      '      E_PASSWORD: hunter2andthensome',
    );
    expect(scanWorkflow(source) as Offender[]).toEqual([
      { line: 6, key: 'E_PASSWORD', value: 'hunter2andthensome' },
    ]);
  });

  it('leaves non-credential keys alone even when their values look secret-ish', () => {
    const source = wf(
      '    env:',
      '      E2E_HIST_USER_NAME: Synthetic Fixture Name',
      '      KEYCLOAK_URL: https://example.test',
      '      MONKEY_PATCH: enabled',
      '      NODE_VERSION: "22"',
      '      DORA_ENVIRONMENT: staging',
    );
    expect(scanWorkflow(source) as Offender[]).toEqual([]);
  });

  it('matches _KEY as a suffix and PEPPER by name, without false-firing on KEY-containing words', () => {
    const source = wf(
      '    env:',
      '      API_KEY_PEPPER: peppered-literal',
      '      SERVICE_ROLE_KEY: also-a-literal',
      '      TURKEY_BASTER: fine',
      '      KEYCLOAK_URL: https://example.test',
    );
    // API_KEY_PEPPER ends in _PEPPER, not _KEY, so the suffix arm alone would
    // miss the HMAC pepper every stored api-key digest depends on.
    // TURKEY_BASTER/KEYCLOAK_URL prove the suffix arm is anchored.
    expect(scanWorkflow(source) as Offender[]).toEqual([
      { line: 2, key: 'API_KEY_PEPPER', value: 'peppered-literal' },
      { line: 3, key: 'SERVICE_ROLE_KEY', value: 'also-a-literal' },
    ]);
  });

  it('allowlists the Supabase local demo service-role key but not a lookalike', () => {
    const demo =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
    const realProjectJwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJlYWxwcm9qZWN0In0.SIGNATURE';
    const source = wf(
      '    env:',
      `      SUPABASE_SERVICE_ROLE_KEY: ${demo}`,
      `      OTHER_SERVICE_ROLE_KEY: ${realProjectJwt}`,
    );
    // Exact-value allowlisting is the point: the demo key passes, a real
    // project's JWT with the same byte shape does not.
    expect(scanWorkflow(source) as Offender[]).toEqual([
      { line: 3, key: 'OTHER_SERVICE_ROLE_KEY', value: realProjectJwt },
    ]);
  });

  it('stops scanning at the end of the env block', () => {
    const source = wf(
      '    env:',
      '      GOOD_TOKEN: ${{ secrets.X }}',
      '    with:',
      '      MY_PASSWORD: this-is-a-with-input-not-env',
      '    run: echo hi',
    );
    // `with:` is dedented to the same level as `env:`, so the block has ended.
    expect(scanWorkflow(source) as Offender[]).toEqual([]);
  });

  it('re-enters on a second env block in the same file', () => {
    const source = wf(
      '    env:',
      '      FIRST_PASSWORD: ${{ secrets.A }}',
      '    run: one',
      '    env:',
      '      SECOND_PASSWORD: leaked-literal-two',
      '    run: two',
    );
    expect(scanWorkflow(source) as Offender[]).toEqual([
      { line: 5, key: 'SECOND_PASSWORD', value: 'leaked-literal-two' },
    ]);
  });

  it('strips quotes and trailing comments before judging the value', () => {
    const source = wf(
      '    env:',
      '      A_PASSWORD: "quoted-literal"',
      "      B_PASSWORD: 'single-quoted'",
      '      C_TOKEN: ${{ secrets.X }} # sourced from a secret',
      '      D_SECRET: bare-value # with a trailing note',
    );
    expect(scanWorkflow(source) as Offender[]).toEqual([
      { line: 2, key: 'A_PASSWORD', value: 'quoted-literal' },
      { line: 3, key: 'B_PASSWORD', value: 'single-quoted' },
      { line: 5, key: 'D_SECRET', value: 'bare-value' },
    ]);
  });

  it('ignores comments and blank lines', () => {
    const source = wf(
      '    env:',
      '      # A_PASSWORD: commented-out-literal',
      '',
      '      B_TOKEN: ${{ secrets.X }}',
    );
    expect(scanWorkflow(source) as Offender[]).toEqual([]);
  });

  it('catches a multi-line literal in a block scalar — the pasted-PEM shape', () => {
    const source = wf(
      '    env:',
      '      GITHUB_APP_PRIVATE_KEY: |',
      '        -----BEGIN RSA PRIVATE KEY-----',
      '        MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj',
      '        -----END RSA PRIVATE KEY-----',
      '      NEXT_TOKEN: ${{ secrets.X }}',
    );
    // Skipping block scalars outright would leave a bypass wide enough to
    // drive a private key through — which is the leak this repo already had.
    expect(scanWorkflow(source) as Offender[]).toEqual([
      {
        line: 2,
        key: 'GITHUB_APP_PRIVATE_KEY',
        value: [
          '-----BEGIN RSA PRIVATE KEY-----',
          'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj',
          '-----END RSA PRIVATE KEY-----',
        ].join('\n'),
      },
    ]);
  });

  it('accepts a block scalar whose body is expression-sourced', () => {
    const source = wf(
      '    env:',
      '      A_TOKEN: >-',
      '        ${{ secrets.PART_ONE }}',
      '      B_PASSWORD: ${{ secrets.X }}',
    );
    expect(scanWorkflow(source) as Offender[]).toEqual([]);
  });

  it('ends a block scalar at the first line dedented to the key, not at the block end', () => {
    const source = wf(
      '    env:',
      '      A_TOKEN: |',
      '        body-line',
      '      B_PASSWORD: separate-literal',
    );
    // If the body scan overran, B_PASSWORD would be swallowed into A_TOKEN's
    // value and never judged on its own.
    expect(scanWorkflow(source) as Offender[]).toEqual([
      { line: 2, key: 'A_TOKEN', value: 'body-line' },
      { line: 4, key: 'B_PASSWORD', value: 'separate-literal' },
    ]);
  });
});
