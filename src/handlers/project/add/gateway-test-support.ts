import { join } from "node:path";
import { createRootHandler } from "../../index";
import {
  createSilentLogger,
  initProject,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";

export async function projectSpec(projectRoot: string) {
  return Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
}

export async function writeProjectSpec(projectRoot: string, spec: unknown): Promise<void> {
  await Bun.write(
    join(projectRoot, "agentcore", "agentcore.json"),
    JSON.stringify(spec, undefined, 2),
  );
}

export function createGatewayProjectTestHarness(directoryPrefix: string) {
  const cleanups: Array<() => Promise<void>> = [];

  async function run(args: string[], stdin?: string) {
    const io = testIO();
    if (stdin !== undefined) io.io.stdin.end(stdin);
    const root = createRootHandler(new TestCoreClient(), {
      io: io.io,
      globalConfigAccessor: new TestGlobalConfigAccessor(),
      logger: createSilentLogger(),
    });
    await root.route(["node", "agentcore", ...args]);
    return io;
  }

  async function inProject(name = "TestProject"): Promise<string> {
    const { projectRoot, cleanup } = await initProject({
      name,
      flags: ["--template", "agent-python-minimal"],
      prefix: `agentcore-${directoryPrefix}-`,
    });
    cleanups.push(cleanup);
    // These tests cover generic gateway behavior, not the Box gateway. Start from a clean,
    // non-Box project: drop the project type and the Box gateway that `create` writes.
    const { projectType: _projectType, ...spec } = await projectSpec(projectRoot);
    await writeProjectSpec(projectRoot, {
      ...spec,
      agentCoreGateways: (spec.agentCoreGateways ?? []).filter(
        (gateway: { name: string }) => !gateway.name.endsWith("-box-egress"),
      ),
    });
    return projectRoot;
  }

  async function addGateway(name = "tools"): Promise<void> {
    await run(["add", "gateway", "--name", name]);
  }

  return {
    addGateway,
    cleanup: () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())),
    inProject,
    projectSpec,
    run,
    writeProjectSpec,
  };
}
