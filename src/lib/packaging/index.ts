import type { AgentCoreProjectSpec, AgentEnvSpec, RuntimeVersion } from '../../schema';
import { ContainerPackager } from './container';
import { PackagingError } from './errors';
import { isNodeRuntime, isPythonRuntime } from './helpers';
import { NodeCodeZipPackager, NodeCodeZipPackagerSync } from './node';
import { PythonCodeZipPackager, PythonCodeZipPackagerSync } from './python';
import type {
  ArtifactResult,
  CodeBundleConfig,
  CodeZipPackager,
  PackageOptions,
  RuntimePackager,
} from './types/packaging';

/**
 * Validate that an agent exists in the config
 * @param project AgentCore project configuration
 * @param agentName Name of agent to validate
 * @throws PackagingError if agent not found
 */
export function validateAgentExists(project: AgentCoreProjectSpec, agentName: string): void {
  const agent = project.agents.find((a: AgentEnvSpec) => a.name === agentName);
  if (!agent) {
    const available = project.agents.map((a: AgentEnvSpec) => a.name).join(', ');
    throw new PackagingError(`Agent '${agentName}' not found. Available agents: ${available}`);
  }
}

/**
 * Get the async runtime packager for CLI usage based on runtime version.
 * Supports both Python and Node/TypeScript runtimes.
 */
export function getRuntimePackager(runtimeVersion: RuntimeVersion): RuntimePackager {
  if (isPythonRuntime(runtimeVersion)) {
    return new PythonCodeZipPackager();
  }
  if (isNodeRuntime(runtimeVersion)) {
    return new NodeCodeZipPackager();
  }
  throw new PackagingError(`Unsupported runtime version: ${runtimeVersion}`);
}

/**
 * Get the sync CodeZip packager for CDK bundling based on runtime version.
 * Supports both Python and Node/TypeScript runtimes.
 */
export function getCodeZipPackager(runtimeVersion: RuntimeVersion): CodeZipPackager {
  if (isPythonRuntime(runtimeVersion)) {
    return new PythonCodeZipPackagerSync();
  }
  if (isNodeRuntime(runtimeVersion)) {
    return new NodeCodeZipPackagerSync();
  }
  throw new PackagingError(`Unsupported runtime version: ${runtimeVersion}`);
}

/**
 * Get the async runtime packager for Container agents.
 */
export function getContainerPackager(): RuntimePackager {
  return new ContainerPackager();
}

/**
 * Package a runtime asynchronously.
 * This is the primary API for CLI usage.
 * Automatically selects the appropriate packager based on build type and runtime version.
 */
export async function packRuntime(spec: AgentEnvSpec, options?: PackageOptions): Promise<ArtifactResult> {
  const packager = spec.build === 'Container' ? getContainerPackager() : getRuntimePackager(spec.runtimeVersion);
  return packager.pack(spec, options);
}

/**
 * Package a code bundle synchronously.
 * This is the primary API for CDK bundling.
 * Works with AgentEnvSpec or any object with name, codeLocation, and entrypoint.
 * Defaults to Python if no runtimeVersion is specified.
 */
export function packCodeZipSync(config: CodeBundleConfig | AgentEnvSpec, options?: PackageOptions): ArtifactResult {
  const runtimeVersion = config.runtimeVersion ?? 'PYTHON_3_12';
  const packager = getCodeZipPackager(runtimeVersion);
  return packager.packCodeZip(config as AgentEnvSpec, options);
}

export type {
  ArtifactResult,
  CodeBundleConfig,
  CodeZipPackager,
  PackageOptions,
  RuntimePackager,
} from './types/packaging';
export * from './errors';
export { resolveCodeLocation } from './helpers';
