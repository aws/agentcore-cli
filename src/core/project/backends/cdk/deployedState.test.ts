import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsReadWriteJson } from "../../../../io";
import { createSilentLogger } from "../../../../testing";
import {
  DEPLOYED_STATE_RELATIVE_PATH,
  readDeployedState,
  removeTargetState,
  updateTargetState,
} from "./deployedState";

const json = new FsReadWriteJson({ logger: createSilentLogger() });

const tempDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentcore-deployed-state-"));
  tempDirectories.push(root);
  return root;
}

function statePath(root: string): string {
  return join(root, DEPLOYED_STATE_RELATIVE_PATH);
}

async function readRaw(root: string): Promise<unknown> {
  return JSON.parse(await Bun.file(statePath(root)).text());
}

describe("readDeployedState", () => {
  test("returns an empty state when the file does not exist", async () => {
    const root = await projectRoot();

    expect(await readDeployedState(json, root)).toEqual({ targets: {} });
    expect(existsSync(statePath(root))).toBe(false);
  });

  test("round-trips a previously written state", async () => {
    const root = await projectRoot();

    await updateTargetState(json, root, "default", { stackArn: "arn:stack:default" });

    expect(await readDeployedState(json, root)).toEqual({
      targets: { default: { stackArn: "arn:stack:default" } },
    });
  });

  test("resolves the file under agentcore/.cli/", () => {
    expect(DEPLOYED_STATE_RELATIVE_PATH).toBe(join("agentcore", ".cli", "deployed-state.json"));
  });
});

describe("updateTargetState", () => {
  test("creates the file with the target entry", async () => {
    const root = await projectRoot();

    await updateTargetState(json, root, "default", { stackArn: "arn:stack:default" });

    expect(await readRaw(root)).toEqual({
      targets: { default: { stackArn: "arn:stack:default" } },
    });
  });

  test("preserves other targets", async () => {
    const root = await projectRoot();

    await updateTargetState(json, root, "default", { stackArn: "arn:stack:default" });
    await updateTargetState(json, root, "prod", { stackArn: "arn:stack:prod" });

    expect(await readRaw(root)).toEqual({
      targets: {
        default: { stackArn: "arn:stack:default" },
        prod: { stackArn: "arn:stack:prod" },
      },
    });
  });

  test("merges resources without dropping the stack ARN", async () => {
    const root = await projectRoot();
    const credentials = { "openai-key": { credentialProviderArn: "arn:apikey:openai-key" } };

    await updateTargetState(json, root, "default", { stackArn: "arn:stack:default" });
    await updateTargetState(json, root, "default", { resources: { credentials } });

    expect(await readRaw(root)).toEqual({
      targets: { default: { stackArn: "arn:stack:default", resources: { credentials } } },
    });
  });

  test("replaces a resource kind's map wholesale but keeps other kinds", async () => {
    const root = await projectRoot();

    await updateTargetState(json, root, "default", {
      resources: {
        credentials: { old: { credentialProviderArn: "arn:apikey:old" } },
        // A resource kind the CLI does not own must survive the merge.
        runtimes: { main: { runtimeArn: "arn:runtime:main" } },
      },
    });
    await updateTargetState(json, root, "default", {
      resources: { credentials: { fresh: { credentialProviderArn: "arn:apikey:fresh" } } },
    });

    expect(await readRaw(root)).toEqual({
      targets: {
        default: {
          resources: {
            credentials: { fresh: { credentialProviderArn: "arn:apikey:fresh" } },
            runtimes: { main: { runtimeArn: "arn:runtime:main" } },
          },
        },
      },
    });
  });

  test("preserves unknown fields inside a credential entry across an update", async () => {
    const root = await projectRoot();
    // A field a newer CLI (or the CDK app) records that this code doesn't model.
    await Bun.write(
      statePath(root),
      JSON.stringify({
        targets: {
          default: {
            resources: {
              credentials: { k: { credentialProviderArn: "arn:a", futureField: "keep" } },
            },
          },
        },
      }),
    );

    await updateTargetState(json, root, "default", { stackArn: "arn:stack:default" });

    expect(await readRaw(root)).toEqual({
      targets: {
        default: {
          stackArn: "arn:stack:default",
          resources: {
            credentials: { k: { credentialProviderArn: "arn:a", futureField: "keep" } },
          },
        },
      },
    });
  });
});

describe("removeTargetState", () => {
  test("removes only the destroyed target", async () => {
    const root = await projectRoot();
    await updateTargetState(json, root, "default", { stackArn: "arn:stack:default" });
    await updateTargetState(json, root, "prod", { stackArn: "arn:stack:prod" });

    await removeTargetState(json, root, "default");

    expect(await readRaw(root)).toEqual({
      targets: { prod: { stackArn: "arn:stack:prod" } },
    });
  });
});
