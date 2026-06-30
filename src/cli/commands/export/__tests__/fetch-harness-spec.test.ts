import type { Harness } from '../../../aws/agentcore-harness';
import { fetchHarnessSpecByArn, harnessIdFromArn, mapApiHarnessToSpec } from '../fetch-harness-spec';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetHarness } = vi.hoisted(() => ({ mockGetHarness: vi.fn() }));
const { mockResolveVpcId } = vi.hoisted(() => ({ mockResolveVpcId: vi.fn() }));

vi.mock('../../../aws/agentcore-harness', async () => {
  const actual = await vi.importActual<typeof import('../../../aws/agentcore-harness')>(
    '../../../aws/agentcore-harness'
  );
  return { ...actual, getHarness: (...args: unknown[]) => mockGetHarness(...args) };
});

vi.mock('../../shared/vpc-utils', async () => {
  const actual = await vi.importActual<typeof import('../../shared/vpc-utils')>('../../shared/vpc-utils');
  return { ...actual, resolveVpcIdFromSubnets: (...args: unknown[]) => mockResolveVpcId(...args) };
});

function makeApiHarness(overrides: Partial<Harness> = {}): Harness {
  return {
    harnessId: 'h-123',
    harnessName: 'MyHarness',
    arn: 'arn:aws:bedrock-agentcore:us-east-1:111122223333:harness/h-123',
    status: 'READY',
    executionRoleArn: 'arn:aws:iam::111122223333:role/harness-role',
    model: { bedrockModelConfig: { modelId: 'anthropic.claude-3' } },
    systemPrompt: [{ text: 'You are helpful.' }],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('harnessIdFromArn', () => {
  it('extracts the id from a harness ARN', () => {
    expect(harnessIdFromArn('arn:aws:bedrock-agentcore:us-east-1:111122223333:harness/h-123')).toBe('h-123');
  });

  it('throws on a non-harness ARN', () => {
    expect(() => harnessIdFromArn('arn:aws:bedrock-agentcore:us-east-1:111122223333:memory/m-1')).toThrow();
  });
});

describe('mapApiHarnessToSpec', () => {
  it('maps a bedrock harness to a HarnessSpec', () => {
    const { spec, systemPrompt } = mapApiHarnessToSpec(makeApiHarness());
    expect(spec.name).toBe('MyHarness');
    expect(spec.model).toEqual({ provider: 'bedrock', modelId: 'anthropic.claude-3' });
    expect(systemPrompt).toBe('You are helpful.');
  });

  it('does NOT carry the harness executionRoleArn — the exported agent gets its own CDK-managed role', () => {
    // Reusing the harness's (imported, immutable) role would prevent CDK from attaching the runtime
    // baseline (ECR pull for Container builds), connection grants, and additionalPolicies — which
    // breaks Container deploys. The exported agent is a new, independent runtime.
    const { spec } = mapApiHarnessToSpec(makeApiHarness());
    expect(spec.executionRoleArn).toBeUndefined();
  });

  it('maps an openai harness with apiKeyArn', () => {
    const { spec } = mapApiHarnessToSpec(
      makeApiHarness({ model: { openAiModelConfig: { modelId: 'gpt-4.1', apiKeyArn: 'arn:aws:...:secret/k' } } })
    );
    expect(spec.model).toEqual({ provider: 'open_ai', modelId: 'gpt-4.1', apiKeyArn: 'arn:aws:...:secret/k' });
  });

  it('maps a gemini harness with topK', () => {
    const { spec } = mapApiHarnessToSpec(
      makeApiHarness({
        model: { geminiModelConfig: { modelId: 'gemini-2.0', apiKeyArn: 'arn:aws:...:secret/g', topK: 40 } },
      })
    );
    expect(spec.model).toEqual({
      provider: 'gemini',
      modelId: 'gemini-2.0',
      apiKeyArn: 'arn:aws:...:secret/g',
      topK: 40,
    });
  });

  it('maps a lite_llm harness with apiBase and additionalParams', () => {
    const { spec } = mapApiHarnessToSpec(
      makeApiHarness({
        model: {
          liteLlmModelConfig: {
            modelId: 'bedrock/claude',
            apiBase: 'https://proxy.example',
            additionalParams: { x: '1' },
          },
        },
      })
    );
    expect(spec.model).toEqual({
      provider: 'lite_llm',
      modelId: 'bedrock/claude',
      apiBase: 'https://proxy.example',
      additionalParams: { x: '1' },
    });
  });

  it('maps an external memory reference', () => {
    const { spec } = mapApiHarnessToSpec(
      makeApiHarness({
        memory: {
          agentCoreMemoryConfiguration: {
            arn: 'arn:aws:bedrock-agentcore:us-east-1:999:memory/external',
            actorId: 'actor-1',
          },
        },
      })
    );
    expect(spec.memory).toEqual({
      mode: 'existing',
      arn: 'arn:aws:bedrock-agentcore:us-east-1:999:memory/external',
      actorId: 'actor-1',
    });
  });

  it('maps a provisioned managed memory (with arn) to existing-by-arn', () => {
    // A harness-owned "managed" memory still has a concrete, service-populated ARN once READY, so it
    // is referenced by ARN like any external memory (export then wires it as a memory connection).
    const { spec } = mapApiHarnessToSpec(
      makeApiHarness({
        memory: {
          managedMemoryConfiguration: { arn: 'arn:aws:bedrock-agentcore:us-east-1:999:memory/harness_x_a9c0-zvOY' },
        } as any,
      })
    );
    expect(spec.memory).toEqual({
      mode: 'existing',
      arn: 'arn:aws:bedrock-agentcore:us-east-1:999:memory/harness_x_a9c0-zvOY',
    });
  });

  it('maps a managed memory WITHOUT an arn to mode "managed" (not yet provisioned)', () => {
    const { spec } = mapApiHarnessToSpec(makeApiHarness({ memory: { managedMemoryConfiguration: {} } as any }));
    expect(spec.memory).toEqual({ mode: 'managed' });
  });

  it('maps an SDK-unknown managed memory member to mode "managed" (SDK lags service)', () => {
    // When the bundled SDK model lacks the variant, the service member surfaces as SDK_UNKNOWN_MEMBER.
    const { spec } = mapApiHarnessToSpec(
      makeApiHarness({ memory: { SDK_UNKNOWN_MEMBER: { name: 'managedMemoryConfiguration' } } as any })
    );
    expect(spec.memory).toEqual({ mode: 'managed' });
  });

  it('omits memory entirely for an unrecognized memory shape', () => {
    const { spec } = mapApiHarnessToSpec(
      makeApiHarness({ memory: { SDK_UNKNOWN_MEMBER: { name: 'somethingElse' } } as any })
    );
    expect('memory' in spec).toBe(false);
  });

  describe('runtime-environment + truncation (--arn fidelity fix)', () => {
    it('carries the truncation config (control-plane shape matches local 1:1)', () => {
      const { spec } = mapApiHarnessToSpec(
        makeApiHarness({ truncation: { strategy: 'sliding_window', config: { slidingWindow: { messagesCount: 12 } } } })
      );
      expect(spec.truncation).toEqual({ strategy: 'sliding_window', config: { slidingWindow: { messagesCount: 12 } } });
    });

    it('carries session storage from filesystemConfigurations', () => {
      const { spec } = mapApiHarnessToSpec(
        makeApiHarness({
          environment: {
            agentCoreRuntimeEnvironment: {
              filesystemConfigurations: [{ sessionStorage: { mountPath: '/mnt/data' } }],
            },
          },
        })
      );
      expect(spec.sessionStoragePath).toBe('/mnt/data');
    });

    it('carries lifecycle config (same field names)', () => {
      const { spec } = mapApiHarnessToSpec(
        makeApiHarness({
          environment: {
            agentCoreRuntimeEnvironment: {
              lifecycleConfiguration: { idleRuntimeSessionTimeout: 1200, maxLifetime: 7200 },
            },
          },
        })
      );
      expect(spec.lifecycleConfig).toEqual({ idleRuntimeSessionTimeout: 1200, maxLifetime: 7200 });
    });

    it('carries VPC network mode + subnets/securityGroups', () => {
      const { spec } = mapApiHarnessToSpec(
        makeApiHarness({
          environment: {
            agentCoreRuntimeEnvironment: {
              networkConfiguration: {
                networkMode: 'VPC',
                networkModeConfig: { subnets: ['subnet-0123456789abcdef0'], securityGroups: ['sg-0123456789abcdef0'] },
              },
            },
          },
        })
      );
      expect(spec.networkMode).toBe('VPC');
      expect(spec.networkConfig).toEqual({
        subnets: ['subnet-0123456789abcdef0'],
        securityGroups: ['sg-0123456789abcdef0'],
      });
    });

    it('throws early when a VPC harness is missing securityGroups (would otherwise crash post-write)', () => {
      // The local AgentEnvSpec schema requires BOTH subnets and securityGroups for VPC. A VPC harness
      // with only one (or AWS-default subnets) must fail here, during the pre-write fetch — not emit
      // networkMode:'VPC' with no networkConfig and blow up later in writeProjectSpec's validation
      // after the agent dir and code were already written.
      expect(() =>
        mapApiHarnessToSpec(
          makeApiHarness({
            environment: {
              agentCoreRuntimeEnvironment: {
                networkConfiguration: {
                  networkMode: 'VPC',
                  networkModeConfig: { subnets: ['subnet-0123456789abcdef0'] },
                },
              },
            },
          })
        )
      ).toThrow(/VPC/);
    });

    it('throws when a VPC harness has no networkModeConfig at all', () => {
      expect(() =>
        mapApiHarnessToSpec(
          makeApiHarness({
            environment: { agentCoreRuntimeEnvironment: { networkConfiguration: { networkMode: 'VPC' } } },
          })
        )
      ).toThrow(/VPC/);
    });

    it('does not set networkMode for PUBLIC (the implicit local default)', () => {
      const { spec } = mapApiHarnessToSpec(
        makeApiHarness({
          environment: { agentCoreRuntimeEnvironment: { networkConfiguration: { networkMode: 'PUBLIC' } } },
        })
      );
      expect('networkMode' in spec).toBe(false);
    });

    it('carries EFS and S3 access-point mounts from the filesystem tagged union', () => {
      const efsArn = 'arn:aws:elasticfilesystem:us-east-1:111122223333:access-point/fsap-0123456789abcdef0';
      const s3Arn =
        'arn:aws:s3files:us-east-1:111122223333:file-system/fs-0123456789abcdef0/access-point/fsap-0123456789abcdef0';
      const { spec } = mapApiHarnessToSpec(
        makeApiHarness({
          environment: {
            agentCoreRuntimeEnvironment: {
              filesystemConfigurations: [
                { efsAccessPoint: { accessPointArn: efsArn, mountPath: '/mnt/efsdata' } },
                { s3FilesAccessPoint: { accessPointArn: s3Arn, mountPath: '/mnt/s3data' } },
              ],
            },
          },
        })
      );
      expect(spec.efsAccessPoints).toEqual([{ accessPointArn: efsArn, mountPath: '/mnt/efsdata' }]);
      expect(spec.s3AccessPoints).toEqual([{ accessPointArn: s3Arn, mountPath: '/mnt/s3data' }]);
    });

    it('omits runtime-environment fields when the environment block is absent', () => {
      const { spec } = mapApiHarnessToSpec(makeApiHarness());
      expect('sessionStoragePath' in spec).toBe(false);
      expect('networkMode' in spec).toBe(false);
      expect('lifecycleConfig' in spec).toBe(false);
      expect('truncation' in spec).toBe(false);
    });
  });

  it('maps tools and allowedTools', () => {
    const { spec } = mapApiHarnessToSpec(
      makeApiHarness({
        tools: [
          { type: 'agentcore_gateway', name: 'gw', config: { agentCoreGateway: { gatewayArn: 'arn:...:gateway/g' } } },
        ],
        allowedTools: ['gw'],
      })
    );
    expect(spec.tools).toHaveLength(1);
    expect(spec.tools[0]).toMatchObject({ type: 'agentcore_gateway', name: 'gw' });
    expect(spec.allowedTools).toEqual(['gw']);
  });

  it('throws when no model configuration is present', () => {
    expect(() => mapApiHarnessToSpec(makeApiHarness({ model: undefined }))).toThrow();
  });

  describe('skill normalization (control-plane → local shape)', () => {
    it('normalizes a structured S3 skill { S3: { Uri } } to { s3Uri } so isS3Skill matches', () => {
      const { spec } = mapApiHarnessToSpec(
        makeApiHarness({ skills: [{ S3: { Uri: 's3://my-bucket/skills/weather/' } } as any] })
      );
      expect(spec.skills[0]).toEqual({ s3Uri: 's3://my-bucket/skills/weather/' });
    });

    it('normalizes a structured Git skill { Git: { Url, Path } } to { gitUrl, path }', () => {
      const { spec } = mapApiHarnessToSpec(
        makeApiHarness({ skills: [{ Git: { Url: 'https://github.com/x/y', Path: 'skills' } } as any] })
      );
      expect(spec.skills[0]).toEqual({ gitUrl: 'https://github.com/x/y', path: 'skills' });
    });

    it('normalizes a structured Path skill { Path } to { path }', () => {
      const { spec } = mapApiHarnessToSpec(makeApiHarness({ skills: [{ Path: 'skills/local' } as any] }));
      expect(spec.skills[0]).toEqual({ path: 'skills/local' });
    });

    it('passes through an already-lowercase S3 skill { s3Uri }', () => {
      const { spec } = mapApiHarnessToSpec(makeApiHarness({ skills: [{ s3Uri: 's3://b/p/' }] }));
      expect(spec.skills[0]).toEqual({ s3Uri: 's3://b/p/' });
    });

    it('normalizes a structured Git skill with no Path to { gitUrl } only', () => {
      const { spec } = mapApiHarnessToSpec(
        makeApiHarness({ skills: [{ Git: { Url: 'https://github.com/x/y' } } as any] })
      );
      expect(spec.skills[0]).toEqual({ gitUrl: 'https://github.com/x/y' });
    });

    it('passes through an already-lowercase git skill { gitUrl, path }', () => {
      const { spec } = mapApiHarnessToSpec(
        makeApiHarness({ skills: [{ gitUrl: 'https://g/r', path: 'skills' } as any] })
      );
      expect(spec.skills[0]).toEqual({ gitUrl: 'https://g/r', path: 'skills' });
    });

    it('carries private-repo git auth (credentialArn -> credentialName) + username', () => {
      // The lowercase control-plane shape from GetHarness: git.auth.{credentialArn, username}.
      // Without this, an --arn-exported private git skill would clone anonymously and fail.
      const credentialArn =
        'arn:aws:bedrock-agentcore:us-east-1:111122223333:token-vault/default/apikeycredentialprovider/gitkey';
      const { spec } = mapApiHarnessToSpec(
        makeApiHarness({
          skills: [
            {
              git: {
                url: 'https://github.com/me/private',
                path: 'skills/x',
                auth: { credentialArn, username: 'me' },
              },
            } as any,
          ],
        })
      );
      expect(spec.skills[0]).toEqual({
        gitUrl: 'https://github.com/me/private',
        path: 'skills/x',
        auth: { credentialName: credentialArn, username: 'me' },
      });
    });

    it('carries git auth with default username when none is given', () => {
      const credentialArn =
        'arn:aws:bedrock-agentcore:us-east-1:111122223333:token-vault/default/apikeycredentialprovider/gitkey';
      const { spec } = mapApiHarnessToSpec(
        makeApiHarness({ skills: [{ git: { url: 'https://g/r', auth: { credentialArn } } } as any] })
      );
      expect(spec.skills[0]).toEqual({ gitUrl: 'https://g/r', auth: { credentialName: credentialArn } });
    });
  });

  it('produces a spec that round-trips into export mapping inputs (no undefined keys)', () => {
    const { spec } = mapApiHarnessToSpec(makeApiHarness());
    // optional fields absent from the API payload must not appear as `undefined` keys
    expect('memory' in spec).toBe(false);
    expect('containerUri' in spec).toBe(false);
  });
});

describe('fetchHarnessSpecByArn — VPC vpcId resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // A Container (containerUri) harness in VPC mode — exercises the vpcId-resolution path, since the
  // schema requires vpcId for Container builds and a containerUri export still runs CodeBuild.
  function makeVpcHarness(): Harness {
    return makeApiHarness({
      environmentArtifact: {
        containerConfiguration: {
          containerUri: '111122223333.dkr.ecr.us-east-1.amazonaws.com/my-harness:latest',
        },
      },
      environment: {
        agentCoreRuntimeEnvironment: {
          networkConfiguration: {
            networkMode: 'VPC',
            networkModeConfig: {
              subnets: ['subnet-0a1b2c3d4e5f6a7b8'],
              securityGroups: ['sg-0a1b2c3d4e5f6a7b8'],
            },
          },
        },
      },
    });
  }

  it('resolves vpcId from subnets for a VPC harness and includes it in networkConfig', async () => {
    mockGetHarness.mockResolvedValue({ harness: makeVpcHarness() });
    mockResolveVpcId.mockResolvedValue('vpc-0abc1234567890def');

    const { spec } = await fetchHarnessSpecByArn(
      'arn:aws:bedrock-agentcore:us-east-1:111122223333:harness/h-123',
      'us-east-1'
    );

    expect(spec.networkMode).toBe('VPC');
    expect(spec.networkConfig?.vpcId).toBe('vpc-0abc1234567890def');
    expect(spec.networkConfig?.subnets).toEqual(['subnet-0a1b2c3d4e5f6a7b8']);
    expect(spec.networkConfig?.securityGroups).toEqual(['sg-0a1b2c3d4e5f6a7b8']);
    expect(mockResolveVpcId).toHaveBeenCalledWith(['subnet-0a1b2c3d4e5f6a7b8'], 'us-east-1');
  });

  it('propagates DescribeSubnets error with actionable message naming ec2:DescribeSubnets', async () => {
    mockGetHarness.mockResolvedValue({ harness: makeVpcHarness() });
    mockResolveVpcId.mockRejectedValue(
      new Error(
        'Failed to resolve VPC ID from subnet subnet-0a1b2c3d4e5f6a7b8: ec2:DescribeSubnets permission is required.'
      )
    );

    await expect(
      fetchHarnessSpecByArn('arn:aws:bedrock-agentcore:us-east-1:111122223333:harness/h-123', 'us-east-1')
    ).rejects.toThrow('ec2:DescribeSubnets');
  });

  it('does not call resolveVpcIdFromSubnets for PUBLIC mode harnesses', async () => {
    mockGetHarness.mockResolvedValue({
      harness: makeApiHarness({
        environment: {
          agentCoreRuntimeEnvironment: { networkConfiguration: { networkMode: 'PUBLIC' } },
        },
      }),
    });

    const { spec } = await fetchHarnessSpecByArn(
      'arn:aws:bedrock-agentcore:us-east-1:111122223333:harness/h-123',
      'us-east-1'
    );

    expect('networkMode' in spec).toBe(false);
    expect(mockResolveVpcId).not.toHaveBeenCalled();
  });

  it('does NOT resolve vpcId for a CodeZip VPC harness (no containerUri/dockerfile → no CodeBuild → vpcId not required)', async () => {
    // Neither containerUri nor dockerfile → CodeZip build. The schema does not require vpcId for it,
    // so we must not make a needless DescribeSubnets call (and must not demand that IAM permission).
    mockGetHarness.mockResolvedValue({
      harness: makeApiHarness({
        environment: {
          agentCoreRuntimeEnvironment: {
            networkConfiguration: {
              networkMode: 'VPC',
              networkModeConfig: {
                subnets: ['subnet-0a1b2c3d4e5f6a7b8'],
                securityGroups: ['sg-0a1b2c3d4e5f6a7b8'],
              },
            },
          },
        },
      }),
    });

    const { spec } = await fetchHarnessSpecByArn(
      'arn:aws:bedrock-agentcore:us-east-1:111122223333:harness/h-123',
      'us-east-1'
    );

    expect(spec.containerUri).toBeUndefined();
    expect(spec.networkConfig?.vpcId).toBeUndefined();
    expect(mockResolveVpcId).not.toHaveBeenCalled();
  });

  it('does not call resolveVpcIdFromSubnets when harness has no environment block', async () => {
    mockGetHarness.mockResolvedValue({ harness: makeApiHarness() });

    const { spec } = await fetchHarnessSpecByArn(
      'arn:aws:bedrock-agentcore:us-east-1:111122223333:harness/h-123',
      'us-east-1'
    );

    expect('networkMode' in spec).toBe(false);
    expect(mockResolveVpcId).not.toHaveBeenCalled();
  });
});
