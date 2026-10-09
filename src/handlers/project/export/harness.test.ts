import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentCoreCLIError } from "../../../errors";
import { ExecutionRoleSourceReader } from "../../../core/executionRoleSource";
import type { IAMClient } from "@aws-sdk/client-iam";
import { createRootHandler } from "../../index";
import {
  createSilentLogger,
  initProject,
  inTempDirectory,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  type TestIOOptions,
} from "../../../testing";

const HARNESS_ARN = "arn:aws:bedrock-agentcore:us-west-2:111122223333:harness/h-abc123";

function serviceHarness(harnessName = "RemoteHarness") {
  return {
    harness: {
      harnessName,
      executionRoleArn: "arn:aws:iam::111122223333:role/HarnessRole",
      model: { bedrockModelConfig: { modelId: "us.amazon.nova-lite-v1:0" } },
    },
  } as never;
}

function testExportCommand(ioOptions: TestIOOptions = {}) {
  const core = new TestCoreClient();
  // A fresh root per invocation, so wiring-time state (e.g. the add router's
  // pinned cwd) always reflects the directory the test has cd'd into. The core
  // client is shared so mock responses and recorded calls span invocations.
  const route = (args: string[]) => {
    const io = testIO(ioOptions);
    const root = createRootHandler(core, {
      io: io.io,
      globalConfigAccessor: new TestGlobalConfigAccessor(),
      logger: createSilentLogger(),
    });
    subject.io = io;
    return root.route(["node", "agentcore", ...args]);
  };
  const subject = {
    /** IO captured for the most recent invocation. */
    io: undefined as unknown as ReturnType<typeof testIO>,
    core,
    project: (args: string[]) => route(args),
    run: (args: string[] = []) => route(["export", "harness", ...args]),
  };
  return subject;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

/** Scaffolds a project with one harness named `exportme` and cds into it. */
async function inProjectWithHarness(
  subject: ReturnType<typeof testExportCommand>,
): Promise<string> {
  const { projectRoot, cleanup } = await initProject({
    name: "orders",
    flags: ["--template", "agent-python-minimal"],
  });
  cleanups.push(cleanup);
  await subject.project([
    "add",
    "harness",
    "--name",
    "exportme",
    "--model",
    JSON.stringify({ provider: "bedrock", modelId: "us.amazon.nova-lite-v1:0", maxTokens: 256 }),
    "--system-prompt",
    "You are a terse assistant.",
    "--memory",
    '{"mode":"disabled"}',
  ]);
  return projectRoot;
}

describe("project export harness handler", () => {
  test("captures paginated source IAM at the SDK boundary and writes opaque policies", async () => {
    const subject = testExportCommand();
    const projectRoot = await inProjectWithHarness(subject);
    const roleArn = "arn:aws:iam::111122223333:role/path/HarnessRole";
    const boundary = "arn:aws:iam::111122223333:policy/boundary";
    const managed = "arn:aws:iam::111122223333:policy/source";
    const document = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Deny",
          Action: "s3:*",
          NotResource: "arn:aws:s3:::allowed/*",
          Condition: { StringEquals: { "aws:PrincipalTag/team": "agents%team" } },
        },
      ],
    };
    const replies: unknown[] = [
      { Role: { Arn: roleArn, PermissionsBoundary: { PermissionsBoundaryArn: boundary } } },
      { PolicyNames: ["Original"], IsTruncated: true, Marker: "next" },
      { PolicyDocument: encodeURIComponent(JSON.stringify(document)) },
      { PolicyNames: [], IsTruncated: false },
      { AttachedPolicies: [{ PolicyArn: managed }], IsTruncated: false },
      {
        Tags: [
          { Key: "team", Value: "agents" },
          { Key: "aws:cloudformation:stack-name", Value: "source" },
        ],
        IsTruncated: false,
      },
    ];
    const calls: { name: string; input: unknown }[] = [];
    const reader = new ExecutionRoleSourceReader({
      iam: () =>
        ({
          send: async (command: { constructor: { name: string }; input: unknown }) => {
            calls.push({ name: command.constructor.name, input: command.input });
            return replies.shift();
          },
        }) as unknown as IAMClient,
    });
    subject.core.executionRoleSource.read = reader.read.bind(reader);
    subject.core.harness.setGetResponse({
      harness: {
        arn: HARNESS_ARN,
        harnessName: "source",
        executionRoleArn: roleArn,
        model: { bedrockModelConfig: { modelId: "us.amazon.nova-lite-v1:0" } },
      },
    } as never);
    await subject.run(["--arn", HARNESS_ARN, "--json"]);
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    const exported = spec.runtimes.find(
      (runtime: { name: string }) => runtime.name === "sourceAgent",
    );
    expect(exported).toMatchObject({
      bindingMode: "explicit",
      executionRoleConfig: {
        policyMode: "explicit",
        permissionsBoundaryArn: boundary,
        tags: { team: "agents" },
      },
      additionalPolicies: ["source-role-Original.json", managed],
    });
    expect(
      await Bun.file(join(projectRoot, "app", "sourceAgent", "source-role-Original.json")).json(),
    ).toEqual(document);
    expect(calls).toContainEqual({
      name: "ListRolePoliciesCommand",
      input: { RoleName: "HarnessRole", Marker: "next" },
    });
    expect(calls.some((call) => call.name === "GetPolicyVersionCommand")).toBe(false);
    expect(replies).toEqual([]);
  });

  test("does not export when source IAM capture fails", async () => {
    const subject = testExportCommand();
    const projectRoot = await inProjectWithHarness(subject);
    subject.core.harness.setGetResponse({
      harness: {
        harnessName: "source",
        executionRoleArn: "arn:aws:iam::111122223333:role/source",
        model: { bedrockModelConfig: { modelId: "us.amazon.nova-lite-v1:0" } },
      },
    } as never);
    subject.core.executionRoleSourceError = new Error("AccessDenied");
    const before = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).text();
    await expect(subject.run(["--arn", HARNESS_ARN])).rejects.toThrow("AccessDenied");
    expect(existsSync(join(projectRoot, "app", "sourceAgent"))).toBe(false);
    expect(await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).text()).toBe(before);
  });

  test("exports conventional prompt file contents as literal text", async () => {
    const prompt = "\uFEFFREADME.md\r\n";
    const subject = testExportCommand();
    const projectRoot = await inProjectWithHarness(subject);
    const directory = join(projectRoot, "app", "exportme");
    const path = join(directory, "harness.yaml");
    const yaml = await Bun.file(path).text();
    await writeFile(join(directory, "system-prompt.md"), prompt);
    await subject.run(["--name", "exportme"]);
    expect(await Bun.file(join(projectRoot, "app", "exportmeAgent", "main.py")).text()).toContain(
      `DEFAULT_SYSTEM_PROMPT = """${prompt}"""`,
    );
    expect(await Bun.file(path).text()).toBe(yaml);
    expect(await readFile(join(directory, "system-prompt.md"), "utf8")).toBe(prompt);
  });

  test.each([
    ["malformed YAML", 1],
    ["blank prompt file", 2],
  ] as const)(
    "classifies %s as customer configuration through the CLI boundary",
    async (failure, exitCode) => {
      const subject = testExportCommand();
      const projectRoot = await inProjectWithHarness(subject);
      const directory = join(projectRoot, "app", "exportme");
      const path = join(directory, "harness.yaml");
      const promptPath = join(directory, "system-prompt.md");
      if (failure === "malformed YAML") await writeFile(path, "name: [");
      else await writeFile(promptPath, " \n");
      const specPath = join(projectRoot, "agentcore", "agentcore.json");
      const before = await Bun.file(specPath).text();
      const error = await subject
        .run(["--name", "exportme", "--json"])
        .catch(AgentCoreCLIError.fromError);
      expect(error).toBeInstanceOf(AgentCoreCLIError);
      expect(error).toMatchObject({
        source: "user",
        exitCode,
      });
      expect((error as Error).message).toContain(failure === "malformed YAML" ? path : promptPath);
      expect(existsSync(join(projectRoot, "app", "exportmeAgent"))).toBe(false);
      expect(await Bun.file(specPath).text()).toBe(before);
    },
  );

  test("requires exactly one of --name and --arn", async () => {
    const subject = testExportCommand();
    await inProjectWithHarness(subject);

    await expect(subject.run([])).rejects.toThrow(/specify exactly one of --name, --arn/);
    await expect(subject.run(["--name", "exportme", "--arn", HARNESS_ARN])).rejects.toThrow(
      /specify exactly one of --name, --arn/,
    );
  });

  test("exports an in-project harness to a buildable runtime and registers it", async () => {
    const subject = testExportCommand({ isTTY: true });
    const projectRoot = await inProjectWithHarness(subject);

    await subject.run(["--name", "exportme"]);

    // Generated code reflects the harness spec.
    const agentDir = join(projectRoot, "app", "exportmeAgent");
    expect(await Bun.file(join(agentDir, "main.py")).text()).toContain(
      'DEFAULT_SYSTEM_PROMPT = """You are a terse assistant."""',
    );
    const loadModel = await Bun.file(join(agentDir, "model", "load.py")).text();
    expect(loadModel).toContain('model_id="us.amazon.nova-lite-v1:0"');
    expect(loadModel).toContain("max_tokens=256");
    expect(await Bun.file(join(agentDir, "EXPORT_NOTES.md")).text()).toContain(
      "# Export Notes — exportme → exportmeAgent",
    );

    // agentcore.json gains the runtime; the harness entry stays.
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.runtimes).toContainEqual({
      name: "exportmeAgent",
      build: "CodeZip",
      entrypoint: "main.py",
      codeLocation: "app/exportmeAgent",
      protocol: "HTTP",
      runtimeVersion: "PYTHON_3_14",
      bindingMode: "explicit",
      networkMode: "PUBLIC",
      authorizerType: "AWS_IAM",
      tags: {},
    });
    expect(spec.harnesses).toEqual([{ name: "exportme", path: "app/exportme" }]);

    // Dependencies are installed in the new agent dir.
    expect(subject.core.projectCommands).toContainEqual({
      command: ["uv", "sync"],
      cwd: agentDir,
    });

    expect(subject.io.stderr()).toContain(
      `Next steps:\n  Review the generated code in ${join("app", "exportmeAgent")}\n  agentcore build\n  agentcore deploy`,
    );
    expect(subject.io.stderr()).toContain(
      `Exported harness 'exportme' to runtime agent 'exportmeAgent' (${join("app", "exportmeAgent")})\nNext steps:`,
    );
    expect(subject.io.stderr()).toContain("✓ Writing EXPORT_NOTES.md");
    expect(subject.io.stdout()).toBe("");
  });

  test("derives the default target name and honors --target-agent-name", async () => {
    const subject = testExportCommand();
    const projectRoot = await inProjectWithHarness(subject);

    await subject.run(["--name", "exportme", "--target-agent-name", "my_agent"]);

    expect(existsSync(join(projectRoot, "app", "my_agent", "main.py"))).toBe(true);
    await expect(
      subject.run(["--name", "exportme", "--target-agent-name", "9bad"]),
    ).rejects.toThrow(/invalid --target-agent-name/);
  });

  test("refuses to overwrite an existing runtime, harness, or directory", async () => {
    const subject = testExportCommand();
    const projectRoot = await inProjectWithHarness(subject);

    // The scaffolded template runtime already owns its name.
    await expect(
      subject.run(["--name", "exportme", "--target-agent-name", "agent"]),
    ).rejects.toThrow(/runtime with name 'agent' already exists/);
    // A harness name is just as taken.
    await expect(
      subject.run(["--name", "exportme", "--target-agent-name", "exportme"]),
    ).rejects.toThrow(/harness with name 'exportme' already exists/);

    // A second export of the same harness collides with the first.
    await subject.run(["--name", "exportme"]);
    const specBefore = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).text();
    await expect(subject.run(["--name", "exportme"])).rejects.toThrow(
      /runtime with name 'exportmeAgent' already exists/,
    );
    expect(await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).text()).toBe(
      specBefore,
    );
  });

  test("fails clearly when the harness is not in the project", async () => {
    const subject = testExportCommand();
    await inProjectWithHarness(subject);

    await expect(subject.run(["--name", "nope"])).rejects.toThrow(
      /Harness 'nope' not found .* Available harnesses: exportme/,
    );
  });

  test("emits a machine-readable summary with --json", async () => {
    const subject = testExportCommand({ isTTY: true });
    const projectRoot = await inProjectWithHarness(subject);

    await subject.run(["--name", "exportme", "--json"]);

    expect(JSON.parse(subject.io.stdout())).toEqual({
      harnessName: "exportme",
      agentName: "exportmeAgent",
      agentPath: join(projectRoot, "app", "exportmeAgent"),
      notesPath: join(projectRoot, "app", "exportmeAgent", "EXPORT_NOTES.md"),
      notes: [],
    });
    expect(subject.io.stderr()).not.toContain("Next steps:");
    expect(subject.io.stderr()).not.toContain("Exported harness");
    expect(subject.io.stderr()).toContain("Writing EXPORT_NOTES.md");
    expect(subject.io.stderr()).not.toContain(String.fromCharCode(0x1b));
    expect(subject.io.stderr()).not.toContain("✓");
  });

  test("exports a service harness by ARN, fetching from the ARN's region", async () => {
    const subject = testExportCommand();
    const projectRoot = await inProjectWithHarness(subject);
    subject.core.harness.setGetResponse({
      harness: {
        harnessId: "h-abc123",
        harnessName: "remote_harness",
        arn: HARNESS_ARN,
        status: "READY",
        executionRoleArn: "arn:aws:iam::111122223333:role/HarnessRole",
        createdAt: new Date(0),
        updatedAt: new Date(0),
        model: { bedrockModelConfig: { modelId: "us.amazon.nova-lite-v1:0" } },
        systemPrompt: [{ text: "Fetched prompt." }],
        tools: [],
        skills: [],
      },
    } as never);

    await subject.run(["--arn", HARNESS_ARN, "--target-agent-name", "exported_arn"]);

    expect(subject.core.harness.calls).toEqual([
      {
        method: "getHarness",
        args: ["h-abc123", expect.objectContaining({ region: "us-west-2" })],
      },
    ]);
    expect(await Bun.file(join(projectRoot, "app", "exported_arn", "main.py")).text()).toContain(
      'DEFAULT_SYSTEM_PROMPT = """Fetched prompt."""',
    );
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.runtimes.map((runtime: { name: string }) => runtime.name)).toContain(
      "exported_arn",
    );
    expect(subject.io.stderr()).toContain(
      `Exported harness 'remote_harness' to runtime agent 'exported_arn' (${join("app", "exported_arn")})`,
    );
  });

  test("defaults the --arn target name from the fetched harness name", async () => {
    const subject = testExportCommand();
    const projectRoot = await inProjectWithHarness(subject);
    subject.core.harness.setGetResponse(serviceHarness("remote_harness"));

    await subject.run(["--arn", HARNESS_ARN]);

    expect(existsSync(join(projectRoot, "app", "remote_harnessAgent", "main.py"))).toBe(true);
  });

  /** A container harness in VPC mode, whose service VpcConfig carries no vpcId (the API has none). */
  function setVpcContainerHarness(subject: ReturnType<typeof testExportCommand>) {
    subject.core.harness.setGetResponse({
      harness: {
        harnessName: "remote_container",
        executionRoleArn: "arn:aws:iam::111122223333:role/HarnessRole",
        model: { bedrockModelConfig: { modelId: "us.amazon.nova-lite-v1:0" } },
        environmentArtifact: {
          containerConfiguration: {
            containerUri: "111122223333.dkr.ecr.us-west-2.amazonaws.com/base:latest",
          },
        },
        environment: {
          agentCoreRuntimeEnvironment: {
            networkConfiguration: {
              networkMode: "VPC",
              networkModeConfig: {
                subnets: ["subnet-0123456789abcdef0"],
                securityGroups: ["sg-0123456789abcdef0"],
              },
            },
          },
        },
      },
    } as never);
  }

  // A container harness in a VPC exports as CodeZip: no image build, so no CodeBuild and no vpcId
  // to supply. The service's subnets and security groups still carry over verbatim.
  test("exports a VPC container harness as CodeZip without additional lookups", async () => {
    const subject = testExportCommand();
    const projectRoot = await inProjectWithHarness(subject);
    setVpcContainerHarness(subject);

    await subject.run(["--arn", HARNESS_ARN]);

    expect(subject.core.harness.calls).toEqual([
      {
        method: "getHarness",
        args: ["h-abc123", expect.objectContaining({ region: "us-west-2" })],
      },
    ]);
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    const runtime = spec.runtimes.find(
      (candidate: { name: string }) => candidate.name === "remote_containerAgent",
    );
    expect(runtime.build).toBe("CodeZip");
    expect(runtime.dockerfile).toBeUndefined();
    expect(runtime.networkConfig).toEqual({
      subnets: ["subnet-0123456789abcdef0"],
      securityGroups: ["sg-0123456789abcdef0"],
    });
    expect(existsSync(join(projectRoot, "app", "remote_containerAgent", "Dockerfile"))).toBe(false);
  });

  test.each([
    [undefined, "ExportRemoteHarness"],
    ["ChosenProject", "ChosenProject"],
  ])("creates an export project with name override %s", async (override, projectName) => {
    const subject = testExportCommand();
    const { path, cleanup } = await inTempDirectory();
    cleanups.push(cleanup);
    subject.core.harness.setGetResponse(serviceHarness());
    const document = {
      Version: "2012-10-17",
      Statement: [{ Effect: "Deny", Action: "s3:*", Resource: "*" }],
    };
    subject.core.executionRoleSourcePolicies = { Source: document };

    await subject.run([
      "--arn",
      HARNESS_ARN,
      "--region",
      "us-east-1",
      "--json",
      ...(override ? ["--project-name", override] : []),
    ]);

    const projectRoot = join(path, projectName);
    const agentPath = join(projectRoot, "app", "RemoteHarnessAgent");
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.name).toBe(projectName);
    expect(spec.harnesses).toEqual([]);
    expect(await Bun.file(join(projectRoot, "agentcore", "aws-targets.json")).json()).toEqual([
      { name: "default", account: "111122223333", region: "us-west-2" },
    ]);
    expect(spec.runtimes.map((runtime: { name: string }) => runtime.name)).toEqual([
      "RemoteHarnessAgent",
    ]);
    expect(spec.runtimes[0]).toMatchObject({
      bindingMode: "explicit",
      executionRoleConfig: { policyMode: "explicit" },
      additionalPolicies: ["source-role-Source.json"],
    });
    expect(await Bun.file(join(agentPath, "source-role-Source.json")).json()).toEqual(document);
    expect(subject.core.executionRoleSourceCalls).toEqual([
      {
        roleArn: "arn:aws:iam::111122223333:role/HarnessRole",
        options: expect.objectContaining({ region: "us-west-2" }),
      },
    ]);
    expect(existsSync(join(agentPath, "main.py"))).toBe(true);
    expect(existsSync(join(projectRoot, "agentcore", "cdk", "package.json"))).toBe(true);
    expect(subject.core.projectCommands).toEqual(
      expect.arrayContaining([
        {
          command: ["npm", "install", "--loglevel=http"],
          cwd: join(projectRoot, "agentcore", "cdk"),
        },
        { command: ["git", "init"], cwd: projectRoot },
        { command: ["uv", "sync"], cwd: agentPath },
      ]),
    );
    expect(subject.core.harness.calls).toEqual([
      {
        method: "getHarness",
        args: ["h-abc123", expect.objectContaining({ region: "us-west-2" })],
      },
    ]);
    expect(JSON.parse(subject.io.stdout())).toMatchObject({
      harnessName: "RemoteHarness",
      agentName: "RemoteHarnessAgent",
      agentPath,
    });
    expect(subject.io.stderr()).not.toContain("Next steps:");
    expect(process.cwd()).toBe(path);
  });

  test.each([
    ["remote_harness", "Exportremoteharness", "customAgent"],
    ["RemoteHarnessWithAVeryLongName", "ExportRemoteHarnessWith", undefined],
  ])(
    "creates deployable default names for harness %s",
    async (harnessName, projectName, agentName) => {
      const subject = testExportCommand();
      const { path, cleanup } = await inTempDirectory();
      cleanups.push(cleanup);
      subject.core.harness.setGetResponse(serviceHarness(harnessName));

      await subject.run([
        "--arn",
        HARNESS_ARN,
        ...(agentName ? ["--target-agent-name", agentName] : []),
      ]);

      const projectRoot = join(path, projectName);
      const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
      expect(spec.name).toBe(projectName);
      const generatedName = spec.runtimes[0].name;
      expect(`${projectName}_default_${generatedName}`.length).toBeLessThanOrEqual(48);
      expect(existsSync(join(projectRoot, "app", generatedName, "main.py"))).toBe(true);
      expect(subject.io.stderr()).toContain(`  cd ${projectName}\n`);
    },
  );

  test("does not modify an existing destination directory", async () => {
    const subject = testExportCommand();
    const { path, cleanup } = await inTempDirectory();
    cleanups.push(cleanup);
    const destination = join(path, "ExportRemoteHarness");
    await mkdir(destination);
    await writeFile(join(destination, "keep.txt"), "customer content");
    subject.core.harness.setGetResponse(serviceHarness());

    await expect(subject.run(["--arn", HARNESS_ARN])).rejects.toThrow(/already exists/);

    expect(await readdir(destination)).toEqual(["keep.txt"]);
    expect(await readFile(join(destination, "keep.txt"), "utf8")).toBe("customer content");
    expect(subject.core.projectCommands).toEqual([]);
  });

  test("requires a project for --name and explains how to export a service harness", async () => {
    const subject = testExportCommand();
    const { path, cleanup } = await inTempDirectory();
    cleanups.push(cleanup);

    await expect(subject.run(["--name", "exportme"])).rejects.toThrow(
      /--name requires an AgentCore project.*--arn/,
    );

    expect(subject.core.harness.calls).toEqual([]);
    expect(await readdir(path)).toEqual([]);
  });

  test("rejects a project-name override inside an existing project", async () => {
    const subject = testExportCommand();
    await inProjectWithHarness(subject);
    await expect(subject.run(["--arn", HARNESS_ARN, "--project-name", "Other"])).rejects.toThrow(
      /only available outside/,
    );
    expect(subject.core.harness.calls).toEqual([]);
  });

  test("validates an existing project before fetching from the service", async () => {
    const subject = testExportCommand();
    const projectRoot = await inProjectWithHarness(subject);
    await writeFile(join(projectRoot, "agentcore", "agentcore.json"), "{ invalid json");

    await expect(subject.run(["--arn", HARNESS_ARN])).rejects.toThrow();

    expect(subject.core.harness.calls).toEqual([]);
  });

  test.each([
    ["service harness is missing", {}, /no harness exists/, undefined],
    ["service fetch fails", new Error("Access denied"), /Access denied/, undefined],
    [
      "service response cannot be mapped",
      { harness: { harnessName: "RemoteHarness", model: {} } },
      /no recognized model configuration/,
      undefined,
    ],
    ["source IAM capture fails", serviceHarness(), /AccessDenied/, new Error("AccessDenied")],
  ] as const)(
    "does not create a project when the %s",
    async (_failure, response, error, sourceIamError) => {
      const subject = testExportCommand();
      const { path, cleanup } = await inTempDirectory();
      cleanups.push(cleanup);
      if (response instanceof Error) subject.core.harness.setError(response);
      else subject.core.harness.setGetResponse(response as never);
      subject.core.executionRoleSourceError = sourceIamError;

      await expect(subject.run(["--arn", HARNESS_ARN])).rejects.toThrow(error);

      expect(await readdir(path)).toEqual([]);
      expect(subject.core.projectCommands).toEqual([]);
    },
  );

  test.each([
    [["--target-agent-name", "9bad"], /invalid --target-agent-name/],
    [["--target-agent-name", "RuntimeNameThatDoesNotFitTheNewProject"], /must fit within/],
    [["--project-name", "9bad"], /Project name/],
  ])("does not create a project for invalid naming %j", async (flags, error) => {
    const subject = testExportCommand();
    const { path, cleanup } = await inTempDirectory();
    cleanups.push(cleanup);
    subject.core.harness.setGetResponse(serviceHarness());

    await expect(subject.run(["--arn", HARNESS_ARN, ...flags])).rejects.toThrow(error);

    expect(await readdir(path)).toEqual([]);
    expect(subject.core.projectCommands).toEqual([]);
  });

  test("rejects a malformed --arn before calling the service", async () => {
    const subject = testExportCommand();
    await inProjectWithHarness(subject);

    await expect(subject.run(["--arn", "arn:aws:not-a-harness"])).rejects.toThrow(
      /not a valid harness ARN/,
    );
    expect(subject.core.harness.calls).toEqual([]);

    await expect(
      subject.run(["--arn", "arn:aws:lambda:us-west-2:111122223333:harness/h-abc123"]),
    ).rejects.toThrow(/not a valid harness ARN/);
    expect(subject.core.harness.calls).toEqual([]);
  });
});
