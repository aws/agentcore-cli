import type { AgentEnvSpec, RuntimeVersion } from '../../../schema';

export interface PackageOptions {
  /** Optional override for project root; defaults to cwd or discovered root. */
  projectRoot?: string;
  /** Optional override for source directory; defaults to <projectRoot>/src. */
  srcDir?: string;
  /** Optional override for pyproject path; defaults to <projectRoot>/pyproject.toml (Python) or package.json (Node). */
  pyprojectPath?: string;
  /** Optional override for artifact base directory; defaults to <projectRoot>/.agentcore. */
  artifactDir?: string;
  /** Optional override for python platform tag; defaults to aarch64-manylinux2014. Only used for Python. */
  pythonPlatform?: string;
  /** Agent name for artifact naming and staging isolation. */
  agentName?: string;
  /** Output path for the zip artifact. If provided, writes directly here. */
  outputPath?: string;
}

export interface ArtifactResult {
  artifactPath: string;
  sizeBytes: number;
  stagingPath: string;
}

/**
 * Common interface for code bundling.
 * Both AgentEnvSpec and runtime configs satisfy this interface.
 */
export interface CodeBundleConfig {
  name: string;
  codeLocation: string;
  entrypoint: string;
  runtimeVersion?: RuntimeVersion;
}

/**
 * Async packager interface for CLI usage.
 */
export interface RuntimePackager {
  /**
   * Package code for a runtime asynchronously.
   * @param spec The agent environment spec
   * @param options Packaging options
   * @returns Promise of ArtifactResult with the path to the created zip
   */
  pack(spec: AgentEnvSpec, options?: PackageOptions): Promise<ArtifactResult>;
}

/**
 * Sync packager interface for CDK bundling constructs.
 */
export interface CodeZipPackager {
  /**
   * Package code for a CodeZip runtime synchronously.
   * @param config The code bundle configuration (AgentEnvSpec or compatible)
   * @param options Packaging options
   * @returns ArtifactResult with the path to the created zip
   */
  packCodeZip(config: CodeBundleConfig | AgentEnvSpec, options?: PackageOptions): ArtifactResult;
}
