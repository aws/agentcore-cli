import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootHandler } from "../../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";

export function createPaymentProjectTestHarness(directoryPrefix: string) {
  const originalCwd = process.cwd();
  const tempDirectories: string[] = [];

  async function run(args: string[]) {
    const io = testIO();
    const root = createRootHandler(new TestCoreClient(), {
      io: io.io,
      globalConfigAccessor: new TestGlobalConfigAccessor(),
      logger: createSilentLogger(),
    });
    await root.route(["node", "agentcore", "project", ...args]);
    return io;
  }

  async function inProject(name = "TestProject"): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), `agentcore-${directoryPrefix}-`));
    tempDirectories.push(directory);
    process.chdir(directory);
    await run([
      "create",
      "--name",
      name,
      "--template",
      "agent-python",
      "--skip-install",
      "--skip-git",
    ]);
    const projectRoot = join(directory, name);
    process.chdir(projectRoot);
    return projectRoot;
  }

  async function projectSpec(projectRoot: string) {
    return Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
  }

  async function writeProjectSpec(projectRoot: string, spec: unknown): Promise<void> {
    await Bun.write(
      join(projectRoot, "agentcore", "agentcore.json"),
      JSON.stringify(spec, undefined, 2),
    );
  }

  async function cleanup(): Promise<void> {
    process.chdir(originalCwd);
    await Promise.all(
      tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  }

  return { cleanup, inProject, projectSpec, run, writeProjectSpec };
}
