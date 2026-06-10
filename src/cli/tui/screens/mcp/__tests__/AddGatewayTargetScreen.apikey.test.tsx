import { AddGatewayTargetScreen } from '../AddGatewayTargetScreen';
import type { AddGatewayTargetConfig, GatewayTargetWizardState, McpServerTargetConfig } from '../types';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

const tick = () => new Promise(r => setTimeout(r, 20));

const DOWN_ARROW = '\x1B[B';
const ENTER = '\r';
const SPACE = ' ';

const baseConfig: GatewayTargetWizardState = {
  name: 'secure-tools',
  targetType: 'mcpServer',
  endpoint: 'https://example.com/mcp',
  gateway: 'my-gateway',
  toolDefinition: { name: 'secure-tools', description: 'Tool', inputSchema: { type: 'object' } },
};

function renderScreen(onComplete: (config: AddGatewayTargetConfig) => void) {
  return render(
    <AddGatewayTargetScreen
      existingGateways={['my-gateway']}
      existingToolNames={[]}
      existingOAuthCredentialNames={[]}
      existingApiKeyCredentialNames={['my-api-key']}
      onComplete={onComplete}
      onCreateCredential={vi.fn()}
      onExit={vi.fn()}
      initialConfig={baseConfig}
      initialStep="outbound-auth"
    />
  );
}

describe('AddGatewayTargetScreen — API key placement', () => {
  it('routes API_KEY credential selection through the placement sub-form before completing', async () => {
    const onComplete = vi.fn<(config: AddGatewayTargetConfig) => void>();
    const { stdin, lastFrame } = renderScreen(onComplete);

    await tick();
    // Auth type options: OAuth, API Key, No authorization. Move to API Key and select it.
    stdin.write(DOWN_ARROW); // OAuth → API Key
    await tick();
    stdin.write(ENTER); // select API Key auth type
    await tick();
    // Credential picker: select the existing api-key credential (first item).
    stdin.write(ENTER);
    await tick();

    // Placement sub-form should now be mounted, not yet completed.
    expect(lastFrame()).toContain('API key placement');
    expect(onComplete).not.toHaveBeenCalled();

    // Skip placement (keep defaults) — Enter with no checklist selection.
    stdin.write(ENTER);
    await tick();

    // Now on the confirm step — confirm to finalize.
    stdin.write(ENTER);
    await tick();

    expect(onComplete).toHaveBeenCalledTimes(1);
    const config = onComplete.mock.calls[0]![0];
    expect(config.targetType).toBe('mcpServer');
    expect((config as McpServerTargetConfig).outboundAuth).toEqual({
      type: 'API_KEY',
      credentialName: 'my-api-key',
    });
  });

  it('threads a custom placement onto the completed config', async () => {
    const onComplete = vi.fn<(config: AddGatewayTargetConfig) => void>();
    const { stdin } = renderScreen(onComplete);

    await tick();
    stdin.write(DOWN_ARROW); // OAuth → API Key
    await tick();
    stdin.write(ENTER); // select API Key auth type
    await tick();
    stdin.write(ENTER); // select credential
    await tick();

    // Placement checklist order: location, parameterName, prefix. Toggle "prefix".
    stdin.write(DOWN_ARROW); // → parameterName
    await tick();
    stdin.write(DOWN_ARROW); // → prefix
    await tick();
    stdin.write(SPACE); // toggle prefix
    await tick();
    stdin.write(ENTER); // continue → prefix sub-step
    await tick();
    stdin.write('Bearer');
    await tick();
    stdin.write(ENTER); // submit prefix
    await tick();

    // Now on the confirm step — confirm to finalize.
    stdin.write(ENTER);
    await tick();

    expect(onComplete).toHaveBeenCalledTimes(1);
    const config = onComplete.mock.calls[0]![0];
    expect(config.targetType).toBe('mcpServer');
    expect((config as McpServerTargetConfig).outboundAuth).toEqual({
      type: 'API_KEY',
      credentialName: 'my-api-key',
      apiKey: { prefix: 'Bearer' },
    });
  });
});
