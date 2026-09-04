import { join } from "node:path";
import { InputValidationError } from "../../../errors";

const MAX_WINDOWS_PROJECT_PATH = 150;

/**
 Windows caps paths at 260 characters unless long paths are enabled, and npm
 install under the CDK app needs about 100 of them, so a deep project root
 fails half way through scaffolding. Refusing up front leaves nothing behind.
 `alternative` names a way out the caller offers besides a shorter directory.
**/
export function assertProjectPathFits(
  name: string,
  platform: NodeJS.Platform,
  { cwd = process.cwd(), alternative }: { cwd?: string; alternative?: string } = {},
): void {
  const destination = join(cwd, name);
  if (platform !== "win32" || destination.length <= MAX_WINDOWS_PROJECT_PATH) return;
  const remedy = alternative ? `, or ${alternative}` : "";
  throw new InputValidationError(
    `project path is too long for Windows (${destination.length} characters): npm install under ` +
      `agentcore/cdk would exceed the 260 character MAX_PATH. Create the project in a shorter ` +
      `directory${remedy}.`,
  );
}
