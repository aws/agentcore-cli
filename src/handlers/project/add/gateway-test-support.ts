import { join } from "node:path";
import { createRootHandler } from "../../index";
import {
  createSilentLogger,
  initProject,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { DEFAULT_CREATE_RUNTIME_NAME } from "../create";
import { getBoxGatewayBedrockEntry } from "../shortcuts";

/**
 * The Box gateway entry (`agent-box`, with the Bedrock target) that `agentcore create
 * --template agent-python-minimal` declares for its Bedrock agent, so every harness project
 * starts with it at index 0.
 */
export const DEFAULT_BOX_GATEWAY = getBoxGatewayBedrockEntry(DEFAULT_CREATE_RUNTIME_NAME);

export async function projectSpec(projectRoot: string) {
  return Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
}

export async function writeProjectSpec(projectRoot: string, spec: unknown): Promise<void> {
  await Bun.write(
    join(projectRoot, "agentcore", "agentcore.json"),
    JSON.stringify(spec, undefined, 2),
  );
}

/**
 * Removes the Box gateway entry that a templated project starts with, for
 * a test about a project that has no gateways at all.
 */
export async function removeDefaultBoxGateway(projectRoot: string): Promise<void> {
  const spec = await projectSpec(projectRoot);
  spec.agentCoreGateways = spec.agentCoreGateways.filter(
    (gateway: { name: string }) => gateway.name !== DEFAULT_BOX_GATEWAY.name,
  );
  await writeProjectSpec(projectRoot, spec);
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
