import { dnsSuffix } from './partition';

/**
 * Resolve the data-plane HTTPS endpoint for AgentCore runtime services.
 * Set AGENTCORE_STAGE=beta|gamma to target pre-release environments.
 *
 * Data-plane service: bedrock-agentcore (elcapdp subdomain in pre-release)
 */
export function dataPlaneEndpoint(region: string): string {
  const stage = process.env.AGENTCORE_STAGE?.toLowerCase();
  if (stage === 'beta') return `https://beta.${region}.elcapdp.genesis-primitives.aws.dev`;
  if (stage === 'gamma') return `https://gamma.${region}.elcapdp.genesis-primitives.aws.dev`;
  return `https://bedrock-agentcore.${region}.${dnsSuffix(region)}`;
}

/**
 * Resolve the control-plane HTTPS endpoint for AgentCore management services.
 * Set AGENTCORE_STAGE=beta|gamma to target pre-release environments.
 *
 * Control-plane service: bedrock-agentcore-control (elcapcp subdomain in pre-release)
 */
export function controlPlaneEndpoint(region: string): string {
  const stage = process.env.AGENTCORE_STAGE?.toLowerCase();
  if (stage === 'beta') return `https://beta.${region}.elcapcp.genesis-primitives.aws.dev`;
  if (stage === 'gamma') return `https://gamma.${region}.elcapcp.genesis-primitives.aws.dev`;
  return `https://bedrock-agentcore-control.${region}.${dnsSuffix(region)}`;
}
