import { describe, expect, test } from "bun:test";
import type { PinnedName, PinnedResourceType } from "../../../handlers/project/migrate/types";
import { pinCollisions } from "./pinCollisions";

const pin = (resourceType: PinnedResourceType, name: string, value: string): PinnedName => ({
  resourceType,
  name,
  value,
  targets: ["default"],
});

describe("pinCollisions", () => {
  test("accepts resources whose v0 names don't line up", () => {
    expect(
      pinCollisions("P", { runtimes: [{ name: "a" }, { name: "b" }], memories: [{ name: "a" }] }, [
        pin("runtime", "a", "P_a"),
        pin("memory", "a", "P_a"),
      ]),
    ).toEqual([]);
  });

  test("rejects a resource whose v0 name another resource already claims", () => {
    // Undeployed `y` gets the v0 name P_y too: a migrated project names everything the v0 way.
    const problems = pinCollisions("P", { runtimes: [{ name: "x" }, { name: "y" }] }, [
      pin("runtime", "x", "P_y"),
    ]);
    expect(problems).toEqual([
      {
        file: "agentcore/agentcore.json",
        path: "runtimes[y]",
        message:
          'runtime "y" and runtime "x" both get the runtime name \'P_y\' (a migrated project ' +
          "keeps v0's names, which have no target segment); rename one of them before migrating",
      },
    ]);
  });

  test("rejects an agent runtime and a tool runtime that share a runtime name, deployed or not", () => {
    const spec = {
      runtimes: [{ name: "shared" }],
      toolRuntimes: [{ name: "tool", compute: { runtime: { name: "shared" } } }],
    };
    expect(pinCollisions("P", spec, []).map((problem) => problem.path)).toEqual([
      "toolRuntimes[tool]",
    ]);
    expect(
      pinCollisions("P", spec, [pin("runtime", "shared", "P_shared")]).map(
        (problem) => problem.path,
      ),
    ).toEqual(["toolRuntimes[tool]"]);
  });

  test("compares ECR repositories case-insensitively", () => {
    expect(
      pinCollisions(
        "P",
        {
          runtimes: [
            { name: "One", build: "Container" },
            { name: "one", build: "Container" },
          ],
        },
        [],
      ).map((problem) => problem.path),
    ).toEqual(["runtimes[one]"]);
  });

  test("checks evaluator and gateway-target Lambda names together", () => {
    expect(
      pinCollisions(
        "P",
        {
          evaluators: [{ name: "judge", config: { codeBased: { managed: {} } } }],
          agentCoreGateways: [
            { name: "gw", targets: [{ name: "eval-judge", compute: { host: "Lambda" } }] },
          ],
        },
        [pin("evaluator-function", "judge", "P-eval-judge")],
      ).map((problem) => problem.path),
    ).toEqual(["agentCoreGateways[gw].targets[eval-judge]"]);
  });

  test("treats a runtime's and a harness's ECR repositories as one namespace", () => {
    expect(
      pinCollisions(
        "P",
        { runtimes: [{ name: "harness-h", build: "Container" }], harnesses: [{ name: "h" }] },
        [],
      ).map((problem) => problem.path),
    ).toEqual(["harnesses[h]"]);
  });
});
