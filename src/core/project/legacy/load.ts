import type { Project } from "../../../handlers/project/types";
import type { ReadWriteJson } from "../../../io";
import { V0AgentCoreProjectSpecSchema } from "../../../projectSchemas/v0";
import { projectSpecPath } from "../fsUtils";
import { translateV0Spec } from "./translate";

/** Parse a v0 project with v0's schema and expose a translated, read-only in-memory view. */
export async function loadLegacyProject(rootPath: string, json: ReadWriteJson): Promise<Project> {
  const v0Spec = await json.read(projectSpecPath(rootPath), V0AgentCoreProjectSpecSchema);
  const { spec } = translateV0Spec(v0Spec);
  return {
    name: v0Spec.name,
    rootPath,
    spec,
    legacy: { format: "v0", v0Spec },
  };
}
