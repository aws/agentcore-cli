/**
 * The paths of the project and the home folder in a local box profile, and where each one is on a
 * CodeZip AgentCore Runtime. The refusals rule stops for a path that has no place there, and the
 * paths rule moves each other path. A container image keeps each path, so neither rule reads them.
 *
 * | Path of the local profile | On a CodeZip Runtime |
 * | --- | --- |
 * | the venv's Python, `<code>/.venv/bin/python[3[.N]]` | `${{ inputs.python.path }}` |
 * | the venv, `<code>/.venv` | `${{ inputs.code.dir }}`, where the Runtime installs the dependencies |
 * | the uv Pythons, `${{ home }}/.local/share/uv/python` | `${{ inputs.python.prefix }}` |
 * | the code folder and each path in it, `<code>[/...]` | `${{ inputs.code.dir }}[/...]` |
 * | another path of the project, of the home folder, or in the venv | none: a {@link PathProblem} |
 */
import { BOX_CODEZIP_DIST } from "../templates/boxProfile";
import type { RuntimePaths, TomlTable } from "./types";

const WORKSPACE = "${{ workspace }}";
const HOME = "${{ home }}";

/** Why a path of the local profile has no place on a CodeZip Runtime. */
export type PathProblem =
  /** A path of the project that is not in the code folder, which is all that the zip holds. */
  | "outside-code"
  /** A path in the home folder, which is empty on the Runtime. */
  | "home"
  /** A path in the venv other than the venv and its Python: the Runtime has no venv. */
  | "venv";

/**
 * The top-level keys of a profile that the path rules do not read: they hold no path of the
 * project, or another rule writes them (`egress` the gateway rule, `telemetry` the additions rule).
 * Each HTTP `[mcp.<name>]` is the gateway rule's too.
 */
const NOT_READ: ReadonlySet<string> = new Set([
  "packs",
  "policies",
  "profile",
  "egress",
  "telemetry",
]);

/** A plain TOML table: not a list, and not a date that smol-toml gives as an object. */
export function isTable(value: unknown): value is TomlTable {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** A literal for a regular expression. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The end of a file name: no more of its letters follow. A `/` can follow. */
const NAME_END = "(?![A-Za-z0-9_.+-])";

/** The end of a path: no more of it follows, not even a `/`. */
const PATH_END = "(?![A-Za-z0-9_.+/-])";

/**
 * The string `value` of the local profile, with each path of the project and of the home folder
 * where it is on a CodeZip Runtime. If one of these paths has no place there, the problem. A value
 * can hold more than one path, as a `:` list or a `--flag=<path>` does. A value with no such path
 * stays as it is.
 */
export function moveProjectPath(
  value: string,
  paths: RuntimePaths,
): string | { readonly problem: PathProblem } {
  const normal = value
    .replace(/\$\{\{\s*workspace\s*\}\}/g, () => WORKSPACE)
    .replace(/\$\{\{\s*home\s*\}\}/g, () => HOME);
  if (!normal.includes(WORKSPACE) && !normal.includes(HOME)) return value;
  const venv = literal(paths.localVenv);
  const moved = normal
    .replace(
      new RegExp(`${venv}/bin/python(?:3(?:\\.\\d+)?)?${PATH_END}`, "g"),
      () => paths.runtimePython,
    )
    .replace(new RegExp(`${venv}${PATH_END}`, "g"), () => paths.runtimeCode)
    .replace(
      new RegExp(`${literal(paths.localPythons)}${PATH_END}`, "g"),
      () => paths.runtimePythonPrefix,
    );
  if (new RegExp(`${venv}/`).test(moved)) return { problem: "venv" };
  const result = moved.replace(
    new RegExp(`${literal(paths.localCode)}${NAME_END}`, "g"),
    () => paths.runtimeCode,
  );
  if (result.includes(WORKSPACE)) return { problem: "outside-code" };
  if (result.includes(HOME)) return { problem: "home" };
  return result;
}

/**
 * `table` with `move` applied to each string that can hold a path of the project: each string of
 * each top-level key, except those of {@link NOT_READ} and of each HTTP `[mcp.<name>]`. `move` gets
 * the key of the string: a string in a list, or in a table in a list, has the key of the list. A
 * new table.
 */
export function mapProjectPaths(
  table: Readonly<TomlTable>,
  move: (value: string, key: readonly string[]) => string,
): TomlTable {
  const result: TomlTable = {};
  for (const [name, value] of Object.entries(table)) {
    if (NOT_READ.has(name)) {
      result[name] = structuredClone(value);
    } else if (name === "mcp" && isTable(value)) {
      result[name] = Object.fromEntries(
        Object.entries(value).map(([server, entry]) => [
          server,
          isTable(entry) && entry.type === "http"
            ? structuredClone(entry)
            : mapValue(entry, [name, server], false, move),
        ]),
      );
    } else {
      result[name] = mapValue(value, [name], false, move);
    }
  }
  return result;
}

function mapValue(
  value: unknown,
  key: readonly string[],
  inList: boolean,
  move: (value: string, key: readonly string[]) => string,
): unknown {
  if (typeof value === "string") return move(value, key);
  if (Array.isArray(value)) return value.map((item) => mapValue(item, key, true, move));
  if (isTable(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        mapValue(item, inList ? key : [...key, name], inList, move),
      ]),
    );
  }
  return structuredClone(value);
}

/** A table of a profile that starts one process: `[agent]`, a stdio `[mcp.<name>]`, a `[tool.<name>]`. */
export interface ProcessTable {
  /** `["agent"]`, `["mcp", "<name>"]`, or `["tool", "<name>"]`. */
  readonly key: readonly string[];
  readonly table: TomlTable;
  /** A stdio `[mcp.<name>]` or a `[tool.<name>]`, which box starts in its own leaf box. */
  readonly leaf: boolean;
}

/** Each table of `profile` that starts one process, in profile order. */
export function processTables(profile: Readonly<TomlTable>): ProcessTable[] {
  const tables: ProcessTable[] = [];
  for (const [name, value] of Object.entries(profile)) {
    if (name === "agent" && isTable(value)) tables.push({ key: [name], table: value, leaf: false });
    if ((name === "mcp" || name === "tool") && isTable(value)) {
      for (const [entry, table] of Object.entries(value)) {
        if (!isTable(table) || (name === "mcp" && table.type === "http")) continue;
        tables.push({ key: [name, entry], table, leaf: true });
      }
    }
  }
  return tables;
}

/** The program of a process table: element 0 of its `command`; absent when it names none. */
export function programOf(table: Readonly<TomlTable>): string | undefined {
  const command = table.command;
  return Array.isArray(command) && typeof command[0] === "string" ? command[0] : undefined;
}

/** Whether `program`, as a CodeZip Runtime profile names it, is on the Runtime. */
export function isRuntimeProgram(program: string, paths: RuntimePaths): boolean {
  return program === paths.runtimePython || program.startsWith(`${paths.runtimeCode}/`);
}

/** The folder of the `_ctypes` that deploy stages for the Runtime's Python. */
export function runtimeFfiPath(paths: RuntimePaths): string {
  return `${paths.runtimeCode}/${BOX_CODEZIP_DIST}/ffi`;
}

/**
 * The `PYTHONPATH` of a leaf that runs the Runtime's Python and sets none: the `_ctypes` that
 * deploy stages, then the code folder, where the Runtime installs the dependencies that the venv
 * held locally.
 */
export function runtimePythonPath(paths: RuntimePaths): string {
  return `${runtimeFfiPath(paths)}:${paths.runtimeCode}`;
}

/**
 * `filesystem` with one grant for each path in each list, at the position of the first. Two local
 * paths can move to one path, as the code folder and its venv do. A grant that is not optional
 * replaces an optional grant of the same path.
 */
export function withOneGrantForEachPath(filesystem: Readonly<TomlTable>): TomlTable {
  return Object.fromEntries(
    Object.entries(filesystem).map(([list, grants]) => {
      if (!Array.isArray(grants)) return [list, grants];
      const kept: unknown[] = [];
      const places = new Map<string, number>();
      for (const grant of grants) {
        const identity = grantIdentity(grant);
        const place = identity === undefined ? undefined : places.get(identity);
        if (place === undefined) {
          if (identity !== undefined) places.set(identity, kept.length);
          kept.push(grant);
        } else if (isOptional(kept[place]) && !isOptional(grant)) {
          kept[place] = grant;
        }
      }
      return [list, kept];
    }),
  );
}

/** What makes two grants one: the path, and each other key but `optional`. */
function grantIdentity(grant: unknown): string | undefined {
  if (typeof grant === "string") return JSON.stringify([grant, []]);
  if (!isTable(grant) || typeof grant.path !== "string") return undefined;
  const others = Object.entries(grant)
    .filter(([key]) => key !== "path" && key !== "optional")
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([grant.path, others]);
}

const isOptional = (grant: unknown) => isTable(grant) && grant.optional === true;
