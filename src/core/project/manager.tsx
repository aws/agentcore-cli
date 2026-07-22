import type {
  CreateProjectInput,
  ResolveProjectInput,
  Project,
  ProjectManager,
} from "../../handlers/project/types";
import type { Logger } from "../../logging";
import { AssetManager } from "../../assetManager";

type ProjectManagerConfig = {
  logger: Logger;
  assetManager: AssetManager;
};

/**
 * An implementation of {@link ProjectManager} that relies on the local file system to manage projects.
 */
export class FsProjectManager implements ProjectManager {
  constructor(private readonly config: ProjectManagerConfig) {}

  public resolve(_input: ResolveProjectInput): Promise<Project> {
    throw new Error(`ProjectManager.resolve is not implemented yet`);
  }

  public create(_input: CreateProjectInput): Promise<Project> {
    throw new Error(`ProjectManager.create is not implemented yet`);
  }
}
