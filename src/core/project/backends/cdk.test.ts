import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { createSilentLogger } from "../../../testing";
import type { Project, ProjectEvent } from "../../../handlers/project/types";
import { CdkBackend } from "./cdk";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function project(withDependencies = true): Promise<Project> {
  const rootPath = await mkdtemp(join(tmpdir(), "agentcore-cdk-backend-"));
  tempDirectories.push(rootPath);
  const cdkDir = join(rootPath, "agentcore", "cdk");
  await mkdir(withDependencies ? join(cdkDir, "node_modules") : cdkDir, { recursive: true });
  return {
    name: "example",
    rootPath,
    spec: ProjectSpecSchema.parse({ name: "example", version: 1 }),
  };
}

async function drain(generator: AsyncGenerator<ProjectEvent, void>): Promise<ProjectEvent[]> {
  const events: ProjectEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

describe("CdkBackend.build", () => {
  test("compiles and synthesizes through the generated CDK script", async () => {
    const commands: { command: string[]; cwd: string }[] = [];
    const subject = new CdkBackend({
      logger: createSilentLogger(),
      runner: async (command, { cwd }) => {
        commands.push({ command, cwd });
      },
      checkTool: async () => {},
    });
    const input = await project();

    expect(await drain(subject.build(input))).toEqual([
      { message: "Synthesizing CloudFormation templates" },
    ]);
    expect(commands).toEqual([
      {
        command: ["npm", "run", "cdk", "--", "synth", "--quiet"],
        cwd: join(input.rootPath, "agentcore", "cdk"),
      },
    ]);
  });

  test("fails actionably when CDK dependencies are missing", async () => {
    const commands: string[][] = [];
    const subject = new CdkBackend({
      logger: createSilentLogger(),
      runner: async (command) => {
        commands.push(command);
      },
      checkTool: async () => {},
    });

    await expect(drain(subject.build(await project(false)))).rejects.toThrow(/npm install/);
    expect(commands).toEqual([]);
  });

  test("propagates synthesis failures", async () => {
    const subject = new CdkBackend({
      logger: createSilentLogger(),
      runner: async () => {
        throw new Error("cdk synth exploded");
      },
      checkTool: async () => {},
    });

    await expect(drain(subject.build(await project()))).rejects.toThrow("cdk synth exploded");
  });
});
