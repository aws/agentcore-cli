import { getProtocolOptionsForLanguage, getSDKOptionsForProtocol } from '../types.js';
import { describe, expect, it } from 'vitest';

describe('getSDKOptionsForProtocol', () => {
  it('excludes Vercel AI for Python HTTP agents (Vercel is TypeScript-only)', () => {
    const ids = getSDKOptionsForProtocol('HTTP', 'Python').map(o => o.id);
    expect(ids).toContain('Strands');
    expect(ids).toContain('LangChain_LangGraph');
    expect(ids).not.toContain('VercelAI');
  });

  it('includes Vercel AI for TypeScript HTTP agents', () => {
    const ids = getSDKOptionsForProtocol('HTTP', 'TypeScript').map(o => o.id);
    expect(ids).toContain('Strands');
    expect(ids).toContain('VercelAI');
  });

  it('restricts TypeScript to Strands and Vercel AI only', () => {
    const ids = getSDKOptionsForProtocol('HTTP', 'TypeScript').map(o => o.id);
    expect(ids).not.toContain('LangChain_LangGraph');
    expect(ids).not.toContain('GoogleADK');
    expect(ids).not.toContain('OpenAIAgents');
  });

  it('intersects protocol and language support (A2A + Python excludes OpenAIAgents and Vercel)', () => {
    const ids = getSDKOptionsForProtocol('A2A', 'Python').map(o => o.id);
    expect(ids).toContain('Strands');
    expect(ids).not.toContain('OpenAIAgents');
    expect(ids).not.toContain('VercelAI');
  });
});

describe('getProtocolOptionsForLanguage', () => {
  it('restricts TypeScript to HTTP only', () => {
    const ids = getProtocolOptionsForLanguage('TypeScript').map(o => o.id);
    expect(ids).toEqual(['HTTP']);
  });

  it('offers all protocols for Python', () => {
    const ids = getProtocolOptionsForLanguage('Python').map(o => o.id);
    expect(ids).toContain('HTTP');
    expect(ids).toContain('MCP');
    expect(ids).toContain('A2A');
  });
});
