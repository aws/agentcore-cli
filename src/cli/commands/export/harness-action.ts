import { AgentAlreadyExistsError, ConfigIO, setEnvVar } from '../../../lib';
import { ExportHarnessError, ValidationError } from '../../../lib/errors/types';
import { AgentNameSchema } from '../../../schema';
import type { AgentEnvSpec, BuildType, Credential, HarnessSpec } from '../../../schema';
import { getErrorMessage } from '../../errors';
import { regionFromHarnessArn } from '../../operations/harness/orphan';
import type { AttributeRecorder } from '../../telemetry/cli-command-run.js';
import { withCommandRunTelemetry } from '../../telemetry/cli-command-run.js';
import type { CommandAttrs } from '../../telemetry/schemas/command-run.js';
import {
  BuildType as TelemetryBuildType,
  ModelProvider as TelemetryModelProvider,
  standardize,
} from '../../telemetry/schemas/common-shapes.js';
import { StrandsRenderer } from '../../templates/StrandsRenderer';
import {
  CUSTOM_DOCKERFILE_NOTE_CATEGORY,
  EXPORT_NOTES_FILENAME,
  PATH_SKILLS_COPIED_NOTE_CATEGORY,
  PATH_SKILLS_VERIFY_BASE_IMAGE_NOTE_CATEGORY,
} from './constants';
import { fetchHarnessSpecByArn } from './fetch-harness-spec';
import { isPathSkill, mapHarnessToExportConfig } from './harness-mapper';
import { resolveHarnessContext } from './harness-resolver';
import type { ExportHarnessOptions, ExportNote, ResolvedHarnessContext } from './types';
import { execSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';

export interface ExportHarnessProgress {
  onProgress?: (message: string) => void;
}

export async function handleExportHarness(
  options: ExportHarnessOptions,
  progress?: ExportHarnessProgress
): Promise<
  { success: true; agentName: string; agentPath: string; notesPath: string } | { success: false; error: Error }
> {
  const log = (msg: string) => progress?.onProgress?.(msg);

  return withCommandRunTelemetry(
    'export.harness',
    {} as CommandAttrs<'export.harness'>,
    async (recorder: AttributeRecorder<CommandAttrs<'export.harness'>>) => {
      if (!!options.name === !!options.arn) {
        return {
          success: false as const,
          error: new ValidationError('Specify exactly one of --name (local harness) or --arn (fetched harness).'),
        };
      }

      const buildOverride = options.build as BuildType | undefined;
      const VALID_BUILD_TYPES = new Set<string>(['CodeZip', 'Container']);
      if (buildOverride && !VALID_BUILD_TYPES.has(buildOverride)) {
        return {
          success: false as const,
          error: new ValidationError(`Invalid --build value "${buildOverride}". Expected CodeZip or Container.`),
        };
      }

      // For --arn, fetch the harness from the service first so we can derive its name. The fetch
      // needs a region — taken from the project's first deployment target.
      let prefetched: { spec: HarnessSpec; systemPrompt?: string } | undefined;
      if (options.arn) {
        log('Fetching harness from service');
        const region = await resolveExportRegion(options.arn);
        if (!region) {
          return {
            success: false as const,
            error: new ValidationError(
              'No AWS region configured. Pass an ARN that includes a region, configure a deployment ' +
                'target (agentcore/aws-targets.json), or set AWS_REGION before exporting by ARN.'
            ),
          };
        }
        try {
          prefetched = await fetchHarnessSpecByArn(options.arn, region);
        } catch (err) {
          return { success: false as const, error: err instanceof Error ? err : new Error(String(err)) };
        }
      }

      const harnessName = options.name ?? prefetched!.spec.name;
      const targetAgentName = options.targetAgentName ?? `${harnessName}Agent`;
      const parsedAgentName = AgentNameSchema.safeParse(targetAgentName);
      if (!parsedAgentName.success) {
        return {
          success: false as const,
          error: new ValidationError(
            `Invalid --target-agent-name "${targetAgentName}": ${parsedAgentName.error.issues[0]?.message ?? 'invalid name'}`
          ),
        };
      }

      // 1. Resolve all on-disk inputs (+ the prefetched spec for the --arn path)
      log('Reading harness configuration');
      let context: Awaited<ReturnType<typeof resolveHarnessContext>>;
      try {
        context = await resolveHarnessContext(harnessName, targetAgentName, undefined, prefetched);
      } catch (err) {
        return { success: false as const, error: err instanceof Error ? err : new Error(String(err)) };
      }

      // 2. Map harness spec to render config + agent env spec
      log('Mapping to Strands template config');
      const { renderConfig, agentEnvSpec, credentialEntry, mcpCredentialEntries, gitCredentialEntries } =
        mapHarnessToExportConfig(context, buildOverride);

      // The target directory is guaranteed not to pre-exist (resolveHarnessContext throws if it
      // does), so anything written below is created by this export. Remove it on failure to avoid
      // leaving an orphan directory with no matching agentcore.json entry.
      const agentDir = join(context.projectRoot, 'app', targetAgentName);
      const cleanupAgentDir = () => {
        try {
          rmSync(agentDir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup — ignore failures
        }
      };

      // 3. Copy Dockerfile + supporting harness directories (e.g. path_skill/, assets/)
      //    Harness files that are NOT copied: harness.json, system-prompt.md (regenerated by export)
      const HARNESS_SKIP_FILES = new Set(['harness.json', 'system-prompt.md']);
      if (context.spec.dockerfile) {
        const harnessDir = join(context.projectRoot, 'app', harnessName);
        const dockerfileSrc = join(harnessDir, context.spec.dockerfile);
        if (existsSync(dockerfileSrc)) {
          mkdirSync(agentDir, { recursive: true });
          copyFileSync(dockerfileSrc, join(agentDir, context.spec.dockerfile));
          context.exportNotes.push(buildCustomDockerfileNote(context.spec.dockerfile, targetAgentName));
        } else {
          context.exportNotes.push(buildMissingDockerfileNote(context.spec.dockerfile, harnessName, targetAgentName));
        }
        // Copy all non-file entries (directories) and non-skipped files from the harness dir
        if (existsSync(harnessDir)) {
          cpSync(harnessDir, agentDir, {
            recursive: true,
            filter: src => {
              const name = basename(src);
              return !HARNESS_SKIP_FILES.has(name);
            },
          });
        }
      }

      // 3b. Path skills + CLI-generated Dockerfile: the custom-dockerfile branch above already
      //     copies the whole harness dir, but a plain `--build Container` / containerUri build uses
      //     a generated Dockerfile (`COPY . .`) and the harness dir is NOT otherwise copied. Per the
      //     documented contract, copy each path-skill directory that resolves locally under the
      //     harness dir into the agent dir so the generated Dockerfile bundles it (no manual step);
      //     unresolvable paths (absolute, traversal, or not found) are assumed to live in the base
      //     image and get a verify-note instead. (Container only — CodeZip path skills are unsupported
      //     and already noted by the mapper.)
      if (!context.spec.dockerfile && renderConfig.buildType === 'Container') {
        const harnessDir = join(context.projectRoot, 'app', harnessName);
        const copied: string[] = [];
        const unresolved: string[] = [];
        for (const skill of context.spec.skills) {
          // Only pure path skills (a git skill carries `path` as a repo subdir, not a local dir).
          if (!isPathSkill(skill) || !skill.path) continue;
          const skillPath = skill.path;
          const skillSrc = join(harnessDir, skillPath);
          // Reject absolute paths and traversal — must resolve to a dir inside the harness dir.
          const escapesHarness = isAbsolute(skillPath) || !resolve(skillSrc).startsWith(resolve(harnessDir) + sep);
          if (!escapesHarness && existsSync(skillSrc)) {
            const skillDest = join(agentDir, skillPath);
            mkdirSync(skillDest, { recursive: true });
            cpSync(skillSrc, skillDest, { recursive: true });
            copied.push(skillPath);
          } else {
            unresolved.push(skillPath);
          }
        }
        if (copied.length > 0) {
          context.exportNotes.push(buildPathSkillsCopiedNote(copied, targetAgentName));
        }
        if (unresolved.length > 0) {
          context.exportNotes.push(buildPathSkillsVerifyNote(unresolved, targetAgentName));
        }
      }

      // 4. Generate Dockerfile stub for containerUri
      if (context.spec.containerUri && renderConfig.buildType === 'Container') {
        mkdirSync(agentDir, { recursive: true });
        writeDockerfileStub(agentDir, context.spec.containerUri);
      }

      // 5. Render Strands agent code
      log('Rendering agent code');
      try {
        const renderer = new StrandsRenderer(renderConfig);
        await renderer.render({ outputDir: context.projectRoot });
      } catch (err) {
        cleanupAgentDir();
        return {
          success: false as const,
          error: new ExportHarnessError(
            `Failed to render agent code for "${targetAgentName}": ${getErrorMessage(err)}`,
            {
              cause: err instanceof Error ? err : undefined,
            }
          ),
        };
      }

      // 5b. Generate uv.lock for Container builds (required by the Dockerfile's uv sync step)
      if (renderConfig.buildType === 'Container') {
        log('Generating uv.lock for container build');
        try {
          execSync('uv lock', { cwd: agentDir, stdio: 'pipe' });
        } catch {
          // uv not installed or failed — add a note and continue; user can run manually
          context.exportNotes.push({
            category: 'uv.lock missing — run `uv lock` before deploying',
            message:
              `The container Dockerfile requires a uv.lock file. Run \`uv lock\` in ` +
              `app/${targetAgentName}/ before running \`agentcore deploy\`.`,
          });
        }
      }

      // 6. Write agent to agentcore.json
      log('Updating agentcore.json');
      try {
        await writeExportedAgentToProject(
          agentEnvSpec,
          context,
          credentialEntry,
          mcpCredentialEntries,
          gitCredentialEntries
        );
      } catch (err) {
        cleanupAgentDir();
        return { success: false as const, error: err instanceof Error ? err : new Error(String(err)) };
      }

      // 6c. Write MCP header credential values to .env.local for local development
      for (const { envVarName, value } of mcpCredentialEntries) {
        await setEnvVar(envVarName, value, context.configBaseDir);
      }

      // 6d. Write static connection discovery values (external gateway URL, browser/code-interpreter
      //     id) to .env.local so `agentcore dev` resolves them locally. At deploy the CDK connection
      //     wiring injects the same env vars onto the runtime.
      for (const [envVarName, value] of Object.entries(context.localEnvVars)) {
        await setEnvVar(envVarName, value, context.configBaseDir);
      }

      // 6e. Write generated IAM policy files (e.g. S3 skills) into the agent's code dir. They are
      //     referenced from AgentEnvSpec.additionalPolicies and attached to the role at deploy.
      for (const [fileName, policyDoc] of Object.entries(context.generatedPolicyFiles)) {
        mkdirSync(agentDir, { recursive: true });
        writeFileSync(join(agentDir, fileName), JSON.stringify(policyDoc, null, 2) + '\n');
      }

      // 7. Write EXPORT_NOTES.md
      log('Writing EXPORT_NOTES.md');
      writeExportNotes(context.exportNotes, harnessName, targetAgentName, agentDir);

      // Record telemetry attrs after all work is done
      recorder.set({
        build_type: standardize(TelemetryBuildType, renderConfig.buildType ?? 'CodeZip'),
        // renderConfig.modelProvider is the CLI ModelProvider enum (e.g. 'LiteLLM'); standardize only
        // lowercases, so 'LiteLLM' -> 'litellm' would miss the telemetry token 'lite_llm'. Normalize
        // the one value whose lowercase != its telemetry token before standardizing.
        model_provider: standardize(
          TelemetryModelProvider,
          renderConfig.modelProvider === 'LiteLLM' ? 'lite_llm' : renderConfig.modelProvider
        ),
        has_memory: renderConfig.hasMemory,
        has_gateway: renderConfig.hasGateway,
        has_container: renderConfig.buildType === 'Container',
        has_execution_limits: !!renderConfig.hasExecutionLimits,
        notes_count: context.exportNotes.length,
      });

      return {
        success: true as const,
        agentName: targetAgentName,
        agentPath: agentDir,
        notesPath: join(agentDir, EXPORT_NOTES_FILENAME),
      };
    }
  );
}

// ============================================================================
// Write agent entry to agentcore.json
// ============================================================================

/** Region for the --arn fetch: the current project's first deployment target. */
/**
 * Resolve the region used to fetch a harness by ARN, in priority order:
 *   1. the region embedded in the harness ARN (`arn:<p>:bedrock-agentcore:<region>:...`) — this is
 *      the region the harness actually lives in, so it is the most correct source;
 *   2. the first configured deployment target (agentcore/aws-targets.json);
 *   3. the AWS_REGION / AWS_DEFAULT_REGION environment variables.
 * Returns undefined only when none of these yield a region, so export-by-ARN no longer requires a
 * configured deployment target when the ARN (or the environment) already names a region.
 */
export async function resolveExportRegion(arn: string): Promise<string | undefined> {
  const arnRegion = regionFromHarnessArn(arn);
  if (arnRegion) return arnRegion;

  try {
    const targets = await new ConfigIO().readAWSDeploymentTargets();
    if (targets[0]?.region) return targets[0].region;
  } catch {
    // fall through to env
  }

  return process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? undefined;
}

async function writeExportedAgentToProject(
  agentEnvSpec: AgentEnvSpec,
  context: ResolvedHarnessContext,
  credentialEntry: Credential | null,
  mcpCredentialEntries: { credential: Credential }[],
  gitCredentialEntries: Credential[] = []
): Promise<void> {
  const configIO = new ConfigIO({ baseDir: context.configBaseDir });
  const project = await configIO.readProjectSpec();

  if (project.runtimes.some(r => r.name === agentEnvSpec.name)) {
    throw new AgentAlreadyExistsError(agentEnvSpec.name);
  }

  project.runtimes.push(agentEnvSpec);

  if (credentialEntry && !project.credentials.some(c => c.name === credentialEntry.name)) {
    project.credentials.push(credentialEntry);
  }

  for (const { credential } of mcpCredentialEntries) {
    if (!project.credentials.some(c => c.name === credential.name)) {
      project.credentials.push(credential);
    }
  }

  // Git-skill API-key credential references (private repo clone auth).
  for (const credential of gitCredentialEntries) {
    if (!project.credentials.some(c => c.name === credential.name)) {
      project.credentials.push(credential);
    }
  }

  await configIO.writeProjectSpec(project);
}

// ============================================================================
// Dockerfile export notes
// ============================================================================

/**
 * Note emitted when a harness with a custom Dockerfile is exported.
 *
 * The harness Dockerfile describes an *execution environment* — the harness runtime overrides its
 * ENTRYPOINT/CMD and supplies the agent. An exported agent, by contrast, is the entrypoint and must
 * build/install its own deps and launch main.py. We cannot safely rewrite an arbitrary user
 * Dockerfile (custom base image, WORKDIR, USER, apt packages), so we preserve it as-is and tell the
 * user to append the agent build layer.
 */
export function buildCustomDockerfileNote(dockerfile: string, targetAgentName: string): ExportNote {
  return {
    category: CUSTOM_DOCKERFILE_NOTE_CATEGORY,
    message:
      `The harness used a custom Dockerfile ("${dockerfile}") that describes its execution ` +
      `environment. It has been copied to app/${targetAgentName}/${dockerfile} unchanged, but ` +
      `the exported agent will NOT run as-is: a harness Dockerfile has no dependency install, code copy, or ` +
      `startup command (the harness runtime supplied those). Add the Strands agent build layer to the end ` +
      `of app/${targetAgentName}/${dockerfile} before \`agentcore deploy\` ` +
      `(adjust if your base image is not Python 3.12+/uv, or already sets WORKDIR/USER):\n\n` +
      `  WORKDIR /app\n` +
      `  RUN pip install --no-cache-dir uv\n` +
      `  COPY pyproject.toml uv.lock ./\n` +
      `  RUN uv sync --frozen --no-dev --no-install-project\n` +
      `  COPY --chown=bedrock_agentcore:bedrock_agentcore . .\n` +
      `  RUN uv sync --frozen --no-dev\n` +
      `  USER bedrock_agentcore\n` +
      `  EXPOSE 8080 8000 9000\n` +
      `  CMD ["opentelemetry-instrument", "python", "-m", "main"]\n\n` +
      `Also ensure the build sets the runtime entrypoint to the generated main.py rather than ` +
      `the harness's overridden entrypoint.`,
  };
}

/** Note emitted when a harness references a dockerfile that does not exist on disk. */
export function buildMissingDockerfileNote(
  dockerfile: string,
  harnessName: string,
  targetAgentName: string
): ExportNote {
  return {
    category: `Dockerfile not found — create ${dockerfile} before deploying`,
    message:
      `The harness references dockerfile: "${dockerfile}" but no such file exists in ` +
      `app/${harnessName}/. Create a Dockerfile at app/${targetAgentName}/${dockerfile} ` +
      `before running \`agentcore deploy\`.`,
  };
}

/** Note emitted when local path-skill directories were copied into the generated agent dir. */
export function buildPathSkillsCopiedNote(paths: string[], targetAgentName: string): ExportNote {
  return {
    category: PATH_SKILLS_COPIED_NOTE_CATEGORY,
    message:
      `The following path-skill ${paths.length === 1 ? 'directory was' : 'directories were'} copied into ` +
      `app/${targetAgentName}/ so the generated Dockerfile's \`COPY . .\` step bundles ${paths.length === 1 ? 'it' : 'them'} ` +
      `into the image — no manual step required: ${paths.map(p => `"${p}"`).join(', ')}.`,
  };
}

/**
 * Note emitted when a path skill could not be resolved to a local directory (absolute path, path
 * traversal, or not found under the harness dir). It is assumed to be provided by the base image.
 */
export function buildPathSkillsVerifyNote(paths: string[], targetAgentName: string): ExportNote {
  return {
    category: PATH_SKILLS_VERIFY_BASE_IMAGE_NOTE_CATEGORY,
    message:
      `The following path ${paths.length === 1 ? 'skill was' : 'skills were'} not found locally under the ` +
      `harness directory, so ${paths.length === 1 ? 'it was' : 'they were'} NOT copied into app/${targetAgentName}/: ` +
      `${paths.map(p => `"${p}"`).join(', ')}. The exported agent loads ${paths.length === 1 ? 'this path' : 'these paths'} ` +
      `at runtime — ensure ${paths.length === 1 ? 'it exists' : 'they exist'} on the container filesystem (e.g. installed ` +
      `in your base image or added via a Dockerfile COPY) before \`agentcore deploy\`.`,
  };
}

// ============================================================================
// Write EXPORT_NOTES.md
// ============================================================================

function readStrandsVersion(agentDir: string): string {
  try {
    const pyproject = readFileSync(join(agentDir, 'pyproject.toml'), 'utf8');
    const match = /strands-agents\s*(>=\s*[\d.]+)/.exec(pyproject);
    return match ? `strands-agents ${match[1]}` : 'strands-agents (version unknown)';
  } catch {
    return 'strands-agents (version unknown)';
  }
}

function writeExportNotes(notes: ExportNote[], harnessName: string, agentName: string, agentDir: string): void {
  const today = new Date().toISOString().split('T')[0];
  const strandsVersion = readStrandsVersion(agentDir);
  const lines: string[] = [
    `# Export Notes — ${harnessName} → ${agentName}`,
    '',
    `Exported on: ${today}`,
    `Strands version: ${strandsVersion}`,
    `Source harness: agentcore/app/${harnessName}/harness.json`,
    `Generated agent: app/${agentName}/`,
    '',
  ];

  if (notes.length === 0) {
    lines.push('No manual steps required.');
  } else {
    lines.push('## Items requiring manual follow-up');
    for (const note of notes) {
      lines.push('');
      lines.push(`### ${note.category}`);
      lines.push(note.message);
    }
  }

  lines.push('');

  const outPath = join(agentDir, EXPORT_NOTES_FILENAME);
  writeFileSync(outPath, lines.join('\n'), 'utf8');
}

// ============================================================================
// Dockerfile stub for containerUri harnesses
// ============================================================================

function writeDockerfileStub(agentDir: string, containerUri: string): void {
  const content = [
    `# Base image from the source harness: ${containerUri}`,
    '# The generated Strands agent is layered on top. If the base image does not',
    '# include Python 3.12+ or uv, add install steps before the COPY/RUN below.',
    `FROM ${containerUri}`,
    '',
    'RUN pip install --no-cache-dir uv',
    '',
    'WORKDIR /app',
    '',
    'ARG UV_DEFAULT_INDEX',
    'ARG UV_INDEX',
    '',
    'ENV UV_SYSTEM_PYTHON=1 \\',
    '    UV_COMPILE_BYTECODE=1 \\',
    '    UV_NO_PROGRESS=1 \\',
    '    PYTHONUNBUFFERED=1 \\',
    '    DOCKER_CONTAINER=1 \\',
    '    UV_DEFAULT_INDEX=${UV_DEFAULT_INDEX} \\',
    '    UV_INDEX=${UV_INDEX} \\',
    '    PATH="/app/.venv/bin:$PATH"',
    '',
    'RUN useradd -m -u 1000 bedrock_agentcore',
    '',
    'COPY pyproject.toml uv.lock ./',
    'RUN uv sync --frozen --no-dev --no-install-project',
    '',
    'COPY --chown=bedrock_agentcore:bedrock_agentcore . .',
    'RUN uv sync --frozen --no-dev',
    '',
    'USER bedrock_agentcore',
    '',
    'EXPOSE 8080 8000 9000',
    '',
    'CMD ["opentelemetry-instrument", "python", "-m", "main"]',
    '',
  ].join('\n');

  writeFileSync(join(agentDir, 'Dockerfile'), content, 'utf8');
}
