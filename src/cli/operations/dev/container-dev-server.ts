import { CONTAINER_INTERNAL_PORT, DOCKERFILE_NAME, getDockerfilePath } from '../../../lib';
import { getUvBuildArgs } from '../../../lib/packaging/build-args';
import { detectContainerRuntime } from '../../external-requirements/detect';
import { DevServer, type LogLevel, type SpawnConfig } from './dev-server';
import { waitForServerReady } from './utils';
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

  /** Override start to wait for the container's server to accept connections before
   *  signaling readiness. The base class spawns `docker run`, but the internal server
   *  needs time to boot. We poll the mapped port so the TUI only enables input once
   *  the container is actually ready to handle requests. */
  override async start(): Promise<ChildProcess | null> {
    const child = await super.start();
    if (child) {
      const { onLog } = this.options.callbacks;
      onLog('system', `Container ${this.containerName} started, waiting for server to be ready...`);

      // Poll until the container's server is accepting connections (up to 60s)
      const ready = await waitForServerReady(this.options.port);
      if (ready) {
        // Trigger TUI readiness detection (useDevServer looks for this exact string)
        onLog('info', 'Application startup complete');
      } else {
        onLog('error', 'Container server did not become ready within 60 seconds.');
      }
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
    const { runtime } = await detectContainerRuntime();
    if (!runtime) {
      onLog('error', 'No container runtime found. Install Docker, Podman, or Finch.');
      return false;
    }
    this.runtimeBinary = runtime.binary;

    // 2. Verify Dockerfile exists
    const dockerfileName = this.config.dockerfile ?? DOCKERFILE_NAME;
    const dockerfilePath = getDockerfilePath(this.config.directory, this.config.dockerfile);
    if (!existsSync(dockerfilePath)) {
      onLog('error', `${dockerfileName} not found at ${dockerfilePath}. Container agents require a Dockerfile.`);
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

  /**
   * Resolve AWS credentials on the host and return them as plain env vars.
   *
   * Why: Container Dockerfiles run as `USER bedrock_agentcore` (non-root, different
   * uid from the host user). Mounted ~/.aws files have 600 permissions owned by the
   * host uid, so the container user cannot read them. Additionally, credential_process
   * tools like `ada` are not installed inside the image.
   *
   * By resolving credentials on the host (where ada/SSO/profiles work) and injecting
   * the resulting AWS_ACCESS_KEY_ID/SECRET/TOKEN as container env vars, we avoid both
   * problems. This applies to all container agents (Python and TypeScript).
   *
   * Security: acceptable for local dev — credentials are short-lived STS session
   * tokens visible only on the developer's machine (same as `docker run -e`).
   */
  private resolveHostCredentials(): Record<string, string> | null {
    const profile = process.env.AWS_PROFILE ?? 'default';
    try {
      const result = spawnSync('aws', ['configure', 'export-credentials', '--format', 'env', '--profile', profile], {
        encoding: 'utf-8',
        timeout: 10_000,
        env: { ...process.env },
      });
      if (result.status !== 0 || !result.stdout) return null;

      const creds: Record<string, string> = {};
      for (const line of result.stdout.split('\n')) {
        const match = /^export\s+(AWS_\w+)=(.+)$/.exec(line);
        if (match?.[1] && match[2]) creds[match[1]] = match[2];
      }
      return creds.AWS_ACCESS_KEY_ID ? creds : null;
    } catch {
      return null;
    }
  }

  protected getSpawnConfig(): SpawnConfig {
    const { port, envVars = {} } = this.options;

    // Forward AWS credentials from host environment into the container.
    // When explicit credentials are present, omit AWS_PROFILE so SDK credential
    // chains prefer the env var credentials over profile-based resolution (which
    // can fail when the container user cannot read the mounted ~/.aws files).
    // If no explicit creds exist, resolve them on the host via `aws configure
    // export-credentials` so containers don't need tools like ada/SSO browsers.
    let hasExplicitCreds = !!process.env.AWS_ACCESS_KEY_ID;
    if (!hasExplicitCreds) {
      const resolved = this.resolveHostCredentials();
      if (resolved) {
        for (const [k, v] of Object.entries(resolved)) {
          process.env[k] = v;
        }
        hasExplicitCreds = true;
      }
    }

    const awsEnvKeys = [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_REGION',
      'AWS_DEFAULT_REGION',
      ...(hasExplicitCreds ? [] : ['AWS_PROFILE']),
    ];
    const awsEnvVars: Record<string, string> = {};
    for (const key of awsEnvKeys) {
      if (process.env[key]) {
        awsEnvVars[key] = process.env[key]!;
      }
    }

    // Mount ~/.aws only when we couldn't resolve explicit credentials.
    // This avoids containers hitting credential_process commands (e.g. ada)
    // that aren't installed inside the image.
    const awsDir = join(homedir(), '.aws');
    const awsContainerPath = '/aws-config';
    const awsMountArgs = !hasExplicitCreds && existsSync(awsDir) ? ['-v', `${awsDir}:${awsContainerPath}:ro`] : [];
    const awsConfigEnv =
      !hasExplicitCreds && existsSync(awsDir)
        ? {
            AWS_CONFIG_FILE: `${awsContainerPath}/config`,
            AWS_SHARED_CREDENTIALS_FILE: `${awsContainerPath}/credentials`,
          }
        : {};

    // Environment variables: AWS creds + config paths + user env + container-specific overrides.
    // OTEL env vars (endpoint + protocol) are passed via envVars from the caller,
    // pointing the agent's OTEL exporter at the local collector.
    // Inside a container, 127.0.0.1 refers to the container itself — rewrite to
    // host.docker.internal so the exporter can reach the host-side collector.
    const containerEnvVars = { ...envVars };
    if (containerEnvVars.OTEL_EXPORTER_OTLP_ENDPOINT) {
      containerEnvVars.OTEL_EXPORTER_OTLP_ENDPOINT = containerEnvVars.OTEL_EXPORTER_OTLP_ENDPOINT.replace(
        '127.0.0.1',
        'host.docker.internal'
      ).replace('localhost', 'host.docker.internal');
    }

    const envArgs = Object.entries({
      ...awsEnvVars,
      ...awsConfigEnv,
      ...containerEnvVars,
      LOCAL_DEV: '1',
      PORT: String(CONTAINER_INTERNAL_PORT),
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
