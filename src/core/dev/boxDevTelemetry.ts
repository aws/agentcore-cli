import { posix } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { TomlTable } from "../project/runtimeProfile/types";
import { otelEnvVars } from "./otel/collector";

/**
 * The box profile that `agentcore dev` runs when it collects traces: the runtime's local box profile
 * plus what sends the agent's spans and logs, and box's own records, to dev's OTEL collector. Dev
 * writes it only into git-ignored folders, so the committed profile does not change.
 *
 * | Change | Value |
 * | --- | --- |
 * | `[telemetry.agentcore_dev]` | an `otlp` target to the collector, for traces and logs, with no secret |
 * | `[agent.env]` | the OTEL variables that dev gives an agent outside a box, except every `OTEL_EXPORTER_OTLP_*` variable, which box owns and sets to its own receiver |
 * | `[agent.env] PYTHONPATH` | CodeZip, when the venv has it: the OTEL auto-instrumentation folder of the venv first, so that each Python process of the agent is instrumented, and uvicorn's reload still works |
 * | `[agent] command` | container: the venv's Python starts under `opentelemetry-instrument`, without `--reload`, because the image holds no live code |
 */

/** The folder, from the project root, of the dev-time box profile of agent `agentName`. */
export function boxDevProfileFolder(agentName: string): string {
  return posix.join("agentcore", ".cli", "box-dev", agentName);
}

/** The name of the telemetry target to dev's collector, which no target of `telemetry` has. */
export function boxDevTelemetryTargetName(telemetry: Readonly<Record<string, unknown>>): string {
  let name = "agentcore_dev";
  for (let index = 2; name in telemetry; index++) name = `agentcore_dev_${index}`;
  return name;
}

/**
 * The OTEL variables of a boxed agent under dev, as dev gives them to an agent outside a box, except
 * every `OTEL_EXPORTER_OTLP_*` variable, which box owns and sets to its own receiver.
 */
export function boxDevAgentOtelEnv(serviceName: string): Record<string, string> {
  const outsideBox = Object.entries(otelEnvVars(0)).filter(
    ([name]) => !name.startsWith("OTEL_EXPORTER_OTLP_"),
  );
  return { ...Object.fromEntries(outsideBox), OTEL_SERVICE_NAME: serviceName };
}

export type BoxDevTelemetryOptions = {
  /** The collector's base address as the box reaches it, for example `http://127.0.0.1:4318`. */
  readonly destination: string;
  /** The service name of the agent's spans: the runtime's name, as for an agent outside a box. */
  readonly serviceName: string;
  /** CodeZip: the venv's OTEL auto-instrumentation folder, put first on the agent's PYTHONPATH. */
  readonly sitecustomizeDir?: string;
  /** Container: start the venv's Python under `opentelemetry-instrument`. */
  readonly instrumentCommand?: boolean;
};

export type BoxDevTelemetryProfile = {
  /** The text of the dev-time profile. */
  readonly text: string;
  /** False when the agent command is not the venv's Python, so the agent's own spans are not made. */
  readonly agentInstrumented: boolean;
};

/** The dev-time profile of `profileText`, a runtime's local box profile (see the module comment). */
export function boxDevTelemetryProfile(
  profileText: string,
  options: BoxDevTelemetryOptions,
): BoxDevTelemetryProfile {
  const profile = parseToml(profileText) as TomlTable;
  const telemetry = table(profile.telemetry);
  telemetry[boxDevTelemetryTargetName(telemetry)] = {
    kind: "otlp",
    destination: options.destination,
    accepts: ["traces", "logs"],
    include: ["deny", "permit", "trace", "logs"],
  };
  profile.telemetry = telemetry;

  const agent = table(profile.agent);
  const env = { ...table(agent.env) } as Record<string, unknown>;
  // A value of the user's own wins, as `[agent.env]` is theirs; PYTHONPATH keeps theirs after ours.
  for (const [name, value] of Object.entries(boxDevAgentOtelEnv(options.serviceName))) {
    if (!(name in env)) env[name] = value;
  }
  let agentInstrumented = true;
  if (options.sitecustomizeDir !== undefined) {
    const existing = typeof env.PYTHONPATH === "string" ? env.PYTHONPATH : undefined;
    env.PYTHONPATH = existing
      ? `${options.sitecustomizeDir}:${existing}`
      : options.sitecustomizeDir;
  }
  if (options.instrumentCommand) {
    const command = instrumented(agent.command);
    if (command === undefined) agentInstrumented = false;
    else agent.command = command;
  }
  agent.env = env;
  profile.agent = agent;
  return { text: stringifyToml(profile), agentInstrumented };
}

/**
 * `command` with the venv's Python started under `opentelemetry-instrument`, and without uvicorn's
 * `--reload`, `--reload-dir <dir>`, and `--reload-dir=<dir>`, or undefined when its program is not
 * the venv's Python.
 */
function instrumented(command: unknown): string[] | undefined {
  if (!Array.isArray(command) || !command.every((word) => typeof word === "string")) return;
  const [program, ...rest] = command as string[];
  if (program === undefined || !program.endsWith("/.venv/bin/python")) return;
  const instrument = `${posix.dirname(program)}/opentelemetry-instrument`;
  const args: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] === "--reload" || rest[index]!.startsWith("--reload-dir=")) continue;
    if (rest[index] === "--reload-dir") {
      index++;
      continue;
    }
    args.push(rest[index]!);
  }
  return [instrument, program, ...args];
}

function table(value: unknown): TomlTable {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as TomlTable) }
    : {};
}
