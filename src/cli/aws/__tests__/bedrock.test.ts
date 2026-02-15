import { invokeBedrockSync, invokeClaude } from '../bedrock.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class {
    send = mockSend;
  },
  InvokeModelCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('../account', () => ({
  getCredentialProvider: vi.fn().mockReturnValue({}),
}));

describe('invokeBedrockSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns parsed JSON response', async () => {
    const responseBody = { result: 'hello' };
    mockSend.mockResolvedValue({
      body: new TextEncoder().encode(JSON.stringify(responseBody)),
    });

    const result = await invokeBedrockSync({
      region: 'us-east-1',
      modelId: 'test-model',
      body: { prompt: 'test' },
    });

    expect(result).toEqual(responseBody);
  });

  it('sends correct model and content type', async () => {
    mockSend.mockResolvedValue({
      body: new TextEncoder().encode('{}'),
    });

    await invokeBedrockSync({
      region: 'us-west-2',
      modelId: 'my-model',
      body: { key: 'value' },
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0]![0];
    expect(command.input.modelId).toBe('my-model');
    expect(command.input.contentType).toBe('application/json');
    expect(command.input.accept).toBe('application/json');
  });
});

describe('invokeClaude', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns content text from response', async () => {
    mockSend.mockResolvedValue({
      body: new TextEncoder().encode(
        JSON.stringify({
          content: [{ type: 'text', text: 'Hello from Claude' }],
        })
      ),
    });

    const result = await invokeClaude({ region: 'us-east-1', prompt: 'hi' });
    expect(result.content).toBe('Hello from Claude');
  });

  it('throws when no content returned', async () => {
    mockSend.mockResolvedValue({
      body: new TextEncoder().encode(JSON.stringify({ content: [] })),
    });

    await expect(invokeClaude({ region: 'us-east-1', prompt: 'hi' })).rejects.toThrow(
      'No content returned from Bedrock'
    );
  });

  it('uses default maxTokens when not provided', async () => {
    mockSend.mockResolvedValue({
      body: new TextEncoder().encode(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] })),
    });

    await invokeClaude({ region: 'us-east-1', prompt: 'test' });

    const command = mockSend.mock.calls[0]![0];
    const body = JSON.parse(command.input.body);
    expect(body.max_tokens).toBe(8192);
  });

  it('uses custom maxTokens when provided', async () => {
    mockSend.mockResolvedValue({
      body: new TextEncoder().encode(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] })),
    });

    await invokeClaude({ region: 'us-east-1', prompt: 'test', maxTokens: 1024 });

    const command = mockSend.mock.calls[0]![0];
    const body = JSON.parse(command.input.body);
    expect(body.max_tokens).toBe(1024);
  });
});
