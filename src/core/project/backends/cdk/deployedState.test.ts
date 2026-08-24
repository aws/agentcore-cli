import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Project } from "../../../../handlers/project/types";
import { FsReadWriteJson } from "../../../../io";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";
import { createSilentLogger } from "../../../../testing";
import { DEPLOYED_STATE_RELATIVE_PATH, writeDeployedCredentials } from "./deployedState";

const json = new FsReadWriteJson({ logger: createSilentLogger() });
const PROVISIONED = { "openai-key": { credentialProviderArn: "arn:apikey:openai-key" } };

const tempDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function project(): Promise<Project> {
  const rootPath = await mkdtemp(join(tmpdir(), "agentcore-deployed-state-"));
  tempDirectories.push(rootPath);
  return {
    name: "example",
    rootPath,
    spec: ProjectSpecSchema.parse({ name: "example", version: 1 }),
  };
}

function statePath(input: Project): string {
  return join(input.rootPath, DEPLOYED_STATE_RELATIVE_PATH);
}

async function readState(input: Project): Promise<unknown> {
  return JSON.parse(await Bun.file(statePath(input)).text());
}

describe("writeDeployedCredentials", () => {
  test("creates the state file and its .cli directory", async () => {
    const input = await project();

    await writeDeployedCredentials(json, input, "default", PROVISIONED);

    expect(await readState(input)).toEqual({
      targets: { default: { resources: { credentials: PROVISIONED } } },
    });
  });

  test("writes nothing when there are no credentials and no state file", async () => {
    const input = await project();

    await writeDeployedCredentials(json, input, "default", {});

    expect(existsSync(statePath(input))).toBe(false);
  });

  test("preserves other targets and other resource kinds", async () => {
    const input = await project();
    await json.write(statePath(input), {
      targets: {
        prod: { resources: { credentials: { other: { credentialProviderArn: "arn:prod" } } } },
        default: {
          resources: {
            runtimes: { hello: { runtimeId: "r-1", runtimeArn: "arn:r", roleArn: "arn:role" } },
            stackName: "AgentCore-example-default",
          },
        },
      },
    });

    await writeDeployedCredentials(json, input, "default", PROVISIONED);

    expect(await readState(input)).toEqual({
      targets: {
        prod: { resources: { credentials: { other: { credentialProviderArn: "arn:prod" } } } },
        default: {
          resources: {
            runtimes: { hello: { runtimeId: "r-1", runtimeArn: "arn:r", roleArn: "arn:role" } },
            stackName: "AgentCore-example-default",
            credentials: PROVISIONED,
          },
        },
      },
    });
  });

  test("drops a credential the project no longer declares", async () => {
    const input = await project();
    await json.write(statePath(input), {
      targets: {
        default: {
          resources: {
            credentials: {
              "openai-key": { credentialProviderArn: "arn:stale" },
              removed: { credentialProviderArn: "arn:removed" },
            },
          },
        },
      },
    });

    await writeDeployedCredentials(json, input, "default", PROVISIONED);

    expect(await readState(input)).toEqual({
      targets: { default: { resources: { credentials: PROVISIONED } } },
    });
  });

  test("clears the credentials map when the project declares none", async () => {
    const input = await project();
    await json.write(statePath(input), {
      targets: { default: { resources: { credentials: PROVISIONED, stackName: "keep-me" } } },
    });

    await writeDeployedCredentials(json, input, "default", {});

    expect(await readState(input)).toEqual({
      targets: { default: { resources: { stackName: "keep-me" } } },
    });
  });
});
