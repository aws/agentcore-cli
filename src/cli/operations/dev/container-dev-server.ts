import { CONTAINER_INTERNAL_PORT, DOCKERFILE_NAME } from '../../../lib';
import { getUvBuildArgs } from '../../../lib/packaging/build-args';
import { detectContainerRuntime, getStartHint } from '../../external-requirements/detect';
import { DevServer, type LogLevel, type SpawnConfig } from './dev-server';
import { type ChildProcess, spawn, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/** Dev server for Container agents. Builds and runs a Docker container using the user's Dockerfile. */
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

  /** Override start to log when the container is launched and trigger TUI readiness detection.
   *  DevLogger filters 'info', so without a 'system'-level message the log would be empty after build.
   *  Include "Application startup complete" so the TUI detects container readiness. */
  override async start(): Promise<ChildProcess | null> {
    const child = await super.start();
    if (child) {
      const { onLog } = this.options.callbacks;
      onLog('system', `Container ${this.containerName} started on port ${this.options.port}.`);
      // Trigger TUI readiness detection (useDevServer looks for this exact string)
      onLog('info', 'Application startup complete');
    }
    return child;
  }

  /** Override kill to stop the container properly, cleaning up the port proxy.
   *  Uses async spawn so the UI can render "Stopping..." while container stops. */
  override kill(): void {
    if (this.runtimeBinary) {
      // Fire-and-forget: stop container asynchronously so UI remains responsive
      spawn(this.runtimeBinary, ['stop', this.containerName], { stdio: 'ignore' });
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

    // 4. Build the container image, streaming output in real-time
    onLog('system', `Building container image: ${this.imageName}...`);
    const exitCode = await this.streamBuild(
      ['-t', this.imageName, '-f', dockerfilePath, ...getUvBuildArgs(), this.config.directory],
      onLog
    );

    if (exitCode !== 0) {
      onLog('error', `Container build failed (exit code ${exitCode})`);
      return false;
    }

    onLog('system', 'Container image built successfully.');
    return true;
  }

  /** Run a container build and stream stdout/stderr lines to onLog in real-time. */
  private streamBuild(args: string[], onLog: (level: LogLevel, message: string) => void): Promise<number | null> {
    return new Promise(resolve => {
      const child = spawn(this.runtimeBinary, ['build', ...args], { stdio: 'pipe' });

      const streamLines = (stream: NodeJS.ReadableStream) => {
        let buffer = '';
        stream.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop()!;
          for (const line of lines) {
            if (line.trim()) onLog('system', line);
          }
        });
        stream.on('end', () => {
          if (buffer.trim()) onLog('system', buffer);
        });
      };

      if (child.stdout) streamLines(child.stdout);
      if (child.stderr) streamLines(child.stderr);

      child.on('error', err => {
        onLog('error', `Build process error: ${err.message}`);
        resolve(1);
      });
      child.on('close', code => resolve(code));
    });
  }

  protected getSpawnConfig(): SpawnConfig {
    const { port, envVars = {} } = this.options;

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

    // Mount ~/.aws to a neutral path accessible by any container user, and set
    // AWS SDK env vars to point to it. This supports SSO, profiles, and credential files
    // regardless of what USER the Dockerfile specifies.
    const awsDir = join(homedir(), '.aws');
    const awsContainerPath = '/aws-config';
    const awsMountArgs = existsSync(awsDir) ? ['-v', `${awsDir}:${awsContainerPath}:ro`] : [];
    const awsConfigEnv = existsSync(awsDir)
      ? {
          AWS_CONFIG_FILE: `${awsContainerPath}/config`,
          AWS_SHARED_CREDENTIALS_FILE: `${awsContainerPath}/credentials`,
        }
      : {};

    // Environment variables: AWS creds + config paths + user env + container-specific overrides.
    // Disable OpenTelemetry SDK — no collector is running locally, and the OTEL
    // exporter connection errors would crash or pollute the dev server output.
    const envArgs = Object.entries({
      ...awsEnvVars,
      ...awsConfigEnv,
      ...envVars,
      LOCAL_DEV: '1',
      PORT: String(CONTAINER_INTERNAL_PORT),
      OTEL_SDK_DISABLED: 'true',
    }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

    return {
      cmd: this.runtimeBinary,
      args: [
        'run',
        '--rm',
        '--name',
        this.containerName,
        ...awsMountArgs,
        '-p',
        `${port}:${CONTAINER_INTERNAL_PORT}`,
        ...envArgs,
        this.imageName,
      ],
      env: { ...process.env },
    };
  }
}
