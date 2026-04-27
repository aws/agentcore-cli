import { InvokeLogger } from '../invoke-logger.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../lib')>();
  return {
    ...actual,
    findConfigRoot: () => tempDir,
  };
});

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'invoke-logger-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function readLog(logger: InvokeLogger): string {
  return readFileSync(logger.logFilePath, 'utf-8');
}

describe('InvokeLogger session ID', () => {
  it('writes session ID in header when provided via constructor', () => {
    const logger = new InvokeLogger({
      agentName: 'testAgent',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456:runtime/test',
      region: 'us-east-1',
      sessionId: 'my-session-123',
    });

    const content = readLog(logger);
    expect(content).toContain('Session ID: my-session-123');
    expect(content).not.toContain('Session ID: none');
  });

  it('writes "none" when session ID is not provided', () => {
    const logger = new InvokeLogger({
      agentName: 'testAgent',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456:runtime/test',
      region: 'us-east-1',
    });

    const content = readLog(logger);
    expect(content).toContain('Session ID: none');
  });

  it('includes session ID in logPrompt output when passed as argument', () => {
    const logger = new InvokeLogger({
      agentName: 'testAgent',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456:runtime/test',
      region: 'us-east-1',
      sessionId: 'my-session-456',
    });

    logger.logPrompt('hello world', 'my-session-456', 'user-1');

    const content = readLog(logger);
    expect(content).toContain('Session: my-session-456');
    expect(content).toContain('"sessionId": "my-session-456"');
  });

  it('logPrompt falls back to constructor sessionId when argument is undefined', () => {
    const logger = new InvokeLogger({
      agentName: 'testAgent',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456:runtime/test',
      region: 'us-east-1',
      sessionId: 'constructor-session',
    });

    logger.logPrompt('hello world', undefined, 'user-1');

    const content = readLog(logger);
    expect(content).toContain('Session: constructor-session');
    expect(content).toContain('"sessionId": "constructor-session"');
  });

  it('logPrompt shows "none" when no session ID anywhere', () => {
    const logger = new InvokeLogger({
      agentName: 'testAgent',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456:runtime/test',
      region: 'us-east-1',
    });

    logger.logPrompt('hello world');

    const content = readLog(logger);
    expect(content).toContain('Session: none');
  });
});
