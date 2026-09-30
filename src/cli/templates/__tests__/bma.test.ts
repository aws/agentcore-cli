import { AgentEnvSpecSchema } from '../../../schema';
import type { AddAgentOptions } from '../../commands/add/types.js';
import { validateAddAgentOptions } from '../../commands/add/validate.js';
import { getDryRunInfo } from '../../commands/create/action.js';
import type { CreateOptions } from '../../commands/create/types.js';
import { validateCreateOptions } from '../../commands/create/validate.js';
import {
  mapGenerateConfigToAgent,
  mapGenerateConfigToRenderConfig,
} from '../../operations/agent/generate/schema-mapper.js';
import type { GenerateConfig } from '../../tui/screens/generate/types.js';
import { BmaRenderer } from '../BmaRenderer.js';
import { BMA_TEMPLATE_PROFILE } from '../bmaProfile.js';
import { createRenderer } from '../index.js';
import { TEMPLATE_ROOT } from '../templateRoot.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const bmaConfig: GenerateConfig = {
  projectName: 'BmaEnv',
  buildType: 'CodeZip',
  protocol: 'HTTP',
  sdk: 'BedrockManagedAgents',
  modelProvider: 'Bedrock',
  memory: 'none',
  language: 'Python',
};

const TEMPLATE_DIR = join(TEMPLATE_ROOT, 'python', 'http', 'bma', 'base');

describe('BMA runtime spec', () => {
  it('writes a Container runtime with no session storage or env vars, a 30 minute idle timeout, an 8 hour lifetime, the Mantle policy, and the template tag', () => {
    const agent = mapGenerateConfigToAgent(bmaConfig);

    expect(AgentEnvSpecSchema.safeParse(agent).success).toBe(true);
    expect(agent.build).toBe('Container');
    expect(agent.dockerfile).toBe('Dockerfile');
    expect(agent.lifecycleConfiguration).toEqual({ idleRuntimeSessionTimeout: 1800, maxLifetime: 28800 });
    expect(agent.filesystemConfigurations).toBeUndefined();
    expect(agent.envVars).toBeUndefined();
    expect(agent.additionalPolicies).toEqual(['bma-acr-policy.json']);
    expect(agent.tags).toEqual({ 'agentcore:template': 'BedrockManagedAgents' });
  });

  it('keeps user-supplied timeouts and mount path', () => {
    const agent = mapGenerateConfigToAgent({
      ...bmaConfig,
      idleRuntimeSessionTimeout: 300,
      maxLifetime: 3600,
      sessionStorageMountPath: '/mnt/data',
    });

    expect(agent.lifecycleConfiguration).toEqual({ idleRuntimeSessionTimeout: 300, maxLifetime: 3600 });
    expect(agent.filesystemConfigurations).toEqual([{ sessionStorage: { mountPath: '/mnt/data' } }]);
    expect(agent.envVars).toBeUndefined();
  });

  it('keeps the default idle timeout within a shorter user-supplied lifetime', () => {
    const agent = mapGenerateConfigToAgent({ ...bmaConfig, maxLifetime: 600 });

    expect(AgentEnvSpecSchema.safeParse(agent).success).toBe(true);
    expect(agent.lifecycleConfiguration).toEqual({ idleRuntimeSessionTimeout: 600, maxLifetime: 600 });
  });

  it('moves the default lifetime so that it is not shorter than a user-supplied idle timeout', () => {
    const runtime = BMA_TEMPLATE_PROFILE.runtime!;
    const defaultLifetime = runtime.maxLifetime;
    runtime.maxLifetime = 1800;
    try {
      const agent = mapGenerateConfigToAgent({ ...bmaConfig, idleRuntimeSessionTimeout: 3600 });

      expect(AgentEnvSpecSchema.safeParse(agent).success).toBe(true);
      expect(agent.lifecycleConfiguration).toEqual({ idleRuntimeSessionTimeout: 3600, maxLifetime: 3600 });
    } finally {
      runtime.maxLifetime = defaultLifetime;
    }
  });

  it('adds nothing BMA-specific to other frameworks or to the MCP protocol', () => {
    for (const config of [
      { ...bmaConfig, sdk: 'Strands' as const },
      { ...bmaConfig, protocol: 'MCP' as const },
    ]) {
      const agent = mapGenerateConfigToAgent(config);
      expect(agent.build).toBe('CodeZip');
      expect(agent.dockerfile).toBeUndefined();
      expect(agent.lifecycleConfiguration).toBeUndefined();
      expect(agent.filesystemConfigurations).toBeUndefined();
      expect(agent.envVars).toBeUndefined();
      expect(agent.additionalPolicies).toBeUndefined();
      expect(agent.tags).toBeUndefined();
    }
  });

  it('policy file grants only RegisterEnvironment and ConnectEnvironment in any partition', () => {
    const policy = JSON.parse(readFileSync(join(TEMPLATE_DIR, 'bma-acr-policy.json'), 'utf-8')) as {
      Statement: { Action: string[]; Resource: string }[];
    };

    expect(policy.Statement.flatMap(s => s.Action)).toEqual([
      'bedrock-mantle:RegisterEnvironment',
      'bedrock-mantle:ConnectEnvironment',
    ]);
    expect(policy.Statement.map(s => s.Resource)).toEqual(['arn:*:bedrock-mantle:*:*:project/*']);
  });
});

describe('BmaRenderer', () => {
  let outputDir: string;

  beforeAll(async () => {
    outputDir = join(tmpdir(), `bma-render-${randomUUID()}`);
    mkdirSync(outputDir, { recursive: true });
    const renderConfig = await mapGenerateConfigToRenderConfig(bmaConfig, []);
    const renderer = createRenderer(renderConfig);
    expect(renderer).toBeInstanceOf(BmaRenderer);
    await renderer.render({ outputDir });
  });

  afterAll(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  it('copies the server, the collector configuration, and the Dockerfile from the template without changes', () => {
    const agentDir = join(outputDir, 'app', 'BmaEnv');
    for (const file of ['lifecycle/server.py', 'otel/collector.yaml', 'Dockerfile']) {
      expect(readFileSync(join(agentDir, file), 'utf-8')).toBe(readFileSync(join(TEMPLATE_DIR, file), 'utf-8'));
    }
  });

  it('does not replace the Dockerfile with the generic Python Dockerfile', () => {
    const agentDir = join(outputDir, 'app', 'BmaEnv');
    expect(readFileSync(join(agentDir, 'Dockerfile'), 'utf-8')).toContain('install-codex.sh');
    expect(existsSync(join(agentDir, '.dockerignore'))).toBe(true);
    expect(existsSync(join(agentDir, 'bma-acr-policy.json'))).toBe(true);
  });

  it('runs the server with OpenTelemetry and writes its dependency', () => {
    const agentDir = join(outputDir, 'app', 'BmaEnv');
    const dockerfile = readFileSync(join(agentDir, 'Dockerfile'), 'utf-8');
    expect(dockerfile).toContain('RUN uv sync --no-dev');
    expect(dockerfile).toContain(
      'CMD ["uv", "run", "--no-sync", "opentelemetry-instrument", "python", "-u", "lifecycle/server.py"]'
    );
    expect(dockerfile).not.toContain('.venv/bin');

    const pyproject = readFileSync(join(agentDir, 'pyproject.toml'), 'utf-8');
    expect(pyproject).toContain('name = "BmaEnv"');
    expect(pyproject).toContain('"aws-opentelemetry-distro",');
    expect(pyproject).toContain('"bedrock-agentcore",');
    // The client dependencies are a dev group, which `uv sync --no-dev` leaves out of the image.
    expect(pyproject).toContain(
      '[dependency-groups]\ndev = [\n    "aws-bedrock-token-generator>=1.1.0",\n    "openai>=3.16.2",\n]\n'
    );
    expect(readFileSync(join(agentDir, 'client.py'), 'utf-8')).not.toContain('# /// script');
    expect(mapGenerateConfigToAgent(bmaConfig).instrumentation).toBeUndefined();
  });

  it('sends the spans and logs of the exec-server to the CloudWatch agent, which signs with the ACR role', () => {
    const agentDir = join(outputDir, 'app', 'BmaEnv');
    const dockerfile = readFileSync(join(agentDir, 'Dockerfile'), 'utf-8');
    expect(dockerfile).toContain('amazon_linux/${arch}/latest/amazon-cloudwatch-agent.rpm');
    expect(dockerfile).toContain('WORKDIR /opt/bma\n');
    expect(dockerfile).toContain('COPY otel/ otel/\n');
    const collector = readFileSync(join(agentDir, 'otel', 'collector.yaml'), 'utf-8');
    expect(collector).toContain('value: ${env:AGENTCORE_RUNTIME_SID}');
    expect(collector).toContain('include_metadata: true');
    expect(collector).toContain('additional_auth: sigv4auth/xray');
    expect(collector).toContain('additional_auth: sigv4auth/logs');
    expect(collector).toContain('from_context: x-aws-log-group');
    const main = readFileSync(join(agentDir, 'lifecycle', 'server.py'), 'utf-8');
    expect(main).toContain('COLLECTOR_CONFIG = Path("/opt/bma/otel/collector.yaml")\n');
    expect(main).toContain('COLLECTOR_ENDPOINT = "http://127.0.0.1:4318"\n');
    // The exec-server sends the Runtime OTLP headers itself, so the server gives only the session ID.
    expect(main).toContain('"AGENTCORE_RUNTIME_SID": self.runtime_session_id,');
    expect(main).not.toMatch(/OTEL_EXPORTER_OTLP_\w*HEADERS|BMA_\w*LOG_GROUP/);
    // The Runtime sets AGENT_OBSERVABILITY_ENABLED only to "true", so an absent value turns off the collector.
    expect(main).toContain('os.environ.get("AGENT_OBSERVABILITY_ENABLED", "").lower() == "true"\n');
    expect(main).toContain('*(TELEMETRY_OVERRIDES if self._ensure_collector_locked() else []),');
    expect(main).toContain('if not OBSERVABILITY_ENABLED or not self.runtime_session_id:\n            return False\n');
  });

  it('installs the latest Python in the image and sets only a minimum for client.py', () => {
    const agentDir = join(outputDir, 'app', 'BmaEnv');
    const dockerfile = readFileSync(join(agentDir, 'Dockerfile'), 'utf-8');
    expect(dockerfile).toContain('RUN uv python install --default\n');
    // The image installs Python before it copies pyproject.toml, so the minimum does not pin the image.
    expect(dockerfile.indexOf('RUN uv python install --default')).toBeLessThan(
      dockerfile.indexOf('COPY pyproject.toml')
    );
    // Without a minimum, `uv run client.py` can pick the macOS system Python 3.9, which openai does not support.
    const pyproject = readFileSync(join(agentDir, 'pyproject.toml'), 'utf-8');
    expect(pyproject).toContain('requires-python = ">=3.12"\n');
    expect(pyproject.replace('requires-python = ">=3.12"\n', '')).not.toMatch(/requires-python|python[\s-]*3\.\d+/i);
    for (const file of ['Dockerfile', 'client.py']) {
      const content = readFileSync(join(agentDir, file), 'utf-8');
      expect(content).not.toMatch(/requires-python|python[\s-]*3\.\d+|install 3\.\d+/i);
    }
    // The runtime has no session storage, so the image has no mount path.
    expect(dockerfile).not.toContain('/mnt/workspace');
  });

  it('names the server bma-acr-lifecycle with the pyproject version, and gets the Region only from AWS_REGION', () => {
    const agentDir = join(outputDir, 'app', 'BmaEnv');
    const main = readFileSync(join(agentDir, 'lifecycle', 'server.py'), 'utf-8');
    const pyproject = readFileSync(join(agentDir, 'pyproject.toml'), 'utf-8');
    const version = /^version = "([^"]+)"$/m.exec(pyproject)?.[1];
    expect(version).toBeDefined();
    expect(main).toContain('BMA_NAME = "bma-acr-lifecycle"\n');
    expect(main).toContain(`BMA_VERSION = "${version}"\n`);
    expect(main).toContain('trace.get_tracer(BMA_NAME, BMA_VERSION)');
    expect(main).toContain('server_version = f"{BMA_NAME}/{BMA_VERSION}"');
    expect(main).not.toContain('control-plane');
    expect(main).toContain('AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")\n');
    expect(main).not.toContain('BMA_REGION');
  });

  it('writes a client that uses a workspace in the home directory', () => {
    const client = readFileSync(join(outputDir, 'app', 'BmaEnv', 'client.py'), 'utf-8');
    expect(client).toContain('WORKSPACE_DIRECTORY = "/home/app/workspace"');
    expect(client).toContain('"type": "aws_bedrock_agentcore"');
    expect(client).not.toContain('{{');
  });

  it('copies the default plugin into the image and lists it in the client', () => {
    const agentDir = join(outputDir, 'app', 'BmaEnv');
    const plugin = 'plugins/acr-report';
    for (const file of [`${plugin}/.codex-plugin/plugin.json`, `${plugin}/skills/acr-report/SKILL.md`]) {
      expect(readFileSync(join(agentDir, file), 'utf-8')).toBe(readFileSync(join(TEMPLATE_DIR, file), 'utf-8'));
    }
    const manifest = JSON.parse(readFileSync(join(agentDir, plugin, '.codex-plugin/plugin.json'), 'utf-8')) as {
      name: string;
      skills: string;
    };
    expect(manifest).toMatchObject({ name: 'acr-report', skills: './skills/' });
    const dockerfile = readFileSync(join(agentDir, 'Dockerfile'), 'utf-8');
    expect(dockerfile).toContain('COPY plugins/ plugins/\n');
    const client = readFileSync(join(agentDir, 'client.py'), 'utf-8');
    expect(client).toContain('CAPABILITY_DIRECTORIES = ["/opt/bma/plugins"]');
    expect(client).toContain('"capability_directories": CAPABILITY_DIRECTORIES,');
  });

  it('needs no mount, and keeps HOME and CODEX_HOME in the image', () => {
    const main = readFileSync(join(outputDir, 'app', 'BmaEnv', 'lifecycle', 'server.py'), 'utf-8');
    expect(main).not.toMatch(/BMA_MOUNT_PATH|BMA_OUTPUTS_MOUNT_PATH|BMA_SKILLS_PREFIX|copytree|sync_skills/);
    expect(main).toContain('BMA_HOME_DIR = Path(os.environ.get("BMA_HOME_DIR", str(Path.home())))\n');
    expect(main).toContain('"HOME": str(BMA_HOME_DIR),');
    expect(main).toContain('BMA_HOME_DIR.mkdir(parents=True, exist_ok=True)\n');
    expect(main).toContain('BMA_CODEX_HOME = Path(os.environ.get("BMA_CODEX_HOME", str(BMA_HOME_DIR / ".codex")))\n');
    expect(main).toContain('"CODEX_HOME": str(BMA_CODEX_HOME),');
    expect(main).toContain('"OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED": "false",');
    expect(main).toContain('"OTEL_PYTHON_LOG_CORRELATION": "false",');
  });

  it('runs the exec-server in the workspace directory from the activate request', () => {
    const main = readFileSync(join(outputDir, 'app', 'BmaEnv', 'lifecycle', 'server.py'), 'utf-8');
    expect(main).not.toContain('WORKSPACE_DIR');
    expect(main).toContain('"workspace_directory": directory,');
    expect(main).toContain('cwd=workspace,');
    expect(main).toContain('BMA_STATE_DIR = Path(os.environ.get("BMA_STATE_DIR", str(BMA_HOME_DIR / ".bma")))\n');
    // If BMA_STATE_DIR is not on a mounted path, or the server cannot create it, state.json goes to the home directory.
    expect(main).toContain('return usable_dir(BMA_STATE_DIR if BMA_STATE_DIR.parent.is_dir() else home, home)\n');
    // The workspace has no fallback: activate fails if it has no directory or the server cannot create it.
    expect(main).toContain('workspace = Path(attachment["workspace_directory"])\n');
    expect(main).toMatch(
      /return HTTPStatus\.SERVICE_UNAVAILABLE, \{\n\s+"error": f"cannot create workspace\.directory: \{error\}"/
    );
    expect(main).not.toMatch(/usable_dir\(\s*Path\(attachment|directory or str\(BMA_HOME_DIR\)/);
    expect(main).not.toMatch(/ACR_SESSION_DIR|BMA_STATE_FILE/);
  });

  it('keeps the home workspace in the client when the user adds session storage', async () => {
    const customDir = join(tmpdir(), `bma-render-${randomUUID()}`);
    mkdirSync(customDir, { recursive: true });
    try {
      const renderConfig = await mapGenerateConfigToRenderConfig(
        { ...bmaConfig, sessionStorageMountPath: '/mnt/data' },
        []
      );
      await createRenderer(renderConfig).render({ outputDir: customDir });
      const client = readFileSync(join(customDir, 'app', 'BmaEnv', 'client.py'), 'utf-8');
      expect(client).toContain('WORKSPACE_DIRECTORY = "/home/app/workspace"');
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });
});

describe('validateCreateOptions for BedrockManagedAgents', () => {
  let testDir: string;
  const base = { name: 'BmaEnv', framework: 'BedrockManagedAgents' };

  beforeAll(() => {
    testDir = join(tmpdir(), `bma-validate-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('accepts the BedrockManagedAgents framework with only --name and --framework', () => {
    const options: CreateOptions = { ...base };
    expect(validateCreateOptions(options, testDir).valid).toBe(true);
    expect(options).toMatchObject({ modelProvider: 'Bedrock', memory: 'none', language: 'Python', build: 'Container' });
    expect(validateCreateOptions({ ...base, framework: 'bedrockmanagedagents' }, testDir).valid).toBe(true);
    expect(validateCreateOptions({ ...base, build: 'Container' }, testDir).valid).toBe(true);
  });

  it('rejects memory and CodeZip builds', () => {
    expect(validateCreateOptions({ ...base, memory: 'shortTerm' }, testDir).error).toBe(
      'BedrockManagedAgents supports only --memory none'
    );
    expect(validateCreateOptions({ ...base, build: 'CodeZip' }, testDir).error).toBe(
      'BedrockManagedAgents supports only --build Container'
    );
  });

  it('accepts BMA as a short name for the framework', () => {
    const options: CreateOptions = { ...base, framework: 'BMA' };
    expect(validateCreateOptions(options, testDir).valid).toBe(true);
    expect(options.framework).toBe('BedrockManagedAgents');
  });

  it('rejects a model provider other than Bedrock, TypeScript, and protocols other than HTTP', () => {
    expect(validateCreateOptions({ ...base, modelProvider: 'OpenAI' }, testDir).valid).toBe(false);
    expect(validateCreateOptions({ ...base, language: 'TypeScript' }, testDir).valid).toBe(false);
    expect(validateCreateOptions({ ...base, language: 'Other' }, testDir).error).toBe(
      'BedrockManagedAgents supports only --language Python'
    );
    expect(validateCreateOptions({ ...base, protocol: 'A2A' }, testDir).valid).toBe(false);
    expect(validateCreateOptions({ ...base, protocol: 'MCP' }, testDir).valid).toBe(false);
  });

  it('requires --vpc-id in VPC mode, because the build is Container', () => {
    const vpc = { ...base, networkMode: 'VPC', subnets: 'subnet-12345678', securityGroups: 'sg-12345678' };
    expect(validateCreateOptions({ ...vpc }, testDir).error).toMatch(/--vpc-id/);
    expect(validateCreateOptions({ ...vpc, vpcId: 'vpc-12345678' }, testDir).valid).toBe(true);
  });
});

describe('validateAddAgentOptions for BedrockManagedAgents', () => {
  const base: AddAgentOptions = { name: 'BmaEnv', type: 'create', framework: 'BedrockManagedAgents' };

  it('accepts only --name and --framework, and fills in the model provider, memory, and language', () => {
    const options: AddAgentOptions = { ...base };
    expect(validateAddAgentOptions(options)).toEqual({ valid: true });
    expect(options).toMatchObject({ modelProvider: 'Bedrock', memory: 'none', language: 'Python', build: 'Container' });
  });

  it('rejects --type byo and import', () => {
    expect(validateAddAgentOptions({ ...base, type: 'byo', codeLocation: './x' }).error).toBe(
      'BedrockManagedAgents supports only --type create'
    );
    expect(validateAddAgentOptions({ ...base, type: 'import' }).error).toBe(
      'BedrockManagedAgents supports only --type create'
    );
  });

  it('accepts BMA as a short name for the framework', () => {
    const options = { ...base, framework: 'bma' } as unknown as AddAgentOptions;
    expect(validateAddAgentOptions(options).valid).toBe(true);
    expect(options.framework).toBe('BedrockManagedAgents');
  });

  it('rejects memory and CodeZip builds', () => {
    expect(validateAddAgentOptions({ ...base, memory: 'shortTerm' }).error).toBe(
      'BedrockManagedAgents supports only --memory none'
    );
    expect(validateAddAgentOptions({ ...base, build: 'CodeZip' }).error).toBe(
      'BedrockManagedAgents supports only --build Container'
    );
    expect(validateAddAgentOptions({ ...base, language: 'TypeScript' }).error).toBe(
      'BedrockManagedAgents supports only --language Python'
    );
  });
});

describe('getDryRunInfo for BedrockManagedAgents', () => {
  const dryRunFiles = (framework: string) => {
    const result = getDryRunInfo({ name: 'A', cwd: '/w', language: 'Python', framework });
    return result.success ? result.wouldCreate : [];
  };

  it('lists the server as the main file', () => {
    expect(dryRunFiles('BedrockManagedAgents')).toContain('/w/A/app/A/lifecycle/server.py');
    expect(dryRunFiles('BedrockManagedAgents')).not.toContain('/w/A/app/A/main.py');
    expect(dryRunFiles('Strands')).toContain('/w/A/app/A/main.py');
  });
});
