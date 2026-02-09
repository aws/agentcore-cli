import { computeDefaultCredentialEnvVarName } from '../create-identity';
import { describe, expect, it } from 'vitest';

describe('computeDefaultCredentialEnvVarName', () => {
  it('generates correct env var name for project and provider', () => {
    expect(computeDefaultCredentialEnvVarName('MyProjectOpenAI')).toBe('AGENTCORE_CREDENTIAL_MYPROJECTOPENAI');
    expect(computeDefaultCredentialEnvVarName('TestAppAnthropic')).toBe('AGENTCORE_CREDENTIAL_TESTAPPANTHROPIC');
    expect(computeDefaultCredentialEnvVarName('ChatBotGemini')).toBe('AGENTCORE_CREDENTIAL_CHATBOTGEMINI');
  });

  it('converts to uppercase', () => {
    expect(computeDefaultCredentialEnvVarName('lowercase')).toBe('AGENTCORE_CREDENTIAL_LOWERCASE');
    expect(computeDefaultCredentialEnvVarName('MixedCase')).toBe('AGENTCORE_CREDENTIAL_MIXEDCASE');
  });

  it('handles empty string', () => {
    expect(computeDefaultCredentialEnvVarName('')).toBe('AGENTCORE_CREDENTIAL_');
  });
});
