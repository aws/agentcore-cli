import type { z } from "zod";
import type { MigrationProblem } from "../../../handlers/project/migrate/types";

/**
 * Renders a field path inside `root` for a person to find: array entries are named
 * by their `name` field where they have one, so `credentials.5.name` reads
 * `credentials[svc_client_secret].name`.
 */
export function describePath(root: unknown, path: readonly PropertyKey[]): string {
  let current: unknown = root;
  let rendered = "";
  for (const segment of path) {
    const key = typeof segment === "symbol" ? segment.toString() : segment;
    if (Array.isArray(current) && typeof key === "number") {
      const element: unknown = current[key];
      const name =
        typeof element === "object" && element !== null
          ? (element as { name?: unknown }).name
          : undefined;
      rendered += typeof name === "string" ? `[${name}]` : `[${key}]`;
      current = element;
      continue;
    }
    rendered += rendered === "" ? String(key) : `.${String(key)}`;
    current =
      typeof current === "object" && current !== null
        ? (current as Record<string, unknown>)[String(key)]
        : undefined;
  }
  return rendered === "" ? "(top level)" : rendered;
}

/** One problem per zod issue, with its path described against the input that failed. */
export function problemsFromZodError(
  file: string,
  input: unknown,
  error: z.ZodError,
): MigrationProblem[] {
  return error.issues.map((issue) => ({
    file,
    path: describePath(input, issue.path),
    message: issue.message,
  }));
}

/**
 * The paths of every value in `before` that has no counterpart in `after`: what a
 * schema's parse stripped. Arrays are compared index by index, which holds because
 * parsing never reorders them.
 */
export function droppedPaths(
  before: unknown,
  after: unknown,
  path: PropertyKey[] = [],
): PropertyKey[][] {
  if (Array.isArray(before)) {
    if (!Array.isArray(after)) return [];
    return before.flatMap((element, index) =>
      droppedPaths(element, after[index], [...path, index]),
    );
  }
  if (typeof before !== "object" || before === null) return [];
  if (typeof after !== "object" || after === null || Array.isArray(after)) return [];
  return Object.entries(before).flatMap(([key, value]) => {
    if (value === undefined) return [];
    if (!(key in after)) return [[...path, key]];
    return droppedPaths(value, (after as Record<string, unknown>)[key], [...path, key]);
  });
}
