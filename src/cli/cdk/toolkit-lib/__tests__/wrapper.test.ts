import { SYNTH_TARGET_ENV_VAR } from '../constants';
import { CdkToolkitWrapper } from '../wrapper';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { fromCdkApp, awsCliCompatible } = vi.hoisted(() => ({
  fromCdkApp: vi.fn().mockResolvedValue({}),
  awsCliCompatible: vi.fn(),
}));

vi.mock('@aws-cdk/toolkit-lib', () => ({
  Toolkit: class {
    fromCdkApp = fromCdkApp;
  },
  BaseCredentials: { awsCliCompatible },
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('CDK app target selection', () => {
  it('passes the deployment target and region to the child app without changing the parent environment', async () => {
    vi.stubEnv(SYNTH_TARGET_ENV_VAR, 'inherited');
    const wrapper = new CdkToolkitWrapper({
      projectDir: '/project/agentcore/cdk',
      targetNames: ['prod'],
      region: 'eu-west-1',
    });
    await wrapper.initialize();

    expect(fromCdkApp).toHaveBeenCalledWith('node dist/bin/cdk.js', {
      workingDirectory: '/project/agentcore/cdk',
      env: { AGENTCORE_SYNTH_TARGETS: '["prod"]', AWS_REGION: 'eu-west-1', AWS_DEFAULT_REGION: 'eu-west-1' },
    });
    expect(process.env[SYNTH_TARGET_ENV_VAR]).toBe('inherited');
  });

  it('clears an inherited target for unscoped operations', async () => {
    vi.stubEnv(SYNTH_TARGET_ENV_VAR, 'prod');
    await new CdkToolkitWrapper().initialize();

    expect(fromCdkApp.mock.calls[0]?.[1].env).toHaveProperty(SYNTH_TARGET_ENV_VAR, undefined);
    expect(process.env[SYNTH_TARGET_ENV_VAR]).toBe('prod');
  });
});
