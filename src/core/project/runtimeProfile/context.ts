/**
 * What the derivation of the AgentCore Runtime box profile knows of a runtime: its paths there, the
 * profile `agentcore create` writes for it, and where the local profile sets each key.
 */
import { posix } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ScaffoldRuntimeInput } from "../../../handlers/project/types";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import { renderBoxProfile, runtimeAgentTemplate } from "../templates/boxProfile";
import {
  RUNTIME_INPUTS,
  type RuntimePaths,
  type RuntimeProfileContext,
  type TomlTable,
} from "./types";

const WORKSPACE = "${{ workspace }}";
const HOME = "${{ home }}";

/**
 * Where the paths of the local profile of `runtime` are on AgentCore Runtime. A container image runs
 * the profile in /app, its workspace, under `agentcore dev` and on the Runtime alike, so each path
 * stays. A CodeZip runtime runs it in the project folder under `agentcore dev`.
 */
export function runtimePaths(
  runtime: Pick<ProjectRuntime, "build" | "codeLocation">,
): RuntimePaths {
  if (runtime.build !== "CodeZip") {
    return {
      build: "Container",
      localCode: WORKSPACE,
      localVenv: `${WORKSPACE}/.venv`,
      localPythons: "/usr/local",
      runtimeCode: WORKSPACE,
      runtimePython: `${WORKSPACE}/.venv/bin/python`,
      runtimePythonPrefix: "/usr/local",
      shownCode: "/app/",
    };
  }
  const folder = posix
    .normalize(runtime.codeLocation.replace(/\\/g, "/"))
    .replace(/^\.\/|\/+$/g, "");
  const root = folder === "." || folder === "";
  const localCode = root ? WORKSPACE : `${WORKSPACE}/${folder}`;
  return {
    build: "CodeZip",
    localCode,
    localVenv: `${localCode}/.venv`,
    localPythons: `${HOME}/.local/share/uv/python`,
    runtimeCode: RUNTIME_INPUTS.codeDir,
    runtimePython: RUNTIME_INPUTS.pythonPath,
    runtimePythonPrefix: RUNTIME_INPUTS.pythonPrefix,
    shownCode: root ? "./" : `${folder}/`,
  };
}

/**
 * The profile that `agentcore create` writes for `runtime`, `local`, and the `[agent]` of its
 * Runtime form, `runtime` (runtimeAgentTemplate), as TOML tables: a rule tells the template's own
 * values from the user's by them. agentcore.json does not record the framework, and the profile
 * does not depend on it beyond the container case, so the input names Strands.
 */
export function runtimeTemplate(
  projectName: string,
  runtime: ProjectRuntime,
  region: string,
): { local: TomlTable; runtime: TomlTable } {
  const input = {
    runtimeName: runtime.name,
    build: runtime.build,
    language: "Python",
    framework: "strands",
    protocol: runtime.protocol,
    modelProvider: runtime.modelProvider,
    modelId: runtime.modelId,
    boxTemplate: true,
  } as ScaffoldRuntimeInput;
  const agent = runtimeAgentTemplate(input);
  return {
    local: parseToml(renderBoxProfile(projectName, input, region) ?? "") as TomlTable,
    runtime: agent ? { agent } : {},
  };
}

/**
 * Where the box profile `text`, at `profileFile` from the project root, sets each key: the first
 * line of each table header and each key, by the dotted path of the key (`mcp.notes.command`).
 */
export function profileKeyPlaces(text: string, profileFile: string): Map<string, string> {
  const places = new Map<string, string>();
  let table: string[] = [];
  text.split("\n").forEach((line, index) => {
    const place = `${profileFile}:${index + 1}:${line.search(/\S/) + 1}`;
    const header = /^\s*\[\[?([^\]]*)\]\]?\s*(?:#.*)?$/.exec(line);
    const assignment = header ? undefined : /^\s*([^\s=#[][^=]*?)\s*=/.exec(line);
    if (!header && !assignment) return;
    const path = header ? keyPath(header[1]!) : [...table, ...keyPath(assignment![1]!)];
    if (header) table = path;
    for (let depth = 1; depth <= path.length; depth++) {
      const key = path.slice(0, depth).join(".");
      if (!places.has(key)) places.set(key, place);
    }
  });
  return places;
}

/** The parts of a TOML key: `egress."dot.name".secret` as `["egress", "dot.name", "secret"]`. */
function keyPath(text: string): string[] {
  const parts: string[] = [];
  const part = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:\.|$)/y;
  let match: RegExpExecArray | null;
  while (part.lastIndex < text.length && (match = part.exec(text)) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3]!);
  }
  return parts;
}

/** The context of the derivation for one runtime, from what the Box network model knows. */
export function runtimeProfileContext(
  input: Omit<RuntimeProfileContext, "paths" | "template" | "placeOf"> & {
    /** Where the local profile sets each key: {@link profileKeyPlaces}. */
    readonly places: ReadonlyMap<string, string>;
  },
): RuntimeProfileContext {
  const { places, ...rest } = input;
  return {
    ...rest,
    paths: runtimePaths(input.runtime),
    template: runtimeTemplate(input.spec.name, input.runtime, input.region),
    placeOf: (key) => {
      for (let depth = key.length; depth > 0; depth--) {
        const place = places.get(key.slice(0, depth).join("."));
        if (place !== undefined) return place;
      }
      return input.profileFile;
    },
  };
}
