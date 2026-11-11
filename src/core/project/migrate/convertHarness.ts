import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "yaml";
import type { MigrationProblem } from "../../../handlers/project/migrate/types";
import {
  encodeHarnessYaml,
  HarnessSpecSchema,
  HarnessYamlSchema,
  type HarnessSpec,
} from "../../../projectSchemas/harness";
import { V0HarnessSpecSchema, type V0HarnessSpec } from "../../../projectSchemas/v0";
import type { HarnessFacts } from "./convertSpec";
import { describePath, droppedPaths, problemsFromZodError } from "./issues";

const YAML_HEADER =
  "# Harness configuration: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html\n" +
  "# Converted from harness.json by agentcore migrate.\n\n";

export type ConvertedHarness = {
  name: string;
  /** The harness directory, project-relative and `/`-separated. */
  directory: string;
  /** The harness.yaml content; absent when the harness has problems. */
  yaml?: string;
  problems: MigrationProblem[];
  warnings: string[];
  /** What harness.json says about the AWS resources v0 made; absent when it couldn't be read. */
  facts?: HarnessFacts;
};

/**
 * v1 reads harnesses from harness.yaml in a different shape than v0's
 * harness.json; converting them keeps every harness working after the migration
 * without the user rewriting its configuration by hand.
 */
/** Reads a harness registry entry's `harness.json` and converts it to `harness.yaml`. */
export async function convertHarness(
  rootPath: string,
  entry: { name: string; path: string },
): Promise<ConvertedHarness> {
  const directory = posix.normalize(entry.path.replaceAll("\\", "/")).replace(/\/$/, "");
  const file = `${directory}/harness.json`;
  if (
    directory === ".." ||
    directory.startsWith("../") ||
    posix.isAbsolute(directory) ||
    /^[a-zA-Z]:/.test(directory)
  ) {
    return {
      name: entry.name,
      directory,
      warnings: [],
      problems: [
        {
          file: "agentcore/agentcore.json",
          path: `harnesses[${entry.name}].path`,
          message: `'${entry.path}' is outside the project; move the harness into the project first`,
        },
      ],
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(rootPath, file), "utf8"));
  } catch (error) {
    return {
      name: entry.name,
      directory,
      warnings: [],
      problems: [
        { file, path: "(file)", message: `Couldn't read it: ${(error as Error).message}` },
      ],
    };
  }
  const converted = harnessJsonToYaml(raw, file);
  const warnings: string[] = [];
  // v0 and v1 resolve the prompt the same way: an inline systemPrompt wins, and
  // system-prompt.md is read only when there is none. The conversion keeps the
  // inline prompt inline and never inlines the file, so the deployed prompt stays
  // the same; a file shadowed by an inline prompt is worth pointing out.
  if (
    converted.facts?.systemPrompt !== undefined &&
    existsSync(join(rootPath, directory, "system-prompt.md"))
  ) {
    warnings.push(
      `${directory}/system-prompt.md is ignored because harness.json sets systemPrompt inline; ` +
        "v1 does the same. Delete the file, or remove systemPrompt from harness.yaml to use it.",
    );
  }
  const facts = converted.facts && {
    dockerfile: converted.facts.dockerfile,
    containerUri: converted.facts.containerUri,
    executionRoleArn: converted.facts.executionRoleArn,
  };
  return {
    name: entry.name,
    directory,
    yaml: converted.yaml,
    problems: converted.problems,
    warnings,
    facts,
  };
}

/**
 * Converts the content of a v0 `harness.json` into a v1 `harness.yaml`.
 *
 * The file is read with v0's schema (so v0's defaults apply, as they did when it
 * deployed), validated with v1's harness spec, encoded, and read back with
 * {@link HarnessYamlSchema}. Anything that doesn't survive that round trip unchanged
 * is reported as a problem rather than silently changing the deployed harness.
 */
export function harnessJsonToYaml(
  raw: unknown,
  file: string,
): { yaml?: string; problems: MigrationProblem[]; facts?: V0HarnessSpec } {
  const v0 = V0HarnessSpecSchema.safeParse(raw);
  if (!v0.success) return { problems: problemsFromZodError(file, raw, v0.error) };
  const facts = v0.data;

  const v1 = HarnessSpecSchema.safeParse(v0.data);
  if (!v1.success) return { facts, problems: problemsFromZodError(file, v0.data, v1.error) };
  const dropped = droppedPaths(v0.data, v1.data);
  if (dropped.length > 0) {
    return {
      facts,
      problems: dropped.map((path) => ({
        file,
        path: describePath(v0.data, path),
        message: "v1 harnesses don't support this field",
      })),
    };
  }

  const yaml = YAML_HEADER + stringify(encodeHarnessYaml(v1.data));
  const decoded = HarnessYamlSchema.safeParse(parse(yaml));
  if (!decoded.success) {
    return {
      facts,
      problems: problemsFromZodError(file, v1.data, decoded.error).map((problem) => ({
        ...problem,
        message: `can't be written to harness.yaml: ${problem.message}`,
      })),
    };
  }
  const changed = changedPaths(canonical(v1.data), canonical(decoded.data));
  if (changed.length > 0) {
    return {
      facts,
      problems: changed.map((path) => ({
        file,
        path: describePath(v1.data, path),
        message: "harness.yaml can't express this value",
      })),
    };
  }
  return { yaml, facts, problems: [] };
}

/**
 * The harness spec with the codec's built-in defaults applied, so a spec and its
 * harness.yaml round trip compare equal: harness.yaml always yields a network mode
 * and an authorizer type, and an empty list of access points means none.
 */
export function canonical(spec: HarnessSpec): unknown {
  const { efsAccessPoints, s3AccessPoints, ...rest } = spec;
  return JSON.parse(
    JSON.stringify({
      ...rest,
      networkMode: rest.networkMode ?? "PUBLIC",
      authorizerType: rest.authorizerType ?? "AWS_IAM",
      efsAccessPoints: efsAccessPoints?.length ? efsAccessPoints : undefined,
      s3AccessPoints: s3AccessPoints?.length ? s3AccessPoints : undefined,
    }),
  ) as unknown;
}

/** The paths at which two JSON values differ, stopping at the first differing level. */
function changedPaths(
  expected: unknown,
  actual: unknown,
  path: PropertyKey[] = [],
): PropertyKey[][] {
  if (isDeepStrictEqual(expected, actual)) return [];
  const bothObjects =
    typeof expected === "object" &&
    expected !== null &&
    typeof actual === "object" &&
    actual !== null &&
    Array.isArray(expected) === Array.isArray(actual);
  if (!bothObjects) return [path];
  if (Array.isArray(expected) && Array.isArray(actual) && expected.length !== actual.length) {
    return [path];
  }
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...keys].flatMap((key) =>
    changedPaths(
      (expected as Record<string, unknown>)[key],
      (actual as Record<string, unknown>)[key],
      [...path, Array.isArray(expected) ? Number(key) : key],
    ),
  );
}
