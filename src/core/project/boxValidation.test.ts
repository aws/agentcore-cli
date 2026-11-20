import { describe, expect, test } from "bun:test";
import type { ProjectSpec } from "../../projectSchemas/project";
import type { ProjectRuntime } from "../../projectSchemas/runtime";
import { BOX_RELEASE } from "./backends/boxRelease";
import {
  assertBoxCodeZipRuntimesStartBox,
  assertBoxRuntimesHaveBoxVersion,
  assertNoBoxContainerSwitch,
  syncKeepsBoxEntrypoint,
  validateBoxRuntimes,
} from "./boxValidation";

/** A box runtime `agent`, as create writes it for a CodeZip box template, with `overrides`. */
function boxRuntime(overrides: Partial<ProjectRuntime> = {}): ProjectRuntime {
  return {
    name: "agent",
    build: "CodeZip",
    entrypoint: "start.py",
    codeLocation: "app/agent",
    runtimeVersion: "PYTHON_3_14",
    protocol: "HTTP",
    box: { version: BOX_RELEASE.version },
    ...overrides,
  } as ProjectRuntime;
}

/** A project with `runtime`: a Box project unless `boxProject` is false. */
function spec(runtime: ProjectRuntime, boxProject = true): ProjectSpec {
  return {
    name: "demo",
    ...(boxProject && { projectType: "box" }),
    runtimes: [runtime],
  } as unknown as ProjectSpec;
}

describe("assertBoxRuntimesHaveBoxVersion", () => {
  test.each(["Container", "CodeZip"] as const)(
    "refuses a %s runtime of a Box project with no box.version, and names the pinned release",
    (build) => {
      const { box: _box, ...runtime } = boxRuntime({ build });

      expect(() => assertBoxRuntimesHaveBoxVersion(spec(runtime as ProjectRuntime))).toThrow(
        'runtime "agent" has no box.version in agentcore.json, but every runtime of a Box ' +
          `project runs in a box. Add "box": { "version": "${BOX_RELEASE.version}" } to the ` +
          "runtime in agentcore.json, then retry.",
      );
    },
  );

  test.each([
    ["a Box project whose runtimes have box.version", spec(boxRuntime())],
    [
      "a runtime with no box.version outside a Box project",
      spec(boxRuntime({ box: undefined }), false),
    ],
  ])("accepts %s", (_, project) => {
    expect(() => assertBoxRuntimesHaveBoxVersion(project)).not.toThrow();
  });
});

describe("assertBoxCodeZipRuntimesStartBox", () => {
  test("refuses a CodeZip box runtime whose entrypoint is not start.py", () => {
    expect(() =>
      assertBoxCodeZipRuntimesStartBox(spec(boxRuntime({ entrypoint: "main.py" }))),
    ).toThrow(
      'runtime "agent" runs its agent in a box (it has box.version in agentcore.json), but its ' +
        "entrypoint is main.py, so AgentCore Runtime would run the agent with no box. Set " +
        '"entrypoint": "start.py" for the runtime in agentcore.json, and keep start.py in ' +
        "app/agent, then retry.",
    );
  });

  test.each([
    ["start.py", spec(boxRuntime())],
    ["start.py with a handler", spec(boxRuntime({ entrypoint: "start.py:main" }))],
    // A container image starts box itself, whatever its entrypoint.
    ["a container runtime", spec(boxRuntime({ build: "Container", entrypoint: "main.py" }))],
    ["a runtime with no box", spec(boxRuntime({ box: undefined, entrypoint: "main.py" }))],
    ["a runtime outside a Box project", spec(boxRuntime({ entrypoint: "main.py" }), false)],
  ])("accepts %s", (_, project) => {
    expect(() => assertBoxCodeZipRuntimesStartBox(project)).not.toThrow();
  });
});

describe("validateBoxRuntimes", () => {
  test("runs both checks", () => {
    expect(() => validateBoxRuntimes(spec(boxRuntime({ box: undefined })))).toThrow(
      "has no box.version",
    );
    expect(() => validateBoxRuntimes(spec(boxRuntime({ entrypoint: "main.py" })))).toThrow(
      "but its entrypoint is main.py",
    );
    expect(() => validateBoxRuntimes(spec(boxRuntime()))).not.toThrow();
  });
});

describe("assertNoBoxContainerSwitch", () => {
  test("refuses to make a CodeZip box runtime a container build, and names the box template", () => {
    expect(() => assertNoBoxContainerSwitch(true, boxRuntime(), "app/agent/")).toThrow(
      'runtime "agent" runs its agent in a box as a CodeZip agent, but app/agent/ has a ' +
        "Dockerfile, which would make it a container build that runs the agent with no box. " +
        "Remove the Dockerfile, or create the agent from the agent-python-strands-box-container " +
        "template, whose image starts box.",
    );
  });

  test.each([
    ["outside a Box project", false, boxRuntime()],
    ["for a runtime with no box", true, boxRuntime({ box: undefined })],
    ["for a container runtime", true, boxRuntime({ build: "Container" })],
  ])("accepts the switch %s", (_, boxProject, runtime) => {
    expect(() => assertNoBoxContainerSwitch(boxProject, runtime, "app/agent/")).not.toThrow();
  });
});

describe("syncKeepsBoxEntrypoint", () => {
  test.each([
    ["a CodeZip box runtime with start.py", true, boxRuntime(), true],
    ["a runtime outside a Box project", false, boxRuntime(), false],
    ["a runtime with no box", true, boxRuntime({ box: undefined }), false],
    [
      "a box runtime whose entrypoint is not start.py",
      true,
      boxRuntime({ entrypoint: "main.py" }),
      false,
    ],
    ["a container box runtime", true, boxRuntime({ build: "Container" }), false],
  ])("is right for %s", (_, boxProject, runtime, expected) => {
    expect(syncKeepsBoxEntrypoint(boxProject, runtime)).toBe(expected);
  });
});
