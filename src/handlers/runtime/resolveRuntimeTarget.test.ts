import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputValidationError } from "../../errors";
import { ValueContext } from "../../router";
import type { Project } from "../project/types";
import { RegionKey } from "../keys";
import type { Core } from "../types";
import { resolveRuntimeTarget } from "./resolveRuntimeTarget";

const ctx = ValueContext.EmptyContext().withValue(RegionKey, "us-east-1");
const PROJECT = { name: "Proj", rootPath: "/proj", spec: {} } as unknown as Project;
const TARGET = {
  name: "default",
  account: "111122223333",
  region: "eu-west-1",
} as const;
const RUNTIME = {
  resourceType: "runtime" as const,
  name: "agent",
  id: "proj_agent-AbC123XyZ9",
};

function stubCore(config: {
  resolve: () => Promise<Project | undefined>;
  resources?: { resourceType: "runtime" | "harness"; name: string; id: string }[];
}): { core: Core; deployedCalls: unknown[][] } {
  const deployedCalls: unknown[][] = [];
  const core = {
    projectManager: {
      resolve: config.resolve,
      resolveDeployedResources: async (project: Project, input: { target: string }) => {
        deployedCalls.push([project, input]);
        return {
          resources: config.resources ?? [RUNTIME],
          target: TARGET,
        };
      },
    },
  } as unknown as Core;
  return { core, deployedCalls };
}

describe("resolveRuntimeTarget", () => {
  test("an explicit --id wins and keeps the ambient region", async () => {
    const { core, deployedCalls } = stubCore({ resolve: async () => undefined });

    const target = await resolveRuntimeTarget(core, ctx, "explicit-id", tmpdir());

    expect(target.runtimeId).toBe("explicit-id");
    expect(target.options).toEqual({ region: "us-east-1", endpointUrl: undefined });
    expect(target.project).toBeUndefined();
    expect(deployedCalls).toHaveLength(0);
  });

  test("an explicit --id attaches project context and tolerates a broken project", async () => {
    const withProject = stubCore({ resolve: async () => PROJECT });
    expect(
      (await resolveRuntimeTarget(withProject.core, ctx, "explicit-id", "/proj/app")).project,
    ).toBe(PROJECT);

    const broken = stubCore({
      resolve: async () => {
        throw new Error("agentcore.json is corrupt");
      },
    });
    expect((await resolveRuntimeTarget(broken.core, ctx, "explicit-id", tmpdir())).project).toBe(
      undefined,
    );
  });

  test("resolves the project's default-target Runtime and deployment region", async () => {
    const { core, deployedCalls } = stubCore({ resolve: async () => PROJECT });

    const target = await resolveRuntimeTarget(core, ctx, undefined, "/proj/app");

    expect(deployedCalls).toEqual([[PROJECT, { target: "default" }]]);
    expect(target.runtimeId).toBe(RUNTIME.id);
    expect(target.options.region).toBe("eu-west-1");
    expect(target.project).toBe(PROJECT);
  });

  test("requires an explicit id when zero or multiple Runtimes are deployed", async () => {
    const none = stubCore({ resolve: async () => PROJECT, resources: [] });
    await expect(resolveRuntimeTarget(none.core, ctx, undefined, "/proj/app")).rejects.toThrow(
      "has no Runtime deployed",
    );

    const multiple = stubCore({
      resolve: async () => PROJECT,
      resources: [RUNTIME, { ...RUNTIME, name: "other", id: "other-runtime" }],
    });
    await expect(resolveRuntimeTarget(multiple.core, ctx, undefined, "/proj/app")).rejects.toThrow(
      `choose one with --id: ${RUNTIME.id}, other-runtime`,
    );
  });

  test("outside a project, a usage error demands --id", async () => {
    const { core } = stubCore({ resolve: async () => undefined });
    const outside = mkdtempSync(join(tmpdir(), "no-project-"));

    await expect(resolveRuntimeTarget(core, ctx, undefined, outside)).rejects.toThrow(
      InputValidationError,
    );
    await expect(resolveRuntimeTarget(core, ctx, undefined, outside)).rejects.toThrow(
      "required option '--id <id>' not specified",
    );
  });
});
