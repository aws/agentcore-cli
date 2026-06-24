import type { AgentCoreProjectSpec, Credential, DeployedResourceState, HarnessSpec } from '../../../schema';
import type {
  AgentRenderConfig,
  GatewayProviderRenderConfig,
  IdentityProviderRenderConfig,
  MemoryProviderRenderConfig,
} from '../../templates/types';

// ============================================================================
// CLI options
// ============================================================================

export interface ExportHarnessOptions {
  name?: string;
  /** ARN of a harness created outside this project — fetched from the service. Mutually exclusive with name. */
  arn?: string;
  targetAgentName?: string;
  build?: string;
  json?: boolean;
}

// ============================================================================
// Resolved context (all on-disk reads done before mapping)
// ============================================================================

export interface ResolvedHarnessContext {
  harnessName: string;
  targetAgentName: string;
  spec: HarnessSpec;
  systemPrompt: string;
  projectSpec: AgentCoreProjectSpec;
  /** First target's resources from deployed-state.json, or null when file absent */
  deployedResources: DeployedResourceState | null;
  configBaseDir: string;
  projectRoot: string;
  exportNotes: ExportNote[];
  /** AWS region from the first deployment target, or undefined if not configured */
  region?: string;
  /**
   * Static, non-secret discovery values (e.g. external gateway URL, browser/code-interpreter id)
   * to write into the exported project's .env.local for local dev. At deploy the CDK connection
   * wiring injects the same env vars; this makes `agentcore dev` resolve them without a deploy.
   */
  localEnvVars: Record<string, string>;
  /**
   * Generated IAM policy documents to write into the agent's codeLocation, keyed by filename.
   * Referenced from AgentEnvSpec.additionalPolicies for opaque AWS access (e.g. S3 skills) the CLI
   * does not model as a typed connection. Written by the export action alongside the agent code.
   */
  generatedPolicyFiles: Record<string, unknown>;
  /** Filenames (relative to codeLocation) + managed-policy ARNs for AgentEnvSpec.additionalPolicies. */
  additionalPolicies: string[];
}

// ============================================================================
// Export notes (collected during mapping, written to EXPORT_NOTES.md)
// ============================================================================

export interface ExportNote {
  category: string;
  message: string;
}

// ============================================================================
// Mapping output
// ============================================================================

export interface HarnessMappingResult {
  renderConfig: AgentRenderConfig;
  agentEnvSpec: import('../../../schema').AgentEnvSpec;
  /** Model identity credential, if any */
  credentialEntry: Credential | null;
  /** One credential entry per MCP header that carries a secret value */
  mcpCredentialEntries: { credential: Credential; envVarName: string; value: string }[];
  /** API-key credential references for private git-skill auth (name-only; the provider already
   *  exists in AgentCore Identity). Persisted so the deployed agent is granted GetResourceApiKey. */
  gitCredentialEntries: Credential[];
}

// ============================================================================
// Resolved sub-objects (internal to mapper)
// ============================================================================

export interface ResolvedGatewayProvider extends GatewayProviderRenderConfig {
  /** True when the gateway was found in this project's deployed state */
  isSameProject: boolean;
  /** Hardcoded URL used when gateway is external (not in deployed state) */
  hardcodedUrl?: string;
}

export interface ResolvedMemoryProvider extends MemoryProviderRenderConfig {
  isSameProject: boolean;
}

export interface ResolvedIdentityProvider extends IdentityProviderRenderConfig {
  credentialEntry: Credential | null;
}
