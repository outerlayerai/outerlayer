import { buildAgentEnv, gitChildEnv, _SCRUBBED_KEYS_FOR_TEST } from '../lib/child-env.js';

describe('buildAgentEnv', () => {
  it('drops runner + platform secrets and layers tenant vars on top', () => {
    const base = {
      PATH: '/usr/bin',
      HOME: '/home/agent',
      WORKER_TOKEN: 'boot-token',
      WORKER_SECRET: 'run-secret',
      OUTERLAYER_DISPATCH_SECRET: 'dispatch',
      SOMETHING_ELSE: 'kept',
    } as NodeJS.ProcessEnv;

    const env = buildAgentEnv({ ANTHROPIC_API_KEY: 'sk-ant', CUSTOM: 'v' }, base);

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/agent');
    expect(env.SOMETHING_ELSE).toBe('kept');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant');
    expect(env.CUSTOM).toBe('v');
    expect(env.WORKER_TOKEN).toBeUndefined();
    expect(env.WORKER_SECRET).toBeUndefined();
    expect(env.OUTERLAYER_DISPATCH_SECRET).toBeUndefined();
  });

  it('does not let a tenant var re-introduce a scrubbed key', () => {
    const env = buildAgentEnv(
      { OUTERLAYER_API_KEY: 'attempt-to-inject' },
      { PATH: '/usr/bin' } as NodeJS.ProcessEnv,
    );
    expect(env.OUTERLAYER_API_KEY).toBeUndefined();
  });

  it('scrubs every documented privileged key', () => {
    for (const key of _SCRUBBED_KEYS_FOR_TEST) {
      const env = buildAgentEnv({}, { [key]: 'secret', PATH: '/usr/bin' } as NodeJS.ProcessEnv);
      expect(env[key]).toBeUndefined();
    }
  });

  it('never leaks the params-file handoff path to the agent', () => {
    const env = buildAgentEnv(
      {},
      { WORKER_PARAMS_FILE: '/tmp/worker-params-x/params.json', PATH: '/usr/bin' } as NodeJS.ProcessEnv,
    );
    expect(env.WORKER_PARAMS_FILE).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });
});

describe('gitChildEnv', () => {
  it('forwards only safe keys and pins LFS-skip + no-prompt', () => {
    const env = gitChildEnv({ PATH: '/usr/bin', WORKER_TOKEN: 'secret', FLY_API_TOKEN: 'fly' } as NodeJS.ProcessEnv);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.WORKER_TOKEN).toBeUndefined();
    expect(env.FLY_API_TOKEN).toBeUndefined();
    expect(env.GIT_LFS_SKIP_SMUDGE).toBe('1');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });
});
