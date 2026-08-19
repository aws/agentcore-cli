import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { InputValidationError } from "../../errors";

export function resolvePathWithinProject(
  projectRoot: string,
  path: string,
  description: string,
): string {
  const canonicalRoot = realpathSync(projectRoot);
  const canonicalPath = realpathSync(path);
  const relativePath = relative(canonicalRoot, canonicalPath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new InputValidationError(
      `${description} must be within the project root: ${canonicalPath}`,
    );
  }
  return canonicalPath;
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
