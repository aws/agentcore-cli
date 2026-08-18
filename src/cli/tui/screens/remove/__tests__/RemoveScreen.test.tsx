import { RemoveScreen } from '../RemoveScreen.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

describe('RemoveScreen', () => {
  it('gateway and gateway-target options enabled when counts > 0', () => {
    const onSelect = vi.fn();
    const onExit = vi.fn();

    const { lastFrame } = render(
      <RemoveScreen
        onSelect={onSelect}
        onExit={onExit}
        agentCount={1}
        harnessCount={0}
        gatewayCount={1}
        mcpToolCount={1}
        memoryCount={1}
        credentialCount={1}
        evaluatorCount={1}
        onlineEvalCount={1}
        policyEngineCount={1}
        policyCount={1}
        configBundleCount={1}
        runtimeEndpointCount={1}
        datasetCount={0}
        knowledgeBaseCount={0}
        paymentCount={1}
        capacityProviderCount={0}
      />
    );

    expect(lastFrame()).toContain('Gateway');
    expect(lastFrame()).toContain('Gateway Target');
    expect(lastFrame()).not.toContain('No gateways to remove');
    expect(lastFrame()).not.toContain('No gateway targets to remove');
    expect(lastFrame()).toContain('Policy Engine');
    expect(lastFrame()).toContain('Policy');
    expect(lastFrame()).not.toContain('No policy engines to remove');
    expect(lastFrame()).not.toContain('No policies to remove');
  });

  it('gateway and gateway-target options disabled when counts = 0', () => {
    const onSelect = vi.fn();
    const onExit = vi.fn();

    const { lastFrame } = render(
      <RemoveScreen
        onSelect={onSelect}
        onExit={onExit}
        agentCount={0}
        harnessCount={0}
        gatewayCount={0}
        mcpToolCount={0}
        memoryCount={0}
        credentialCount={0}
        evaluatorCount={0}
        onlineEvalCount={0}
        policyEngineCount={0}
        policyCount={0}
        configBundleCount={0}
        runtimeEndpointCount={0}
        datasetCount={0}
        knowledgeBaseCount={0}
        paymentCount={0}
        capacityProviderCount={0}
      />
    );

    expect(lastFrame()).toContain('No gateways to remove');
    expect(lastFrame()).toContain('No gateway targets to remove');
    expect(lastFrame()).toContain('No policy engines to remove');
    expect(lastFrame()).toContain('No policies to remove');
  });

  it('Knowledge Base option enabled when knowledgeBaseCount > 0', () => {
    const onSelect = vi.fn();
    const onExit = vi.fn();

    const { lastFrame } = render(
      <RemoveScreen
        onSelect={onSelect}
        onExit={onExit}
        agentCount={0}
        harnessCount={0}
        gatewayCount={0}
        mcpToolCount={0}
        memoryCount={0}
        credentialCount={0}
        evaluatorCount={0}
        onlineEvalCount={0}
        policyEngineCount={0}
        policyCount={0}
        configBundleCount={0}
        runtimeEndpointCount={0}
        datasetCount={0}
        knowledgeBaseCount={3}
        paymentCount={0}
        capacityProviderCount={0}
      />
    );

    expect(lastFrame()).toContain('Knowledge Base');
    expect(lastFrame()).not.toContain('No knowledge bases to remove');
  });

  it('Knowledge Base option disabled when knowledgeBaseCount = 0', () => {
    const onSelect = vi.fn();
    const onExit = vi.fn();

    const { lastFrame } = render(
      <RemoveScreen
        onSelect={onSelect}
        onExit={onExit}
        agentCount={0}
        harnessCount={0}
        gatewayCount={0}
        mcpToolCount={0}
        memoryCount={0}
        credentialCount={0}
        evaluatorCount={0}
        onlineEvalCount={0}
        policyEngineCount={0}
        policyCount={0}
        configBundleCount={0}
        runtimeEndpointCount={0}
        datasetCount={0}
        knowledgeBaseCount={0}
        paymentCount={0}
        capacityProviderCount={0}
      />
    );

    expect(lastFrame()).toContain('No knowledge bases to remove');
  });

  it('Capacity Provider option enabled when capacityProviderCount > 0', () => {
    const { lastFrame } = render(
      <RemoveScreen
        onSelect={vi.fn()}
        onExit={vi.fn()}
        agentCount={0}
        harnessCount={0}
        gatewayCount={0}
        mcpToolCount={0}
        memoryCount={0}
        credentialCount={0}
        evaluatorCount={0}
        onlineEvalCount={0}
        policyEngineCount={0}
        policyCount={0}
        configBundleCount={0}
        runtimeEndpointCount={0}
        datasetCount={0}
        knowledgeBaseCount={0}
        paymentCount={0}
        capacityProviderCount={2}
      />
    );

    expect(lastFrame()).toContain('Capacity Provider');
    expect(lastFrame()).not.toContain('No capacity providers to remove');
  });

  it('Capacity Provider option disabled when capacityProviderCount = 0', () => {
    const { lastFrame } = render(
      <RemoveScreen
        onSelect={vi.fn()}
        onExit={vi.fn()}
        agentCount={0}
        harnessCount={0}
        gatewayCount={0}
        mcpToolCount={0}
        memoryCount={0}
        credentialCount={0}
        evaluatorCount={0}
        onlineEvalCount={0}
        policyEngineCount={0}
        policyCount={0}
        configBundleCount={0}
        runtimeEndpointCount={0}
        datasetCount={0}
        knowledgeBaseCount={0}
        paymentCount={0}
        capacityProviderCount={0}
      />
    );

    expect(lastFrame()).toContain('No capacity providers to remove');
  });
});
