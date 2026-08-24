import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { createRootHandler } from "../../index";
import type { CreateConfigurationBundleInput, UpdateConfigurationBundleInput } from "../types";

const REGION = "us-west-2";
const COMPONENT_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/orders-agent-abc123";
const COMPONENTS = {
  [COMPONENT_ARN]: {
    configuration: {
      system_prompt: "You are an order-support assistant.",
      settings: { cite_sources: true },
    },
  },
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeTempJson(value: unknown): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "agentcore-config-bundle-"));
  dirs.push(dir);
  const path = join(dir, "components.json");
  await Bun.write(path, JSON.stringify(value));
  return path;
}

function testConfigBundleCommand(stdin?: string) {
  const core = new TestCoreClient();
  const io = testIO();
  if (stdin !== undefined) {
    io.io.stdin.push(stdin);
    io.io.stdin.push(null);
  }
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });

  return {
    core,
    stdout: io.stdout,
    route: (args: string[]) => root.route(["bun", "agentcore", ...args, "--region", REGION]),
  };
}

function callArgs(core: TestCoreClient, method: string): unknown[] {
  const call = core.eval.calls.find((candidate) => candidate.method === method);
  if (!call) throw new Error(`${method} was not called`);
  return call.args;
}

describe("eval config-bundle command hierarchy", () => {
  test("registers CRUDL and nested version list commands", () => {
    const root = createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const configBundle = root
      .children()
      .find((child) => child.name() === "eval")
      ?.children()
      .find((child) => child.name() === "config-bundle");

    expect(configBundle?.children().map((child) => child.name())).toEqual([
      "create",
      "get",
      "list",
      "update",
      "delete",
      "version",
    ]);
    expect(
      configBundle
        ?.children()
        .find((child) => child.name() === "version")
        ?.children()
        .map((child) => child.name()),
    ).toEqual(["list"]);
    expect(
      configBundle
        ?.children()
        .find((child) => child.name() === "create")
        ?.flags()
        .map((candidate) => candidate.name),
    ).toEqual(["name", "components", "branch-name", "commit-message", "kms-key-arn"]);
    expect(
      configBundle
        ?.children()
        .find((child) => child.name() === "get")
        ?.flags()
        .map((candidate) => candidate.name),
    ).toEqual(["id", "version", "branch-name"]);
    expect(
      configBundle
        ?.children()
        .find((child) => child.name() === "update")
        ?.flags()
        .map((candidate) => candidate.name),
    ).toEqual(["id", "components", "commit-message", "branch-name", "kms-key-arn"]);
    expect(
      configBundle
        ?.children()
        .find((child) => child.name() === "create")
        ?.flags()
        .find((candidate) => candidate.name === "components")?.sensitive,
    ).toBe(true);
    expect(
      configBundle
        ?.children()
        .find((child) => child.name() === "update")
        ?.flags()
        .find((candidate) => candidate.name === "components")?.sensitive,
    ).toBe(true);
    expect(
      configBundle
        ?.children()
        .find((child) => child.name() === "delete")
        ?.flags()
        .map((candidate) => candidate.name),
    ).toEqual(["id"]);
  });

  test("prints help for a bare config-bundle command", async () => {
    const { core, stdout, route } = testConfigBundleCommand();

    await route(["eval", "config-bundle", "--json"]);

    expect(stdout()).toContain("Usage: agentcore eval config-bundle");
    expect(core.eval.calls).toHaveLength(0);
  });

  for (const command of [["get"], ["list"], ["version", "list"]] as const) {
    test(`opens the TUI for a bare ${command.join(" ")} leaf`, async () => {
      const { route } = testConfigBundleCommand();

      await expect(route(["eval", "config-bundle", ...command])).rejects.toThrow(
        "interactive mode requires a TTY on stdin and stdout",
      );
    });
  }

  test("runs normal validation for a bare CLI-only command", async () => {
    const { route } = testConfigBundleCommand();

    await expect(route(["eval", "config-bundle", "create"])).rejects.toThrow(
      "required option '--name <name>' not specified",
    );
  });
});

describe("config-bundle create", () => {
  test("passes branch name, commit message, and KMS key", async () => {
    const { core, route } = testConfigBundleCommand();

    await route([
      "eval",
      "config-bundle",
      "create",
      "--name",
      "orders-prompt",
      "--components",
      JSON.stringify(COMPONENTS),
      "--branch-name",
      "feature/order-routing",
      "--commit-message",
      "Add order routing configuration",
      "--kms-key-arn",
      "arn:aws:kms:us-west-2:123456789012:key/initial",
    ]);

    expect(callArgs(core, "createConfigurationBundle")[0]).toEqual({
      bundleName: "orders-prompt",
      components: COMPONENTS,
      branchName: "feature/order-routing",
      commitMessage: "Add order routing configuration",
      kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/initial",
    } satisfies CreateConfigurationBundleInput);
  });

  test("reads components from stdin", async () => {
    const { core, route } = testConfigBundleCommand(JSON.stringify(COMPONENTS));

    await route([
      "eval",
      "config-bundle",
      "create",
      "--name",
      "orders-prompt",
      "--components",
      "-",
    ]);

    expect(callArgs(core, "createConfigurationBundle")[0]).toMatchObject({
      components: COMPONENTS,
    });
  });

  test("rejects a branch name that does not match service constraints", async () => {
    const { core, route } = testConfigBundleCommand();

    await expect(
      route([
        "eval",
        "config-bundle",
        "create",
        "--name",
        "orders-prompt",
        "--components",
        JSON.stringify(COMPONENTS),
        "--branch-name",
        "1-invalid",
      ]),
    ).rejects.toThrow(/Invalid value for option '--branch-name'/);
    expect(core.eval.calls).toHaveLength(0);
  });

  test.each([
    ["an empty map", {}],
    ["a component without configuration", { [COMPONENT_ARN]: {} }],
    [
      "an unexpected component field",
      { [COMPONENT_ARN]: { configuration: {}, description: "not accepted" } },
    ],
  ])("rejects %s", async (_name, contents) => {
    const { core, route } = testConfigBundleCommand();

    await expect(
      route([
        "eval",
        "config-bundle",
        "create",
        "--name",
        "orders-prompt",
        "--components",
        JSON.stringify(contents),
      ]),
    ).rejects.toThrow(/Invalid value for option '--components'/);
    expect(core.eval.calls).toHaveLength(0);
  });

  test("rejects malformed component JSON", async () => {
    const { core, route } = testConfigBundleCommand();

    await expect(
      route([
        "eval",
        "config-bundle",
        "create",
        "--name",
        "orders-prompt",
        "--components",
        "{not-json",
      ]),
    ).rejects.toThrow(/Invalid JSON for option '--components'/);
    expect(core.eval.calls).toHaveLength(0);
  });

  test("requires both --name and --components", async () => {
    const { core, route } = testConfigBundleCommand();

    await expect(
      route(["eval", "config-bundle", "create", "--components", JSON.stringify(COMPONENTS)]),
    ).rejects.toThrow(/--name/);
    await expect(
      route(["eval", "config-bundle", "create", "--name", "orders-prompt"]),
    ).rejects.toThrow(/--components/);
    expect(core.eval.calls).toHaveLength(0);
  });
});

describe("config-bundle get", () => {
  test("gets the latest version from an explicit branch", async () => {
    const { core, route } = testConfigBundleCommand();

    await route(["eval", "config-bundle", "get", "--id", "b-1", "--branch-name", "review-branch"]);

    expect(callArgs(core, "getConfigurationBundle").slice(0, 3)).toEqual([
      "b-1",
      undefined,
      "review-branch",
    ]);
  });
});

describe("config-bundle list", () => {
  test("passes pagination flags and renders the unmodified response", async () => {
    const { core, stdout, route } = testConfigBundleCommand();
    core.eval.setListConfigurationBundlesResponse(
      {
        bundles: [
          {
            bundleArn: "arn:bundle:b-2",
            bundleId: "b-2",
            bundleName: "second-page",
          },
        ],
        nextToken: "token-2",
      },
      "token-1",
    );

    await route(["eval", "config-bundle", "list", "--max-results", "1", "--next-token", "token-1"]);

    expect(callArgs(core, "listConfigurationBundles").slice(0, 2)).toEqual(["token-1", 1]);
    expect(JSON.parse(stdout())).toMatchObject({
      bundles: [{ bundleId: "b-2", bundleName: "second-page" }],
      nextToken: "token-2",
    });
  });
});

describe("config-bundle update", () => {
  test("passes a complete replacement component map and KMS key", async () => {
    const path = await writeTempJson(COMPONENTS);
    const { core, route } = testConfigBundleCommand();

    await route([
      "eval",
      "config-bundle",
      "update",
      "--id",
      "b-1",
      "--components",
      `file://${path}`,
      "--commit-message",
      "Replace order support configuration",
      "--kms-key-arn",
      "arn:aws:kms:us-west-2:123456789012:key/replacement",
    ]);

    expect(callArgs(core, "updateConfigurationBundle").slice(0, 2)).toEqual([
      "b-1",
      {
        branchName: "mainline",
        components: COMPONENTS,
        commitMessage: "Replace order support configuration",
        kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/replacement",
      } satisfies UpdateConfigurationBundleInput,
    ]);
  });

  test("updates an explicit branch", async () => {
    const { core, route } = testConfigBundleCommand();

    await route([
      "eval",
      "config-bundle",
      "update",
      "--id",
      "b-1",
      "--components",
      JSON.stringify(COMPONENTS),
      "--commit-message",
      "Update review branch configuration",
      "--branch-name",
      "review-branch",
    ]);

    expect(callArgs(core, "updateConfigurationBundle")[1]).toMatchObject({
      branchName: "review-branch",
    });
  });

  test("requires components even when a KMS key is provided", async () => {
    const { core, route } = testConfigBundleCommand();

    await expect(
      route([
        "eval",
        "config-bundle",
        "update",
        "--id",
        "b-1",
        "--commit-message",
        "Rotate encryption key",
        "--kms-key-arn",
        "arn:aws:kms:us-west-2:123456789012:key/replacement",
      ]),
    ).rejects.toThrow(/required option '--components <components>' not specified/);
    expect(core.eval.calls).toHaveLength(0);
  });

  test("requires a commit message", async () => {
    const path = await writeTempJson(COMPONENTS);
    const { core, route } = testConfigBundleCommand();

    await expect(
      route(["eval", "config-bundle", "update", "--id", "b-1", "--components", `file://${path}`]),
    ).rejects.toThrow(/required option '--commit-message <commit-message>' not specified/);
    expect(core.eval.calls).toHaveLength(0);
  });

  test("requires an id", async () => {
    const path = await writeTempJson(COMPONENTS);
    const { core, route } = testConfigBundleCommand();

    await expect(
      route([
        "eval",
        "config-bundle",
        "update",
        "--components",
        `file://${path}`,
        "--commit-message",
        "Replace order support configuration",
      ]),
    ).rejects.toThrow(/required option '--id <id>' not specified/);
    expect(core.eval.calls).toHaveLength(0);
  });
});

describe("config-bundle version list", () => {
  test("passes the bundle id and pagination flags", async () => {
    const { core, stdout, route } = testConfigBundleCommand();
    core.eval.setListConfigurationBundleVersionsResponse(
      {
        versions: [
          {
            bundleArn: "arn:bundle:b-1",
            bundleId: "b-1",
            versionId: "v-2",
            versionCreatedAt: new Date("2026-08-07T00:00:00Z"),
          },
        ],
      },
      "token-1",
    );

    await route([
      "eval",
      "config-bundle",
      "version",
      "list",
      "--id",
      "b-1",
      "--max-results",
      "5",
      "--next-token",
      "token-1",
    ]);

    expect(callArgs(core, "listConfigurationBundleVersions").slice(0, 3)).toEqual([
      "b-1",
      "token-1",
      5,
    ]);
    expect(JSON.parse(stdout()).versions).toEqual([
      expect.objectContaining({ bundleId: "b-1", versionId: "v-2" }),
    ]);
  });
});
