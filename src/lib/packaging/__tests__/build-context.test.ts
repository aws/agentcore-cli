import type { AgentEnvSpec } from '../../../schema';
import { resolveBuildContext } from '../build-context.js';
import { describe, expect, it } from 'vitest';

// resolveCodeLocation resolves relative paths against the repo root (dirname of the config dir).
const CONFIG_ROOT = '/project/agentcore'; // repo root => /project

type ContextSpec = Pick<AgentEnvSpec, 'codeLocation' | 'buildContextPath' | 'dockerfile'>;
const spec = (o: Partial<ContextSpec> = {}): ContextSpec => ({ codeLocation: './agents/one', ...o }) as ContextSpec;

describe('resolveBuildContext', () => {
  it('uses codeLocation as the build context when buildContextPath is unset', () => {
    const { buildContext, dockerfilePath } = resolveBuildContext(spec(), CONFIG_ROOT);
    expect(buildContext).toBe('/project/agents/one');
    expect(dockerfilePath).toBe('/project/agents/one/Dockerfile');
  });

  it('uses buildContextPath as the build context when set, resolving the Dockerfile against it', () => {
    const { buildContext, dockerfilePath } = resolveBuildContext(
      spec({ buildContextPath: '.' as ContextSpec['buildContextPath'] }),
      CONFIG_ROOT
    );
    // The monorepo case: context is the repo root, and a shared root Dockerfile is resolved there —
    // NOT under the agent's own codeLocation (this is what keeps local dev/package matching deploy).
    expect(buildContext).toBe('/project');
    expect(dockerfilePath).toBe('/project/Dockerfile');
  });

  it('resolves a custom dockerfile subpath against the build context', () => {
    const { dockerfilePath } = resolveBuildContext(
      spec({
        buildContextPath: '.' as ContextSpec['buildContextPath'],
        dockerfile: 'docker/Dockerfile.gpu' as ContextSpec['dockerfile'],
      }),
      CONFIG_ROOT
    );
    expect(dockerfilePath).toBe('/project/docker/Dockerfile.gpu');
  });

  it('throws for an unsafe dockerfile path (traversal escaping the context)', () => {
    expect(() =>
      resolveBuildContext(spec({ dockerfile: '../evil' as ContextSpec['dockerfile'] }), CONFIG_ROOT)
    ).toThrow(/Invalid dockerfile path/);
  });
});
