import { join } from "node:path";
import { InputValidationError } from "../../../errors";

/**
 Deepest file a fresh `npm install` under agentcore/cdk writes, measured from the project root:
 `agentcore/cdk/node_modules/aws-cdk-lib/product-stack-snapshots/nested/<...>.v1.product.template.json`
 is 155 characters (aws-cdk-lib ~2.266 with @aws/agentcore-cdk 0.1.0-alpha.53). The depth comes
 from aws-cdk-lib's own shipped fixtures, so it does not move when the vended app changes.
**/
const DEEPEST_INSTALLED_PATH = 155;

/**
 Windows caps paths at 260 characters unless long paths are enabled, so a project root longer
 than 260 - 1 (separator) - DEEPEST_INSTALLED_PATH fails half way through scaffolding. Refusing
 up front leaves nothing behind. `alternative` names a way out the caller offers besides a
 shorter directory.
**/
const MAX_WINDOWS_PROJECT_PATH = 260 - 1 - DEEPEST_INSTALLED_PATH;

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
