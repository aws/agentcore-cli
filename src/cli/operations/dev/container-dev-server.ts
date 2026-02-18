import { CONTAINER_INTERNAL_PORT, DOCKERFILE_NAME } from '../../../lib';
import { detectContainerRuntime, getStartHint } from '../../external-requirements/detect';
import { DevServer, type LogLevel, type SpawnConfig } from './dev-server';
import { convertEntrypointToModule } from './utils';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/** Dev server for Container agents. Builds and runs a Docker container with volume mount for hot-reload. */
export class ContainerDevServer extends DevServer {
  private runtimeBinary = '';

  /** Docker image names must be lowercase. */
  private get imageName(): string {
    return `agentcore-dev-${this.config.agentName}`.toLowerCase();
  }

  /** Container name for lifecycle management. */
  private get containerName(): string {
    return this.imageName;
  }

  /** Override kill to stop the container properly, cleaning up the port proxy. */
  override kill(): void {
    if (this.runtimeBinary) {
      spawnSync(this.runtimeBinary, ['stop', this.containerName], { stdio: 'ignore' });
    }
    super.kill();
  }

  protected async prepare(): Promise<boolean> {
    const { onLog } = this.options.callbacks;

    // 1. Detect container runtime
    const { runtime, notReadyRuntimes } = await detectContainerRuntime();
    if (!runtime) {
      if (notReadyRuntimes.length > 0) {
        onLog(
          'error',
          `Found ${notReadyRuntimes.join(', ')} but not ready. Start a runtime:\n${getStartHint(notReadyRuntimes)}`
        );
      } else {
        onLog('error', 'No container runtime found. Install Docker, Podman, or Finch.');
      }
      return false;
    }
    this.runtimeBinary = runtime.binary;

    // 2. Verify Dockerfile exists
    const dockerfilePath = join(this.config.directory, DOCKERFILE_NAME);
    if (!existsSync(dockerfilePath)) {
      onLog('error', `Dockerfile not found at ${dockerfilePath}. Container agents require a Dockerfile.`);
      return false;
    }

    // 3. Remove any stale container from a previous run (prevents "proxy already running" errors)
    spawnSync(this.runtimeBinary, ['rm', '-f', this.containerName], { stdio: 'ignore' });

    // 4. Build the base container image
    const baseImageName = `${this.imageName}-base`;
    onLog('system', `Building container image: ${this.imageName}...`);
    const buildResult = spawnSync(
      this.runtimeBinary,
      ['build', '-t', baseImageName, '-f', dockerfilePath, this.config.directory],
      { stdio: 'pipe' }
    );

    // Log build output for debugging
    this.logBuildOutput(buildResult.stdout, buildResult.stderr, onLog);

    if (buildResult.status !== 0) {
      onLog('error', `Container build failed (exit code ${buildResult.status})`);
      return false;
    }

    // 5. Build dev layer on top with uvicorn for hot-reload support.
    //    The user's pyproject.toml may not include uvicorn, but dev mode needs it.
    onLog('system', 'Preparing dev environment...');
    const devDockerfile = [
      `FROM ${baseImageName}`,
      'USER root',
      'RUN uv pip install uvicorn',
      'USER bedrock_agentcore',
    ].join('\n');

    const devBuild = spawnSync(this.runtimeBinary, ['build', '-t', this.imageName, '-f', '-', this.config.directory], {
      input: devDockerfile,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.logBuildOutput(devBuild.stdout, devBuild.stderr, onLog);

    if (devBuild.status !== 0) {
      onLog('error', `Dev layer build failed (exit code ${devBuild.status})`);
      return false;
    }

    onLog('system', 'Container image built successfully.');
    return true;
  }

  /** Log build stdout/stderr through the onLog callback at 'system' level so they persist to log files. */
  private logBuildOutput(
    stdout: Buffer | null,
    stderr: Buffer | null,
    onLog: (level: LogLevel, message: string) => void
  ): void {
    for (const line of (stdout?.toString() ?? '').split('\n')) {
      if (line.trim()) onLog('system', line);
    }
    for (const line of (stderr?.toString() ?? '').split('\n')) {
      if (line.trim()) onLog('system', line);
    }
  }

  protected getSpawnConfig(): SpawnConfig {
    const { directory, module: entrypoint } = this.config;
    const { port, envVars = {} } = this.options;

    const uvicornModule = convertEntrypointToModule(entrypoint);

    // Forward AWS credentials from host environment into the container
    const awsEnvKeys = [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_REGION',
      'AWS_DEFAULT_REGION',
      'AWS_PROFILE',
    ];
    const awsEnvVars: Record<string, string> = {};
    for (const key of awsEnvKeys) {
      if (process.env[key]) {
        awsEnvVars[key] = process.env[key]!;
      }
    }

    // Environment variables: AWS creds + user env + container-specific overrides
    const envArgs = Object.entries({
      ...awsEnvVars,
      ...envVars,
      LOCAL_DEV: '1',
      PORT: String(CONTAINER_INTERNAL_PORT),
    }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

    // Mount ~/.aws for credential file / SSO / profile support
    const awsDir = join(homedir(), '.aws');
    const awsMountArgs = existsSync(awsDir) ? ['-v', `${awsDir}:/home/bedrock_agentcore/.aws:ro`] : [];

    return {
      cmd: this.runtimeBinary,
      args: [
        'run',
        '--rm',
        '--name',
        this.containerName,
        // Override any ENTRYPOINT from the base image (e.g., uv images set ENTRYPOINT ["uv"])
        '--entrypoint',
        'python',
        '-v',
        `${directory}:/app`,
        ...awsMountArgs,
        '-p',
        `${port}:${CONTAINER_INTERNAL_PORT}`,
        ...envArgs,
        this.imageName,
        // Use python -m uvicorn instead of bare uvicorn to avoid PATH/permission issues
        '-m',
        'uvicorn',
        uvicornModule,
        '--reload',
        '--reload-dir',
        '/app',
        '--host',
        '0.0.0.0',
        '--port',
        String(CONTAINER_INTERNAL_PORT),
      ],
      env: { ...process.env },
    };
  }
}
