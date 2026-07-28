import { join } from "node:path";
import type {
  CreateProjectInput,
  ResolveProjectInput,
  Project,
  ProjectManager,
} from "../../handlers/project/types";
import type { Logger } from "../../logging";
import { projectTree } from "../../project/compose";
import { defaultSource, type Source } from "../../project/source";
import { writeTree } from "../../project/tree";

type ProjectManagerConfig = {
  logger: Logger;
  /** Asset source; defaults to the current runtime's (disk or embedded). */
  source?: Source;
};

/**
 * An implementation of {@link ProjectManager} that relies on the local file system to manage projects.
 */
export class FsProjectManager implements ProjectManager {
  private readonly logger: Logger;
  private readonly source: Source;

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
