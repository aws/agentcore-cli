import { afterEach, describe, expect, mock, test } from "bun:test";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { IoMessage, IoRequest } from "@aws-cdk/toolkit-lib";
import * as toolkitLib from "@aws-cdk/toolkit-lib";
import { createSilentLogger } from "../../../../testing";
import {
  createCdkIoHost,
  createCdkRunner,
  loadCdkToolkit,
  loadBootstrapTemplate,
  performCdkOperation,
  resolveCdkCredentials,
  type CdkCredentialProvider,
  type CdkRunOptions,
  type CdkToolkit,
  type LoadedCdkToolkit,
} from "./toolkit";

const temporaryTemplates: string[] = [];
const credentials: CdkCredentialProvider = async () => ({
  accessKeyId: "access-key",
  secretAccessKey: "secret-key",
});

function runOptions(options: Partial<CdkRunOptions> = {}): CdkRunOptions {
  return {
    assemblyDirectory: "/unused",
    credentials,
    region: "us-east-1",
    ...options,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryTemplates.splice(0).map((path) => rm(dirname(path), { recursive: true, force: true })),
  );
});

function message(text: string): IoMessage<unknown> {
  return {
    time: new Date(0),
    action: "deploy",
    level: "info",
    code: "CDK_TOOLKIT_I0001",
    message: text,
    data: undefined,
  };
}

const DEPLOYED_STACK = {
  stackName: "AgentCore-orders-default",
  environment: { account: "111122223333", region: "us-east-1" },
  stackArn: "arn:aws:cloudformation:us-east-1:111122223333:stack/example/id",
  hierarchicalId: "AgentCore-orders-default",
  outputs: { RuntimeArn: "arn:runtime" },
  deleteFailures: [],
};

/**
 * @param stacks - what the Toolkit's deploy reports. Defaults to one stack; pass
 * `[]` for the resource-less path, where the Toolkit skips or deletes the stack
 * and still returns normally.
 */
function loadedToolkit(stacks: unknown[] = [DEPLOYED_STACK]) {
  const calls: { method: string; args: unknown[] }[] = [];
  const toolkit: CdkToolkit = {
    bootstrap: async (...args: Parameters<CdkToolkit["bootstrap"]>) => {
      calls.push({ method: "bootstrap", args });
      return { environments: [], duration: 0 };
    },
    fromAssemblyDirectory: async (...args: Parameters<CdkToolkit["fromAssemblyDirectory"]>) => {
      calls.push({ method: "fromAssemblyDirectory", args });
      return { produce: async () => ({}) } as never;
    },
    deploy: async (...args: Parameters<CdkToolkit["deploy"]>) => {
      calls.push({ method: "deploy", args });
      return { stacks } as never;
    },
  };
  return { calls, loaded: { lib: toolkitLib, toolkit } as LoadedCdkToolkit };
}

describe("CDK Toolkit IO", () => {
  test("routes notifications to the existing logger at debug", async () => {
    const logger = createSilentLogger();
    const debug = mock(() => {});
    logger.debug = debug;

    await createCdkIoHost(logger).notify(message("stack deployment started"));

    expect(debug).toHaveBeenCalledWith("stack deployment started");
  });

  test("answers noninteractive requests with their default response", async () => {
    const ioHost = createCdkIoHost(createSilentLogger());
    const response = await ioHost.requestResponse({
      ...message("approve security changes"),
      defaultResponse: false,
    } as IoRequest<unknown, boolean>);

    expect(response).toBe(false);
  });
});

describe("performCdkOperation", () => {
  test("bootstraps the requested environments with the existing stack parameters", async () => {
    const { calls, loaded } = loadedToolkit();

    expect(
      await performCdkOperation(
        loaded,
        { kind: "bootstrap", environments: ["aws://111122223333/us-east-1"] },
        runOptions(),
      ),
    ).toEqual({});

    expect(calls.map(({ method }) => method)).toEqual(["bootstrap"]);
    const [environments, options] = calls[0]!.args as [
      { getEnvironments: () => Promise<unknown> },
      { parameters: { parameters: Record<string, unknown> }; source?: unknown },
    ];
    expect(await environments.getEnvironments()).toEqual([
      {
        name: "aws://111122223333/us-east-1",
        account: "111122223333",
        region: "us-east-1",
      },
    ]);
    expect(options.parameters.parameters).toEqual({ createCustomerMasterKey: true });
    expect(options.source).toBeUndefined();
  });

  test("passes an explicit bootstrap template to the Toolkit", async () => {
    const { calls, loaded } = loadedToolkit();

    await performCdkOperation(
      loaded,
      {
        kind: "bootstrap",
        environments: ["aws://111122223333/us-east-1"],
        templateFile: "/tmp/bootstrap-template.yaml",
      },
      runOptions(),
    );

    expect(calls[0]!.args[1]).toMatchObject({
      source: { source: "custom", templateFile: "/tmp/bootstrap-template.yaml" },
    });
  });

  test("deploys exactly one named stack from the synthesized assembly", async () => {
    const { calls, loaded } = loadedToolkit();

    const outputs = await performCdkOperation(
      loaded,
      { kind: "deploy", stackArtifactId: "AgentCore-orders-default" },
      runOptions({ assemblyDirectory: "/workspace/agentcore/cdk/cdk.out" }),
    );

    expect(outputs).toEqual({ RuntimeArn: "arn:runtime" });
    expect(calls.map(({ method }) => method)).toEqual(["fromAssemblyDirectory", "deploy"]);
    expect(calls[0]!.args).toEqual(["/workspace/agentcore/cdk/cdk.out"]);
    expect(calls[1]!.args[1]).toMatchObject({
      stacks: {
        strategy: toolkitLib.StackSelectionStrategy.PATTERN_MUST_MATCH_SINGLE,
        patterns: ["AgentCore-orders-default"],
      },
    });
  });

  // The Toolkit returns normally after skipping *or deleting* a resource-less
  // stack, so treating an absent stack as empty outputs would report a deletion
  // as a successful deploy.
  test("fails instead of reporting empty outputs when no stack was deployed", async () => {
    const { loaded } = loadedToolkit([]);

    const deploying = performCdkOperation(
      loaded,
      { kind: "deploy", stackArtifactId: "AgentCore-orders-default" },
      runOptions({ assemblyDirectory: "/workspace/agentcore/cdk/cdk.out" }),
    );

    await expect(deploying).rejects.toThrow(
      /deployed no stack for 'AgentCore-orders-default'.*no resources.*deleted rather than updated/s,
    );
  });

  test("accepts a deployed stack that declares no outputs", async () => {
    const { loaded } = loadedToolkit([{ ...DEPLOYED_STACK, outputs: {} }]);

    const outputs = await performCdkOperation(
      loaded,
      { kind: "deploy", stackArtifactId: "AgentCore-orders-default" },
      runOptions({ assemblyDirectory: "/workspace/agentcore/cdk/cdk.out" }),
    );

    expect(outputs).toEqual({});
  });
});

describe("Toolkit loading", () => {
  test("constructs the real Toolkit without resolving credentials", async () => {
    const ioHost = createCdkIoHost(createSilentLogger());
    const provider = await resolveCdkCredentials(ioHost, "us-west-2");
    const loaded = await loadCdkToolkit(ioHost, "us-west-2", provider);

    expect(typeof provider).toBe("function");
    expect(typeof loaded.toolkit.bootstrap).toBe("function");
    expect(typeof loaded.toolkit.deploy).toBe("function");
  });

  test("loads the Toolkit with the target region and deployment credentials", async () => {
    const { loaded } = loadedToolkit();
    const regions: string[] = [];
    const providers: CdkCredentialProvider[] = [];
    const runner = createCdkRunner(createSilentLogger(), async (_ioHost, region, provider) => {
      regions.push(region);
      providers.push(provider);
      return loaded;
    });

    await runner(
      { kind: "deploy", stackArtifactId: "AgentCore-orders-default" },
      runOptions({ assemblyDirectory: "/workspace/cdk.out", region: "eu-west-1" }),
    );

    expect(regions).toEqual(["eu-west-1"]);
    expect(providers).toEqual([credentials]);
  });
});

describe("bootstrap template loading", () => {
  test("materializes and cleans up an embedded template", async () => {
    const template = await loadBootstrapTemplate([
      new File(["Resources: {}"], "lib/api/bootstrap/bootstrap-template.yaml"),
    ]);
    temporaryTemplates.push(template!.path);

    expect(await Bun.file(template!.path).text()).toBe("Resources: {}");
    await template!.cleanup();
    expect(await Bun.file(template!.path).exists()).toBe(false);
  });

  test("uses the installed Toolkit template when no file is embedded", async () => {
    expect(await loadBootstrapTemplate([])).toBeUndefined();
  });
});
