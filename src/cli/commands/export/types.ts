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
