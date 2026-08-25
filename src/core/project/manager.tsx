import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AddResourceInput,
  CreateProjectInput,
  DeployProjectInput,
  DeployResult,
  ResolveProjectInput,
  Project,
  ProjectManager,
  ProjectEvent,
  ProjectResource,
  RemoveResourceInput,
} from "../../handlers/project/types";
import type { Logger } from "../../logging";
import {
  FsReadWriteJson,
  requireTool,
  runProcess,
  type ProcessRunner,
  type ReadWriteJson,
} from "../../io";
import { defaultSource, type AssetSource } from "./source";
import { ENV_LOCAL_RELATIVE_PATH, EnvLocalFile } from "./envLocal";
import { getHarnessTemplateResolver } from "./templates/harness";
import { createProjectTree } from "./templates/project";
import { getRuntimeTemplateResolver } from "./templates/runtime";
import { ProjectSpecSchema, type ManagedBy } from "../../projectSchemas/project";
import { ConfigBundleSchema } from "../../projectSchemas/config-bundle";
import { CredentialSchema } from "../../projectSchemas/credential";
import { MemorySchema } from "../../projectSchemas/memory";
import { EvaluatorSchema } from "../../projectSchemas/evaluator";
import { OnlineEvalConfigSchema } from "../../projectSchemas/online-eval-config";
import { PolicyEngineSchema, PolicySchema } from "../../projectSchemas/policy";
import { enclosingProjectRoot, projectSpecPath } from "./fsUtils";
import {
  AgentCoreCLIError,
  InputValidationError,
  NotImplementedError,
  ProjectStateError,
} from "../../errors/errors";
import z from "zod";
import { CdkBackend } from "./backends/cdk";
import type { ProjectBackend } from "./backends/types";
import { AwsDeploymentTargetsSchema } from "../../projectSchemas/aws-targets";
import type { RuntimeResourceConfig } from "../../handlers/project/add/runtime/types";
import type { TemplateRenderer } from "./templates/types";
import { HandlebarsTemplateRenderer } from "./templates/renderer";

const TARGETS_EXAMPLE = '[{ "name": "default", "account": "111122223333", "region": "us-east-1" }]';

type ProjectManagerConfig = {
  logger: Logger;
  source?: AssetSource;
  runner?: ProcessRunner;
  checkTool?: typeof requireTool;
  json?: ReadWriteJson;
  backends?: Partial<Record<ManagedBy, ProjectBackend>>;
  templateRenderer?: TemplateRenderer;
};

/**
 * An implementation of {@link ProjectManager} that relies on the local file system to manage projects.
 */
export class FsProjectManager implements ProjectManager {
  private readonly logger: Logger;
  private readonly assetSource: AssetSource;
  private readonly templateRenderer: TemplateRenderer;
  private readonly runner: ProcessRunner;
  private readonly checkTool: typeof requireTool;
  private readonly json: ReadWriteJson;
  private readonly backends: Partial<Record<ManagedBy, ProjectBackend>>;

  constructor(config: ProjectManagerConfig) {
    this.logger = config.logger;
    this.assetSource = config.source ?? defaultSource();
    this.runner = config.runner ?? runProcess;
    this.checkTool = config.checkTool ?? requireTool;
    this.json = config.json ?? new FsReadWriteJson({ logger: config.logger });
    this.backends = config.backends ?? {
      CDK: new CdkBackend({
        logger: config.logger,
        runner: config.runner,
        checkTool: config.checkTool,
        json: config.json,
      }),
    };
    this.templateRenderer = config.templateRenderer ?? new HandlebarsTemplateRenderer();
  }

  public async resolve(input: ResolveProjectInput): Promise<Project | undefined> {
    const rootPath = enclosingProjectRoot(input.filePath);
    if (!rootPath) return undefined;

    const configPath = projectSpecPath(rootPath);
    const spec = await this.json.read(configPath, ProjectSpecSchema);
    return {
      name: spec.name,
      rootPath,
      spec,
    };
  }

  public async *create(input: CreateProjectInput): AsyncGenerator<ProjectEvent, Project> {
    // Scaffold into a fresh directory, refusing to nest inside an existing project.
    const enclosing = enclosingProjectRoot(process.cwd());
    if (enclosing) {
      throw new ProjectStateError(
        `You cannot create a project inside an existing project: ${enclosing}`,
      );
    }

    const scaffoldRuntimeInput = input.scaffoldRuntimeInput;
    const destination = join(process.cwd(), input.name);

    yield { message: "Creating project tree" };
    const projectTree = await createProjectTree(
      { templateRenderer: this.templateRenderer, assetSource: this.assetSource },
      { projectName: input.name },
      { runtime: scaffoldRuntimeInput },
    );
    await projectTree.write(destination);

    // A failed step leaves the scaffolded files in place; the error tells the
    // user how to rerun the step by hand.
    if (!input.skipInstall) {
      await this.checkTool("npm", "Install Node.js: https://nodejs.org/");
      yield { message: "Installing CDK dependencies with npm" };
      await this.run(["npm", "install"], join(destination, "agentcore", "cdk"));

      const appDir = join(destination, "app", scaffoldRuntimeInput.runtimeName);
      yield* this.installRuntimeDependencies(appDir);
    }

    if (!input.skipGit) {
      await this.checkTool("git", "Install git: https://git-scm.com/downloads");
      yield { message: "Initializing git repository" };
      await this.run(["git", "init"], destination);
    }

    // A created project is a resolvable one, so read it back rather than
    // duplicating the template's shape: the returned runtimes are then
    // schema-validated instead of the template's loosely-typed spec sections.
    const project = await this.resolve({ filePath: destination });
    if (!project) {
      throw new ProjectStateError(
        `the project scaffolded at ${destination} could not be read back`,
      );
    }
    return project;
  }

  public async *addResource(
    project: Project,
    input: AddResourceInput,
  ): AsyncGenerator<ProjectEvent, Project> {
    const agentCoreSpecPath = this.getProjectSpecPath(project);
    const projectSpecKey = toProjectSpecKey(input.resourceType);

    yield { message: `Reading project spec file at '${agentCoreSpecPath}'` };
    const projectSpec = await this.json.read(agentCoreSpecPath, ProjectSpecSchema);

    const existingResources = projectSpec[projectSpecKey];
    if (input.resourceType === "gateway-target") {
      // Current L3 outputs are keyed only by Target name, so names must remain
      // project-unique until those outputs include the parent Gateway.
      const gateway = projectSpec.agentCoreGateways.find((candidate) =>
        candidate.targets.some((target) => target.name === input.resourceConfig.name),
      );
      if (gateway) {
        throw new InputValidationError(
          `a gateway target with name '${input.resourceConfig.name}' already exists in gateway '${gateway.name}'`,
        );
      }
      if (
        projectSpec.unassignedTargets?.some((target) => target.name === input.resourceConfig.name)
      ) {
        throw new InputValidationError(
          `an unassigned gateway target with name '${input.resourceConfig.name}' already exists`,
        );
      }
    } else if (input.resourceType === "policy") {
      // Policy names are account-unique on the service, so the check spans engines.
      const engine = projectSpec.policyEngines.find((candidate) =>
        candidate.policies.some((policy) => policy.name === input.resourceConfig.name),
      );
      if (engine) {
        throw new InputValidationError(
          `a policy with name '${input.resourceConfig.name}' already exists in policy engine '${engine.name}'`,
        );
      }
    } else if (existingResources.find((resource) => resource.name === input.resourceConfig.name)) {
      throw new InputValidationError(
        `a ${input.resourceType} with name '${input.resourceConfig.name}' already exists`,
      );
    }

    const scaffoldedPaths: string[] = [];
    let envFile: EnvLocalFile | undefined;

    switch (input.resourceType) {
      case "harness": {
        yield { message: `Scaffolding harness in project` };
        const outputPath = join(project.rootPath, "app", input.resourceConfig.name);
        scaffoldedPaths.push(outputPath);

        const resolver = getHarnessTemplateResolver();
        const result = await resolver.resolve(input.resourceConfig);
        await result.tree.write(dirname(outputPath));
        if (result.spec.harnesses) projectSpec.harnesses.push(...result.spec.harnesses);
        break;
      }
      case "runtime": {
        yield { message: "Scaffolding runtime in project" };
        const outputPath = join(project.rootPath, "app", input.resourceConfig.name);
        scaffoldedPaths.push(outputPath);

        const spec = await this.scaffoldRuntimeResources(outputPath, input.resourceConfig);
        if (spec.runtimes) projectSpec.runtimes.push(...spec.runtimes);
        if (spec.memories) projectSpec.memories.push(...spec.memories);
        if (spec.credentials) projectSpec.credentials.push(...spec.credentials);

        yield* this.installRuntimeDependencies(outputPath);
        break;
      }
      case "credential": {
        const credential = parseResource(CredentialSchema, input.resourceConfig);
        projectSpec.credentials.push(credential);
        if (input.envEntries?.length) {
          envFile = new EnvLocalFile(project.rootPath);
          yield { message: `Updating secrets file at '${envFile.path}'` };
          const { skipped } = await envFile.insertIfNew(input.envEntries);
          for (const key of skipped) {
            yield {
              message: `'${key}' already exists in ${ENV_LOCAL_RELATIVE_PATH}; left unchanged`,
            };
          }
        }
        break;
      }
      case "config-bundle": {
        projectSpec.configBundles.push(parseResource(ConfigBundleSchema, input.resourceConfig));
        break;
      }
      case "online-eval":
      case "online-insight": {
        projectSpec.onlineEvalConfigs.push(
          parseResource(OnlineEvalConfigSchema, input.resourceConfig),
        );
        break;
      }
      case "memory": {
        projectSpec.memories.push(parseResource(MemorySchema, input.resourceConfig));
        break;
      }
      case "evaluator": {
        projectSpec.evaluators.push(parseResource(EvaluatorSchema, input.resourceConfig));
        break;
      }
      case "gateway":
        projectSpec.agentCoreGateways.push(input.resourceConfig);
        break;
      case "policy-engine": {
        projectSpec.policyEngines.push(parseResource(PolicyEngineSchema, input.resourceConfig));
        for (const gatewayName of input.attachGateways?.names ?? []) {
          const gateway = projectSpec.agentCoreGateways.find(
            (candidate) => candidate.name === gatewayName,
          );
          if (!gateway) {
            throw new InputValidationError(
              `gateway '${gatewayName}' does not exist in this project; check agentCoreGateways in agentcore.json`,
            );
          }
          gateway.policyEngineConfiguration = {
            policyEngineName: input.resourceConfig.name,
            mode: input.attachGateways!.mode,
          };
        }
        break;
      }
      case "policy": {
        const engine = projectSpec.policyEngines.find(
          (candidate) => candidate.name === input.engineName,
        );
        if (!engine) {
          throw new InputValidationError(
            `policy engine '${input.engineName}' does not exist in this project; check policyEngines in agentcore.json`,
          );
        }
        engine.policies.push(parseResource(PolicySchema, input.resourceConfig));
        break;
      }
      case "gateway-target": {
        const gatewayIndex = projectSpec.agentCoreGateways.findIndex(
          (gateway) => gateway.name === input.gatewayName,
        );
        if (gatewayIndex < 0) {
          throw new InputValidationError(
            `gateway '${input.gatewayName}' does not exist in this project; check agentCoreGateways in agentcore.json`,
          );
        }
        projectSpec.agentCoreGateways[gatewayIndex]!.targets.push(input.resourceConfig);
        break;
      }
      default: {
        const unhandled: never = input;
        throw new NotImplementedError(`unsupported project resource: ${String(unhandled)}`);
      }
    }

    yield { message: `Updating project spec file at '${agentCoreSpecPath}'` };

    let newProjectSpec: z.infer<typeof ProjectSpecSchema>;
    try {
      const newSpecParseResult = ProjectSpecSchema.safeParse(projectSpec);
      if (!newSpecParseResult.success)
        throw new ProjectStateError(z.prettifyError(newSpecParseResult.error), {
          cause: newSpecParseResult.error,
        });
      newProjectSpec = await this.json.write(agentCoreSpecPath, newSpecParseResult.data);
    } catch (err) {
      this.logger.warn(
        `could not commit the spec update to ${agentCoreSpecPath}; attempting best-effort cleanup of staged changes`,
      );
      await Promise.all([
        ...scaffoldedPaths.map((p) =>
          rm(p, { recursive: true, force: true }).catch((e) => {
            const error = AgentCoreCLIError.fromError(e);
            this.logger
              .child({ errorName: error.name, errorMessage: error.message })
              .warn(`failed to clean up ${p}`);
          }),
        ),
        envFile?.rollback().catch((e) => {
          const error = AgentCoreCLIError.fromError(e);
          this.logger
            .child({ errorName: error.name, errorMessage: error.message })
            .warn(`failed to roll back ${ENV_LOCAL_RELATIVE_PATH}`);
        }),
      ]);
      throw err;
    }

    return {
      ...project,
      spec: newProjectSpec,
    };
  }

  private getProjectSpecPath(project: Project): string {
    return projectSpecPath(project.rootPath);
  }

  public async removeResource(project: Project, input: RemoveResourceInput): Promise<Project> {
    const agentCoreSpecPath = this.getProjectSpecPath(project);
    const existingProjectSpec = await this.json.read(agentCoreSpecPath, ProjectSpecSchema);

    let removed = false;
    let newSpec: unknown;
    if (input.resourceType === "policy") {
      const candidates = existingProjectSpec.policyEngines.filter((engine) =>
        engine.policies.some((policy) => policy.name === input.name),
      );
      if (!input.engineName && candidates.length > 1) {
        throw new InputValidationError(
          `policy '${input.name}' exists in multiple engines: ${candidates
            .map((engine) => engine.name)
            .join(", ")}; use --engine to choose one`,
        );
      }
      const owner = input.engineName
        ? candidates.find((engine) => engine.name === input.engineName)
        : candidates[0];
      removed = owner !== undefined;
      const engines = existingProjectSpec.policyEngines.map((engine) =>
        engine === owner
          ? { ...engine, policies: engine.policies.filter((policy) => policy.name !== input.name) }
          : engine,
      );
      newSpec = { ...existingProjectSpec, policyEngines: engines };
    } else if (input.resourceType === "policy-engine") {
      const engines = existingProjectSpec.policyEngines.filter(
        (engine) => engine.name !== input.name,
      );
      removed = engines.length !== existingProjectSpec.policyEngines.length;
      const gateways = existingProjectSpec.agentCoreGateways.map((gateway) =>
        gateway.policyEngineConfiguration?.policyEngineName === input.name
          ? { ...gateway, policyEngineConfiguration: undefined }
          : gateway,
      );
      newSpec = { ...existingProjectSpec, policyEngines: engines, agentCoreGateways: gateways };
    } else if (input.resourceType === "gateway-target") {
      const gateways = [...existingProjectSpec.agentCoreGateways];
      const gatewayIndex = gateways.findIndex((gateway) => gateway.name === input.gatewayName);
      if (gatewayIndex >= 0) {
        const gateway = gateways[gatewayIndex]!;
        const targets = gateway.targets.filter((target) => target.name !== input.name);
        removed = targets.length !== gateway.targets.length;
        gateways[gatewayIndex] = { ...gateway, targets };
      }
      newSpec = { ...existingProjectSpec, agentCoreGateways: gateways };
    } else {
      const projectSpecKey = toProjectSpecKey(input.resourceType);
      const existingResources = existingProjectSpec[projectSpecKey];
      const newResources = existingResources.filter((resource) => resource.name !== input.name);
      removed = newResources.length !== existingResources.length;
      newSpec = { ...existingProjectSpec, [projectSpecKey]: newResources };
    }

    if (!removed)
      this.logger
        .child({ input })
        .warn(`unable to remove resource from project that does not exist.`);

    const newSpecParseResult = ProjectSpecSchema.safeParse(newSpec);

    if (!newSpecParseResult.success)
      throw new InputValidationError(z.prettifyError(newSpecParseResult.error), {
        cause: newSpecParseResult.error,
      });

    const newProjectSpec = await this.json.write(agentCoreSpecPath, newSpecParseResult.data);

    return {
      ...project,
      spec: newProjectSpec,
    };
  }

  private async scaffoldRuntimeResources(outputPath: string, input: RuntimeResourceConfig) {
    const resolver = getRuntimeTemplateResolver(
      { assetSource: this.assetSource, templateRenderer: this.templateRenderer },
      input,
    );
    if (!resolver)
      throw new InputValidationError(`unable to find template that matches given parameters`);

    const result = await resolver.resolve(input);
    await result.tree.write(dirname(outputPath));
    return result.spec;
  }

  public async *build(project: Project): AsyncGenerator<ProjectEvent, void> {
    yield* this.backendFor(project).build(project);
  }

  // Resolves the named target from aws-targets.json before handing off, so the
  // backend receives a fully resolved account and region and never has to know
  // how targets are stored. The backend owns everything after that point.
  public async *deploy(
    project: Project,
    input: DeployProjectInput,
  ): AsyncGenerator<ProjectEvent, DeployResult> {
    const targetsPath = join(project.rootPath, "agentcore", "aws-targets.json");
    if (!existsSync(targetsPath)) {
      throw new ProjectStateError(
        `No deployment targets are configured for project '${project.name}'. ` +
          `Add ${targetsPath}, for example:\n\n${TARGETS_EXAMPLE}`,
      );
    }

    const targets = await this.json.read(targetsPath, AwsDeploymentTargetsSchema);

    if (targets.length === 0) {
      throw new ProjectStateError(
        `No deployment targets are configured for project '${project.name}'. ` +
          `Add at least one to ${targetsPath}, for example:\n\n${TARGETS_EXAMPLE}`,
      );
    }

    const target = targets.find((candidate) => candidate.name === input.target);
    if (!target) {
      throw new ProjectStateError(
        `Project '${project.name}' has no deployment target named '${input.target}'. ` +
          `${targetsPath} defines: ${targets.map(({ name }) => name).join(", ")}.`,
      );
    }

    return yield* this.backendFor(project).deploy(project, {
      target,
      confirmTeardown: input.confirmTeardown,
    });
  }

  private backendFor(project: Project): ProjectBackend {
    const backend = this.backends[project.spec.managedBy];
    if (!backend) {
      throw new ProjectStateError(
        `project '${project.name}' declares an unsupported backend: ${project.spec.managedBy}`,
      );
    }
    return backend;
  }

  /**
   * Installs dependencies for a scaffolded runtime directory (e.g. `uv sync`
   * for Python). No-ops if the runtime has no recognized dependency manifest.
   */
  private async *installRuntimeDependencies(appDir: string): AsyncGenerator<ProjectEvent, void> {
    if (existsSync(join(appDir, "pyproject.toml"))) {
      await this.checkTool(
        "uv",
        "Install uv: https://docs.astral.sh/uv/getting-started/installation/",
      );
      yield { message: "Syncing Python dependencies with uv" };
      await this.run(["uv", "sync"], appDir);
    }
  }

  // Runs a command with its output streamed to the file logger.
  private run(command: string[], cwd: string): Promise<void> {
    return this.runner(command, { cwd, onOutput: (chunk) => this.logger.debug(chunk) });
  }
}

/** Map {@link ProjectResource} to keys in the project spec.
 * Note: we let TS infer the return type to avoid pulling in keys that do not correspond to resources (ex. name, managedBy, etc.)
 */
function toProjectSpecKey(resourceType: ProjectResource) {
  switch (resourceType) {
    case "harness":
      return "harnesses";
    case "runtime":
      return "runtimes";
    case "credential":
      return "credentials";
    case "config-bundle":
      return "configBundles";
    case "online-eval":
    case "online-insight":
      return "onlineEvalConfigs";
    case "memory":
      return "memories";
    case "evaluator":
      return "evaluators";
    case "gateway":
    case "gateway-target":
      return "agentCoreGateways";
    case "policy-engine":
    case "policy":
      return "policyEngines";
  }
}

function parseResource<TSchema extends z.ZodType>(
  schema: TSchema,
  input: z.input<TSchema>,
): z.output<TSchema> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new InputValidationError(z.prettifyError(result.error), { cause: result.error });
  return result.data;
}
