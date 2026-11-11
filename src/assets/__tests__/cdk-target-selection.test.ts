import { App, CfnResource, Stack, type StackProps } from 'aws-cdk-lib';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Script } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

// Execute the vended entry point, with the external construct boundary replaced by
// a stack that requires the same per-target credentials. No AWS account is needed.
const source = transpileModule(readFileSync(resolve(__dirname, '../cdk/bin/cdk.ts'), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS },
}).outputText;
const directories: string[] = [];
const targets = ['prod', 'dev', 'int'].map(name => ({ name, account: '123456789012', region: 'us-east-1' }));
const credential = {
  credentialProviderArn:
    'arn:aws:bedrock-agentcore:us-east-1:123456789012:token-vault/default/apikeycredentialprovider/test',
};

async function synthesize(
  selectedTarget: string | string[] | undefined,
  provisioned: string[],
  configuredTargets = targets,
  constructed: string[] = []
) {
  const root = mkdtempSync(join(tmpdir(), 'agentcore-target-test-'));
  directories.push(root);
  const configRoot = join(root, 'agentcore');
  const cdkRoot = join(configRoot, 'cdk');
  mkdirSync(join(configRoot, '.cli'), { recursive: true });
  mkdirSync(cdkRoot);
  writeFileSync(
    join(configRoot, '.cli/deployed-state.json'),
    JSON.stringify({
      targets: Object.fromEntries(
        provisioned.map(name => [name, { resources: { credentials: { 'api-key': credential } } }])
      ),
    })
  );
  let synthesized: string[] | undefined;
  const script = new Script(source, { filename: 'cdk.js' });
  await script.runInNewContext({
    exports: {},
    require: (name: string) => {
      if (name === '@aws/agentcore-cdk')
        return {
          ConfigIO: class {
            async readProjectSpec() {
              return { name: 'test', agentCoreGateways: [{ name: 'gateway' }] };
            }
            async readAWSDeploymentTargets() {
              return configuredTargets;
            }
          },
        };
      if (name === 'aws-cdk-lib')
        return {
          App: class extends App {
            constructor() {
              super({ outdir: join(root, 'cdk.out') });
            }
            override synth() {
              const assembly = super.synth();
              synthesized = assembly.stacks.map(stack => stack.stackName);
              return assembly;
            }
          },
        };
      if (name === '../lib/cdk-stack')
        return {
          AgentCoreStack: class extends Stack {
            constructor(app: App, id: string, props: StackProps & { credentials?: Record<string, typeof credential> }) {
              super(app, id, props);
              constructed.push(id);
              if (!props.credentials?.['api-key']) throw new Error('Credential "api-key" not found in deployed state');
              new CfnResource(this, 'Credential', {
                type: 'AWS::SSM::Parameter',
                properties: { Type: 'String', Value: props.credentials['api-key'].credentialProviderArn },
              });
            }
          },
        };
      if (name === 'path') return require('node:path');
      if (name === 'fs') return require('node:fs');
      throw new Error(`Unexpected import: ${name}`);
    },
    process: {
      cwd: () => cdkRoot,
      env:
        selectedTarget === undefined
          ? {}
          : {
              AGENTCORE_SYNTH_TARGETS: JSON.stringify(
                Array.isArray(selectedTarget) ? selectedTarget : [selectedTarget]
              ),
            },
      exit: () => {
        throw new Error('CDK app failed');
      },
    },
    console: {
      error: (_prefix: string, message: string) => {
        throw new Error(message);
      },
    },
  });
  return { constructed, synthesized };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('vended CDK app target selection', () => {
  it('constructs only the selected stack when sibling credentials do not exist', async () => {
    expect(await synthesize('dev', ['dev'])).toEqual({
      constructed: ['AgentCore-test-dev'],
      synthesized: ['AgentCore-test-dev'],
    });
  });

  it.each(['prod', 'int'])('selects %s regardless of its position in aws-targets.json', async target => {
    expect((await synthesize(target, [target])).synthesized).toEqual([`AgentCore-test-${target}`]);
  });

  it('preserves standalone all-target synthesis when every target is provisioned', async () => {
    expect((await synthesize(undefined, ['prod', 'dev', 'int'])).synthesized).toEqual(
      targets.map(target => `AgentCore-test-${target.name}`).sort()
    );
  });

  it('constructs every requested target without constructing an unselected sibling', async () => {
    expect((await synthesize(['prod', 'dev'], ['prod', 'dev'])).synthesized).toEqual([
      'AgentCore-test-dev',
      'AgentCore-test-prod',
    ]);
  });

  it('rejects an empty target selection', async () => {
    await expect(synthesize([], ['prod', 'dev', 'int'])).rejects.toThrow('must be a non-empty JSON array');
  });

  it('preserves single-target synthesis without a selection', async () => {
    expect((await synthesize(undefined, ['dev'], [targets[1]!])).synthesized).toEqual(['AgentCore-test-dev']);
  });

  it('still rejects missing credentials on the selected target', async () => {
    await expect(synthesize('dev', ['prod'])).rejects.toThrow('Credential "api-key" not found in deployed state');
  });

  it.each(['missing', ''])('rejects an unknown selection (%j) instead of synthesizing another target', async target => {
    await expect(synthesize(target, ['prod', 'dev', 'int'])).rejects.toThrow('not found in agentcore/aws-targets.json');
  });

  it('validates the entire selection before constructing any stack', async () => {
    const constructed: string[] = [];
    await expect(synthesize(['dev', 'missing'], ['dev'], targets, constructed)).rejects.toThrow(
      'Deployment target "missing" not found'
    );
    expect(constructed).toEqual([]);
  });

  it('constructs a target only once if the selection contains duplicates', async () => {
    expect((await synthesize(['dev', 'dev'], ['dev'])).synthesized).toEqual(['AgentCore-test-dev']);
  });

  it('retains the error for an empty target configuration', async () => {
    await expect(synthesize('dev', [], [])).rejects.toThrow('No deployment targets configured');
  });
});
