import { join } from "node:path";
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
    // Scaffold into a fresh directory.
    const destination = join(process.cwd(), input.name);
    this.logger.debug(`scaffolding project "${input.name}" from template "${input.template}"`);

    const tree = await projectTree(input.name, input.template, this.source);
    await writeTree(tree, destination);

    return { name: input.name };
  }
}
