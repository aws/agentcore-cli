import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../../../io";

/**
 * Where `agentcore migrate` writes the reports a user reads for the full detail
 * behind its summary: the plan, and what applying it did. Project-relative, with
 * forward slashes. agentcore/.cli/* is gitignored, and the git gate ignores this
 * directory too, so a report never counts as an uncommitted change.
 */
export const REPORTS_RELATIVE_PATH = "agentcore/.cli/migrate";

const REPORT_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Writes a report atomically and returns its project-relative path. */
export async function saveMigrationReport(
  rootPath: string,
  fileName: string,
  contents: string,
): Promise<string> {
  if (!REPORT_FILE_NAME.test(fileName)) {
    throw new Error(`Invalid migration report file name '${fileName}'.`);
  }
  const directory = join(rootPath, REPORTS_RELATIVE_PATH);
  await mkdir(directory, { recursive: true });
  await atomicWrite(join(directory, fileName), contents);
  return `${REPORTS_RELATIVE_PATH}/${fileName}`;
}
