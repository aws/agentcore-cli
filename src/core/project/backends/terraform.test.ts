import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, ProjectEvent } from "../../../handlers/project/types";
import type { ProcessRunner, RunProcessOptions } from "../../../io";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { createSilentLogger } from "../../../testing";
import { TerraformBackend, type TerraformBackendConfig } from "./terraform";
import { TerraformState } from "./terraform/state";

const TARGET = { name: "default", account: "111122223333", region: "us-east-1" } as const;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function project(): Promise<Project> {
  const rootPath = await mkdtemp(join(tmpdir(), "agentcore-terraform-"));
  directories.push(rootPath);
  return {
    name: "example",
    rootPath,
    spec: ProjectSpecSchema.parse({
      name: "example",
      version: 2,
      managedBy: "Terraform",
      memories: [{ name: "memory", eventExpiryDuration: 30 }],
    }),
  };
}

async function drain<T>(events: AsyncGenerator<ProjectEvent, T>): Promise<T> {
  for (;;) {
    const next = await events.next();
    if (next.done) return next.value;
  }
}

function backend(overrides: Partial<TerraformBackendConfig> = {}) {
  return new TerraformBackend({
    logger: createSilentLogger(),
    checkTool: async () => {},
    runner: async () => {},
    resolveCredentials: async () => async () => ({
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
      sessionToken: "test-session",
    }),
    resolveAccount: async () => TARGET.account,
    packageAssets: async () => ({ runtimes: {}, gatewayTargets: {} }),
    ...overrides,
  });
}

const input = { target: TARGET, confirmTeardown: async () => true };

describe("Terraform lifecycle", () => {
  test("build validates locally without resolving AWS credentials", async () => {
    const p = await project();
    const commands: string[][] = [];
    const b = backend({
      runner: async (command) => {
        commands.push(command);
      },
      resolveCredentials: async () => {
        throw new Error("unexpected credential resolution");
      },
    });
    await drain(b.build(p));
    expect(commands.map((command) => command[1])).toEqual(["init", "validate"]);
    expect(commands[0]).toContain("-backend=false");
    const compiled = await readFile(
      join(new TerraformState(p, "build").directory, "main.tf.json"),
      "utf8",
    );
    expect(compiled).toContain("000000000000");
  });

  test("applies the saved plan and resolves resources from target state", async () => {
    const p = await project();
    const calls: { command: string[]; options: RunProcessOptions }[] = [];
    const runner: ProcessRunner = async (command, options) => {
      calls.push({ command, options });
      if (command[1] === "apply") {
        await writeFile(
          join(options.cwd, "terraform.tfstate"),
          JSON.stringify({
            resources: [{ mode: "managed" }],
            outputs: {
              memory_arn: {
                value: "arn:aws:bedrock-agentcore:us-east-1:111122223333:memory/example-123",
              },
              project_resources: {
                value: [{ resourceType: "memory", name: "memory", id: "example-123" }],
              },
            },
          }),
        );
      }
    };
    const b = backend({ runner });
    const result = await drain(b.deploy(p, input));
    expect(calls.map(({ command }) => command[1])).toEqual(["init", "validate", "plan", "apply"]);
    expect(calls.at(-1)!.command.at(-1)).toBe("deployment.tfplan");
    expect(calls[2]!.command).toContain("-out=deployment.tfplan");
    expect(calls.every(({ options }) => options.env?.AWS_SESSION_TOKEN === "test-session")).toBe(
      true,
    );
    expect(result.outputs.memory_arn).toContain(":memory/");
    expect(await b.resolveProjectResources(p, input)).toEqual([
      { resourceType: "memory", name: "memory", deploymentState: "deployed", id: "example-123" },
    ]);
    expect(
      existsSync(join(new TerraformState(p, TARGET).directory, ".agentcore-operation.lock")),
    ).toBe(false);
  });

  test("does not invoke Terraform when credentials belong to another account", async () => {
    const p = await project();
    let invoked = false;
    const b = backend({
      resolveAccount: async () => "999900001111",
      runner: async () => {
        invoked = true;
      },
    });
    await expect(drain(b.deploy(p, input))).rejects.toThrow("expects AWS account");
    expect(invoked).toBe(false);
  });

  test.each(["init", "validate", "plan", "apply"])(
    "preserves state and releases lock after %s fails",
    async (failure) => {
      const p = await project();
      const state = new TerraformState(p, TARGET);
      await mkdir(state.directory, { recursive: true });
      const stateText = JSON.stringify({ resources: [{ mode: "managed" }], outputs: {} });
      await writeFile(join(state.directory, "terraform.tfstate"), stateText);
      const calls: string[] = [];
      const b = backend({
        runner: async (command) => {
          calls.push(command[1]!);
          if (command[1] === failure) throw new Error("simulated failure");
        },
      });
      await expect(drain(b.deploy(p, input))).rejects.toThrow("simulated failure");
      expect(await readFile(join(state.directory, "terraform.tfstate"), "utf8")).toBe(stateText);
      expect(existsSync(join(state.directory, ".agentcore-operation.lock"))).toBe(false);
      expect(calls.at(-1)).toBe(failure);
    },
  );

  test("an empty project requires confirmation even after a partial apply without outputs", async () => {
    const p = await project();
    p.spec.memories = [];
    const state = new TerraformState(p, TARGET);
    await mkdir(state.directory, { recursive: true });
    await writeFile(
      join(state.directory, "terraform.tfstate"),
      JSON.stringify({
        resources: [{ mode: "managed" }],
        outputs: {},
      }),
    );
    let invoked = false;
    const b = backend({
      runner: async () => {
        invoked = true;
      },
    });
    await expect(
      drain(b.deploy(p, { target: TARGET, confirmTeardown: async () => false })),
    ).rejects.toThrow("cancelled");
    expect(invoked).toBe(false);
  });

  test("refuses to adopt a recorded CDK deployment", async () => {
    const p = await project();
    await mkdir(join(p.rootPath, "agentcore", ".cli"), { recursive: true });
    await writeFile(
      join(p.rootPath, "agentcore", ".cli", "deployed-state.json"),
      JSON.stringify({
        targets: { default: { resources: { stackName: "existing-stack" } } },
      }),
    );
    let packaged = false;
    const b = backend({
      packageAssets: async () => {
        packaged = true;
        return { runtimes: {}, gatewayTargets: {} };
      },
    });
    await expect(drain(b.deploy(p, input))).rejects.toThrow(
      "automatic migration or adoption is not supported",
    );
    expect(packaged).toBe(false);
  });

  test("isolates state by account and region and excludes removed declarations", async () => {
    const p = await project();
    const state = new TerraformState(p, TARGET);
    await mkdir(state.directory, { recursive: true });
    await writeFile(
      join(state.directory, "terraform.tfstate"),
      JSON.stringify({
        outputs: {
          project_resources: { value: [{ resourceType: "memory", name: "memory", id: "old" }] },
        },
      }),
    );
    const b = backend();
    expect(
      await b.resolveProjectResources(p, { target: { ...TARGET, region: "us-west-2" } }),
    ).toEqual([{ resourceType: "memory", name: "memory", deploymentState: "local-only" }]);
    p.spec.memories = [];
    expect(await b.resolveProjectResources(p, input)).toEqual([]);
  });

  test("exclusive lock covers the whole operation", async () => {
    const p = await project();
    const state = new TerraformState(p, TARGET);
    const unlock = await state.lock();
    try {
      await expect(drain(backend().deploy(p, input))).rejects.toThrow("Another operation owns");
    } finally {
      await unlock();
    }
  });

  test.each([true, false])(
    "honors transactionSearch=%s after a successful plan",
    async (enabled) => {
      const p = await project();
      const calls: string[] = [];
      const b = backend({
        runner: async (command) => {
          calls.push(command[1]!);
        },
        enableTransactionSearch: async () => {
          calls.push("transaction-search");
        },
      });
      await drain(b.deploy(p, { ...input, transactionSearch: enabled }));
      expect(calls).toEqual(
        enabled
          ? ["init", "validate", "plan", "transaction-search", "apply"]
          : ["init", "validate", "plan", "apply"],
      );
    },
  );
});
