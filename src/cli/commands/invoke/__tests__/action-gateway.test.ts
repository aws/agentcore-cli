import type { InvokeContext } from '../action';
import { handleInvoke } from '../action';
import type { InvokeOptions } from '../types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Gateway invoke output parsing.
//
// HTTP gateways stream back the same SSE envelope as a direct runtime invoke.
// Before this fix the gateway branch returned the raw HTTP body, so users saw
// `data: "..."` frames instead of clean text. This pins the wiring: the HTTP
// gateway response is run through parseSSE (mirroring invokeAgentRuntime). The
// parsing itself is covered by agentcore.test.ts — this guards that the gateway
// branch actually calls it rather than returning the body raw.
// ---------------------------------------------------------------------------

vi.mock('../../../logging', () => ({
  InvokeLogger: class {
    logFilePath = '/tmp/fake.log';
    logPrompt = vi.fn();
    logResponse = vi.fn();
    logError = vi.fn();
    logInfo = vi.fn();
  },
}));

function makeContext(): InvokeContext {
  const gatewayName = 'lolo-gateway';
  return {
    project: {
      agentCoreGateways: [
        {
          name: gatewayName,
          authorizerType: 'AWS_IAM',
          targets: [{ name: 'lolo-target', targetType: 'httpRuntime' }],
        },
      ],
      runtimes: [],
    } as unknown as InvokeContext['project'],
    deployedState: {
      targets: {
        default: {
          resources: {
            gateways: {
              [gatewayName]: {
                gatewayId: 'gw-123',
                gatewayUrl: 'https://gw-123.gateway.example.com',
                gatewayArn: 'arn:aws:bedrock-agentcore:us-east-1:111122223333:gateway/gw-123',
              },
            },
          },
        },
      },
    } as unknown as InvokeContext['deployedState'],
    awsTargets: [{ name: 'default', region: 'us-east-1' }] as unknown as InvokeContext['awsTargets'],
  };
}

describe('handleInvoke — gateway output parsing', () => {
  beforeEach(() => {
    // SigV4 signing pulls credentials from the provider chain; give it something.
    process.env.AWS_ACCESS_KEY_ID = 'AKIAFAKE';
    process.env.AWS_SECRET_ACCESS_KEY = 'fakesecret';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  });

  it('parses multi-frame SSE into clean joined text (the lolo-gateway repro)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('data: "Hello! How can I help you today"\n\ndata: "?"\n\n'),
      })
    );

    const options: InvokeOptions = {
      gateway: 'lolo-gateway',
      gatewayTarget: 'lolo-target',
      targetName: 'default',
      prompt: '{"message":"hello"}',
    };
    const result = await handleInvoke(makeContext(), options);

    expect(result.success).toBe(true);
    expect(result.response).toBe('Hello! How can I help you today?');
  });
});
