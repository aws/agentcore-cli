import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { AgentCoreCLIError, ERROR_SOURCE } from "../../errors";
import type {
  CreateProjectInput,
  ResolveProjectInput,
  Project,
  ProjectManager,
} from "../../handlers/project/types";
import type { Logger } from "../../logging";
import { projectTree } from "./compose";
import { defaultSource, type AssetSource } from "./source";
import { writeTree } from "./tree";

/** Thrown when scaffolding would nest a new project inside an existing AgentCore project. */
export class NestedProjectError extends AgentCoreCLIError {
  constructor(public readonly projectRoot: string) {
    super(
      `cannot create a project inside an existing AgentCore project (found ${join(projectRoot, "agentcore", "agentcore.json")})`,
      { source: ERROR_SOURCE.USER, meta: { projectRoot } },
    );
  }
}

/** Walks up from directory looking for the agentcore/agentcore.json project marker. */
function enclosingProjectRoot(directory: string): string | undefined {
  for (let current = directory; ; current = dirname(current)) {
    if (existsSync(join(current, "agentcore", "agentcore.json"))) {
      return current;
    }
    if (dirname(current) === current) {
      return undefined;
    }
  }
}

type ProjectManagerConfig = {
  logger: Logger;
  source?: AssetSource; // Bun executable or dist/assets depending on runtime
};

/**
 * An implementation of {@link ProjectManager} that relies on the local file system to manage projects.
 */
export class FsProjectManager implements ProjectManager {
  private readonly logger: Logger;
  private readonly source: AssetSource;

  constructor(config: ProjectManagerConfig) {
    this.logger = config.logger;
    this.source = config.source ?? defaultSource();
  }

  public resolve(_input: ResolveProjectInput): Promise<Project> {
    throw new Error(`ProjectManager.resolve is not implemented yet`);
  }

  public async create(input: CreateProjectInput): Promise<Project> {
    // Scaffold into a fresh directory, refusing to nest inside an existing project.
    const enclosing = enclosingProjectRoot(process.cwd());
    if (enclosing) {
      throw new NestedProjectError(enclosing);
    }
    const destination = join(process.cwd(), input.name);
    this.logger.debug(`scaffolding project "${input.name}" from template "${input.template}"`);

    const tree = await projectTree(input.name, input.template, this.source);
    await writeTree(tree, destination);

    return { name: input.name };
  }
}
