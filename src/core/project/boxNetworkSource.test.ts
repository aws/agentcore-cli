import { afterEach, describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidEnvironmentError, ProjectStateError } from "../../errors/errors";
import { boxGatewaySpec, type ProjectSpec } from "../../projectSchemas/project";
import { boxNetworkFailureMessage, readBoxNetworks } from "./boxNetworkSource";
import type { BoxProfileResolver } from "./boxProfileResolver";
import { boxShowOf, FakeBoxProfileResolver } from "./boxProfileResolver-test-support";
import { telemetryPolicyWriter } from "./boxNetworkWriters";
import { boxTelemetryPolicyFile } from "./boxTelemetry";
import { BOX_RELEASE } from "./backends/boxRelease";
import { tracesToRuntimeLogGroup } from "./templates/boxProfile";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A Box project with the runtime `agent`, with OTEL off: only the OTEL tests turn it on. */
const SPEC = {
  name: "demo",
  projectType: "box",
  runtimes: [
    {
      name: "agent",
      build: "CodeZip",
      entrypoint: "start.py",
      codeLocation: "app/agent",
      instrumentation: { enableOtel: false },
      box: { version: "1.0.0" },
    },
  ],
  memories: [],
  credentials: [],
  agentCoreGateways: [boxGatewaySpec("agent")],
} as unknown as ProjectSpec;

/** What box resolves the profile of {@link project} to: its route `api`, which has no secret. */
const API_ROUTE = { api: { destinations: ["api.example.com"] } };

/** The local box folder of the runtime `agent`, from the project root. */
const LOCAL = [".box", "agent", "local"];

/** A project root whose profile names `policies`, with `.box/agent/local/policy.dw` in it. */
async function project(policies: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "box-network-source-"));
  directories.push(root);
  await writeProfile(root, "agent", policies);
  await writeFile(join(root, ...LOCAL, "policy.dw"), "// no rule\n");
  return root;
}

/** Writes the local box profile of the runtime `agentName`, which names `policies`. */
async function writeProfile(root: string, agentName: string, policies: string[]): Promise<void> {
  await mkdir(join(root, ".box", agentName, "local"), { recursive: true });
  await writeFile(
    join(root, ".box", agentName, "local", "profile.toml"),
    `policies = ${JSON.stringify(policies)}\n[egress.api]\ndestinations = ["api.example.com"]\n`,
  );
}

/** Writes the local box profile of the runtime `quiet`, which has no route. */
async function quietProfile(root: string): Promise<void> {
  await mkdir(join(root, ".box", "quiet", "local"), { recursive: true });
  await writeFile(join(root, ".box", "quiet", "local", "profile.toml"), "# quiet\n");
}

/** {@link SPEC} with a box runtime and a bound Box gateway for each of `names` after `agent`. */
function specWith(...names: string[]): ProjectSpec {
  return {
    ...SPEC,
    runtimes: [
      ...SPEC.runtimes,
      ...names.map((name) => ({ ...SPEC.runtimes[0]!, name, codeLocation: `app/${name}` })),
    ],
    agentCoreGateways: [boxGatewaySpec("agent"), ...names.map((name) => boxGatewaySpec(name))],
  } as unknown as ProjectSpec;
}

const failuresOf = async (root: string) =>
  (await readBoxNetworks(SPEC, root, new FakeBoxProfileResolver()))[0]!.failures.map(
    ({ code, reason, place }) => ({ code, reason, place }),
  );

describe("readBoxNetworks", () => {
  test("reads box's resolution of .box/agent/local/profile.toml, in the project folder, into one model per box runtime", async () => {
    const root = await project(["policy.dw"]);
    const box = new FakeBoxProfileResolver(
      boxShowOf({ egress: API_ROUTE, policy: "// no rule\n" }),
    );

    const [network] = await readBoxNetworks(SPEC, root, box);

    expect(box.calls).toEqual([
      { projectRoot: root, profilePath: ".box/agent/local/profile.toml" },
    ]);
    expect(network?.gateway).toBe("agent-box-egress");
    expect(network?.policyFiles).toEqual(["policy.dw"]);
    // Box writes a route with no secret only as rules, and the target still takes its name.
    expect(network?.hosts.map(({ target }) => target)).toEqual(["egress-api"]);
  });

  test("derives the runtime's AgentCore Runtime profile from the text of its own local profile", async () => {
    const root = await project([]);
    await writeFile(
      join(root, ...LOCAL, "profile.toml"),
      '[limits]\nshell = { timeout = 30 }\n\n[project]\naccess = "read"\n',
    );

    const [network] = await readBoxNetworks(SPEC, root, new FakeBoxProfileResolver());

    // A key that no rule of the derivation changes reaches the Runtime profile as it is.
    expect(network?.runtimeProfile?.limits).toEqual({ shell: { timeout: 30 } });
    expect(network?.runtimeProfile?.project).toEqual({ access: "read" });
  });

  test("finds each runtime's Box gateway by boundRuntime, whatever its name", async () => {
    const root = await project([]);
    const spec = {
      ...SPEC,
      agentCoreGateways: [
        { ...boxGatewaySpec("agent"), name: "agent-box-egress", boundRuntime: undefined },
        { ...boxGatewaySpec("agent"), name: "renamed" },
      ],
    } as unknown as ProjectSpec;

    const [network] = await readBoxNetworks(
      spec,
      root,
      new FakeBoxProfileResolver(boxShowOf({ egress: API_ROUTE })),
    );

    expect(network?.gateway).toBe("renamed");
  });

  test("reads each runtime's own local box profile and policy files, one after the other", async () => {
    const root = await project(["policy.dw"]);
    await writeProfile(root, "second", ["rules.dw"]);
    await writeFile(join(root, ".box", "second", "local", "rules.dw"), "// second\n");
    await quietProfile(root);
    const egress: Record<string, Record<string, unknown>> = {
      ".box/agent/local/profile.toml": API_ROUTE,
      ".box/second/local/profile.toml": { docs: { destinations: ["docs.example.com"] } },
    };
    const calls: string[] = [];
    const resolver: BoxProfileResolver = {
      resolve: async (_root, profilePath) => {
        calls.push(profilePath);
        return boxShowOf({ egress: egress[profilePath] ?? {} });
      },
    };

    const networks = await readBoxNetworks(specWith("second", "quiet"), root, resolver);

    expect(calls).toEqual([
      ".box/agent/local/profile.toml",
      ".box/second/local/profile.toml",
      ".box/quiet/local/profile.toml",
    ]);
    expect(
      networks.map(({ runtime, gateway, hosts, policyFiles }) => [
        runtime,
        gateway,
        hosts.map(({ authority }) => authority),
        policyFiles,
      ]),
    ).toEqual([
      ["agent", "agent-box-egress", ["api.example.com"], ["policy.dw"]],
      ["second", "second-box-egress", ["docs.example.com"], ["rules.dw"]],
      ["quiet", "quiet-box-egress", [], []],
    ]);
  });

  test("grants nothing for a cloudwatch_logs target whose log group is an input, and does not stop for it", async () => {
    const root = await project([]);
    const inputs = {
      kind: "cloudwatch_logs",
      region: "${{ inputs.aws.region }}",
      log_group: "${{ inputs.runtime.log_group }}",
      log_stream: "${{ inputs.runtime.log_stream }}",
      secret: { ref: "aws://" },
    };
    const shown = boxShowOf({ egress: API_ROUTE });
    const plain = new FakeBoxProfileResolver(shown);
    const withInputs = new FakeBoxProfileResolver({
      ...shown,
      boxToml: { ...shown.boxToml, telemetry: { mine: inputs } },
    });

    const [base] = await readBoxNetworks(SPEC, root, plain);
    const [network] = await readBoxNetworks(SPEC, root, withInputs);

    // The Runtime profile sends to the runtime's own log group through inputs by default.
    const telemetry = network?.runtimeProfile?.telemetry as Record<string, unknown>;
    expect(telemetry.agentcore).toMatchObject({ log_group: "${{ inputs.runtime.log_group }}" });
    expect(network?.telemetry).toBeUndefined();
    expect(network?.failures).toEqual(base!.failures);
    expect(network?.warnings).toEqual(base!.warnings);
    const { files } = telemetryPolicyWriter.edits([network!], {
      spec: SPEC,
      projectRoot: root,
      env: {},
      envLocal: {},
    });
    expect(files).toEqual([{ path: boxTelemetryPolicyFile("agent"), remove: true }]);
  });

  test("refuses an entry whose API key credential another runtime takes for another variable", async () => {
    const root = await project([]);
    const github = (variable: string, host: string) => ({
      github: { destinations: [host], secret: { ref: `env://${variable}` } },
    });
    const profiles: Record<string, ReturnType<typeof github>> = {
      ".box/agent/local/profile.toml": github("GITHUB_TOKEN", "api.github.com"),
      ".box/second/local/profile.toml": github("OTHER_TOKEN", "api.other.example.com"),
      ".box/third/local/profile.toml": github("GITHUB_TOKEN", "uploads.github.com"),
    };
    for (const [file, egress] of Object.entries(profiles)) {
      const { destinations, secret } = egress.github;
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(
        join(root, file),
        `# ${file}\n[egress.github]\ndestinations = ${JSON.stringify(destinations)}\n` +
          `secret.ref = "${secret.ref}"\n`,
      );
    }
    const resolver: BoxProfileResolver = {
      resolve: async (_root, profilePath) => boxShowOf({ egress: profiles[profilePath] }),
    };

    const networks = await readBoxNetworks(specWith("second", "third"), root, resolver);

    expect(
      networks.map(({ failures }) => failures.map(({ code, place }) => [code, place])),
    ).toEqual([[], [["API_KEY_CREDENTIAL_SHARED", ".box/second/local/profile.toml:2:1"]], []]);
    expect(networks[1]!.failures[0]!.reason).toBe(
      "[egress.github] needs the API key credential 'github' for env://OTHER_TOKEN, and runtime " +
        "'agent' takes that credential for env://GITHUB_TOKEN. One credential holds one key. " +
        "Rename the entry in one of the two profiles.",
    );
  });

  test("refuses a telemetry target whose key variable a target of another runtime reads", async () => {
    // The two names of each pair give one variable: AGENTCORE_CREDENTIAL_AGENT_TELEMETRY_NESTED_TELEMETRY_SINK.
    const runtimes = { agent: "nested_TELEMETRY_sink", agent_TELEMETRY_nested: "sink" };
    const root = await mkdtemp(join(tmpdir(), "box-network-source-"));
    directories.push(root);
    for (const [runtime, target] of Object.entries(runtimes)) {
      await mkdir(join(root, ".box", runtime, "local"), { recursive: true });
      await writeFile(
        join(root, ".box", runtime, "local", "profile.toml"),
        `[telemetry.${target}]\nkind = "langsmith"\nsecret.ref = "env://KEY_OF_${runtime}"\n`,
      );
    }
    const resolver: BoxProfileResolver = {
      resolve: async (_root, profilePath) => {
        const [runtime] = Object.entries(runtimes).filter(([name]) =>
          profilePath.startsWith(`.box/${name}/`),
        );
        const shown = boxShowOf({});
        const telemetry = {
          [runtime![1]]: { kind: "langsmith", secret: { ref: `env://KEY_OF_${runtime![0]}` } },
        };
        return { ...shown, boxToml: { ...shown.boxToml, telemetry } };
      },
    };
    const container = { ...SPEC.runtimes[0]!, build: "Container", entrypoint: "main.py" };
    const spec = {
      ...SPEC,
      runtimes: Object.keys(runtimes).map((name) => ({
        ...container,
        name,
        codeLocation: `app/${name}`,
      })),
      agentCoreGateways: Object.keys(runtimes).map((name) => boxGatewaySpec(name)),
    } as unknown as ProjectSpec;

    const networks = await readBoxNetworks(spec, root, resolver);

    expect(
      networks.map(({ failures }) => failures.map(({ code, place }) => [code, place])),
    ).toEqual([
      [],
      [["TELEMETRY_KEY_VARIABLE_SHARED", ".box/agent_TELEMETRY_nested/local/profile.toml"]],
    ]);
    expect(networks[1]!.failures[0]!.reason).toBe(
      "[telemetry.sink] reads its key at deploy from " +
        "AGENTCORE_CREDENTIAL_AGENT_TELEMETRY_NESTED_TELEMETRY_SINK, and " +
        "[telemetry.nested_TELEMETRY_sink] of runtime 'agent' reads its key from that variable " +
        "too. Change the name of one of the two targets.",
    );
  });

  test("refuses a telemetry target whose key variable the credential of another runtime reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "box-network-source-"));
    directories.push(root);
    const egress = {
      agent_TELEMETRY_sink: { destinations: ["api.example.com"], secret: { ref: "env://TOKEN" } },
    };
    const telemetry = { sink: { kind: "langsmith", secret: { ref: "env://LANGSMITH_KEY" } } };
    for (const runtime of ["agent", "second"]) {
      await mkdir(join(root, ".box", runtime, "local"), { recursive: true });
      await writeFile(join(root, ".box", runtime, "local", "profile.toml"), "# profile\n");
    }
    const resolver: BoxProfileResolver = {
      resolve: async (_root, profilePath) => {
        if (profilePath.startsWith(".box/second/")) return boxShowOf({ egress });
        const shown = boxShowOf({});
        return { ...shown, boxToml: { ...shown.boxToml, telemetry } };
      },
    };
    const container = { ...SPEC.runtimes[0]!, build: "Container", entrypoint: "main.py" };
    const spec = {
      ...SPEC,
      runtimes: ["agent", "second"].map((name) => ({
        ...container,
        name,
        codeLocation: `app/${name}`,
      })),
      agentCoreGateways: [boxGatewaySpec("agent"), boxGatewaySpec("second")],
    } as unknown as ProjectSpec;

    const networks = await readBoxNetworks(spec, root, resolver);

    expect(networks.map(({ failures }) => failures.map(({ code }) => code))).toEqual([
      ["TELEMETRY_KEY_VARIABLE_SHARED"],
      [],
    ]);
    expect(networks[0]!.failures[0]!.reason).toBe(
      "[telemetry.sink] reads its key at deploy from AGENTCORE_CREDENTIAL_AGENT_TELEMETRY_SINK, " +
        "and the API key credential 'agent_TELEMETRY_sink' of runtime 'second' reads that " +
        "variable too. Change the name of the target.",
    );
  });

  test("takes the credential of another runtime for the credential's own variable", async () => {
    const root = await project([]);
    const profiles: Record<string, { variable: string; host: string }> = {
      ".box/agent/local/profile.toml": { variable: "GITHUB_TOKEN", host: "api.github.com" },
      ".box/second/local/profile.toml": {
        variable: "AGENTCORE_CREDENTIAL_GITHUB",
        host: "uploads.github.com",
      },
    };
    for (const [file, { variable, host }] of Object.entries(profiles)) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(
        join(root, file),
        `[egress.github]\ndestinations = ["${host}"]\nsecret.ref = "env://${variable}"\n`,
      );
    }
    const resolver: BoxProfileResolver = {
      resolve: async (_root, profilePath) => {
        const { variable, host } = profiles[profilePath]!;
        return boxShowOf({
          egress: { github: { destinations: [host], secret: { ref: `env://${variable}` } } },
        });
      },
    };

    const networks = await readBoxNetworks(specWith("second"), root, resolver);

    expect(networks.map(({ failures }) => failures)).toEqual([[], []]);
  });

  test("places a rule of a policy file at its line, and an entry at its line in the profile", async () => {
    const root = await project(["policy.dw"]);
    await writeFile(
      join(root, ...LOCAL, "profile.toml"),
      'policies = ["policy.dw"]\n\n[egress.wide]\ndestinations = ["*.wide.example.com"]\n' +
        'secret.ref = "env://KEY"\n',
    );
    const wild =
      '@id("wild") permit (principal, action == Box::Action::"http:request", resource) when { context.input.host like "*.example.com" };\n';
    await writeFile(join(root, ...LOCAL, "policy.dw"), `// every subdomain\n${wild}`);
    const box = new FakeBoxProfileResolver(
      boxShowOf({
        egress: { wide: { destinations: ["*.wide.example.com"], secret: { ref: "env://KEY" } } },
        policy: `// every subdomain\n${wild}`,
      }),
    );

    const [network] = await readBoxNetworks(SPEC, root, box);

    expect(
      network?.failures.map(({ code, ruleId, egressEntry, place }) => [
        code,
        ruleId ?? egressEntry,
        place,
      ]),
    ).toEqual([
      ["EGRESS_WILDCARD_DESTINATION", "wide", ".box/agent/local/profile.toml:3:1"],
      ["WILDCARD_HOST", "wild", ".box/agent/local/policy.dw:2:1"],
    ]);
  });

  test("runs no box for a project that is not a Box project", async () => {
    const box = new FakeBoxProfileResolver();
    const root = await project([]);

    expect(await readBoxNetworks({ ...SPEC, projectType: undefined }, root, box)).toEqual([]);
    expect(box.calls).toEqual([]);
  });

  test("stops for a box runtime with no box profile of its own, and names the profile to create", async () => {
    const box = new FakeBoxProfileResolver();
    const root = await project([]);

    const read = readBoxNetworks(specWith("second"), root, box);

    await expect(read).rejects.toBeInstanceOf(ProjectStateError);
    await expect(read).rejects.toThrow(
      'runtime "second" runs its agent in a box (it has box.version in agentcore.json), but ' +
        ".box/second/local/profile.toml does not exist. Create that box profile for the " +
        "runtime, or remove its box.version, then retry.",
    );
    expect(box.calls).toEqual([]);
  });

  test("stops with box's own error when box cannot resolve the profile", async () => {
    const refused = new InvalidEnvironmentError("box: error: a profile holds no `policy`");

    await expect(
      readBoxNetworks(SPEC, await project([]), new FakeBoxProfileResolver(refused)),
    ).rejects.toBe(refused);
  });

  test("refuses a policy file Box would refuse, each at `policies`, and says how to fix it", async () => {
    const root = await project([
      "missing.dw",
      "outside.dw",
      "linked.dw",
      "folder.dw",
      "box",
      "a b.dw",
    ]);
    const elsewhere = join(root, "elsewhere.dw");
    await writeFile(elsewhere, "// outside\n");
    await symlink(elsewhere, join(root, ...LOCAL, "outside.dw"));
    await link(join(root, ...LOCAL, "policy.dw"), join(root, ...LOCAL, "linked.dw"));
    await mkdir(join(root, ...LOCAL, "folder.dw"));

    const reasons = await failuresOf(root);
    expect(reasons.map(({ code, place }) => [code, place])).toEqual(
      Array(6).fill(["INVALID_POLICY_FILE", ".box/agent/local/profile.toml:1:1"]),
    );
    expect(reasons.map(({ reason }) => reason)).toEqual([
      "`policies` names missing.dw, but .box/agent/local/missing.dw does not exist. Create it, or " +
        "remove it from `policies`.",
      ".box/agent/local/outside.dw is a symbolic link to a file outside .box/agent/local/, which " +
        "Box does not read. Put the policy file itself in .box/agent/local/.",
      ".box/agent/local/linked.dw has 2 hard links, and Box reads only a policy file with one. " +
        "Replace it with a copy.",
      ".box/agent/local/folder.dw is a folder, not a policy file. Name a file in `policies`.",
      '.box/agent/local/box takes the name "box", which Box keeps for its own files on AgentCore ' +
        "Runtime. Rename the file.",
      '.box/agent/local/a b.dw has a character other than a letter, a digit, ".", "_", "-", or "/" ' +
        "in its path, and deploy cannot copy it to AgentCore Runtime. Rename the file.",
    ]);
  });

  test("reads a symlink that stays inside the agent's local box folder", async () => {
    const root = await project(["inner.dw"]);
    await symlink(join(root, ...LOCAL, "policy.dw"), join(root, ...LOCAL, "inner.dw"));

    expect(await failuresOf(root)).toEqual([]);
  });

  test("warns with what the resolver changed in box's state before Box resolved the profile", async () => {
    const root = await project([]);
    const note =
      'Box had bound the profile name "demo-agent" to a copy of dev. Removed its record.';
    const resolver = new FakeBoxProfileResolver({
      ...boxShowOf({ egress: API_ROUTE }),
      notes: [note],
    });

    const [network] = await readBoxNetworks(SPEC, root, resolver);

    expect(network?.warnings).toEqual([note]);
  });
});

describe("the telemetry of each box runtime", () => {
  test("comes from the runtime's own local box profile", async () => {
    const root = await project([]);
    await writeProfile(root, "second", []);
    await writeProfile(root, "quiet", []);
    const spec = {
      ...SPEC,
      runtimes: [
        ...SPEC.runtimes,
        { ...SPEC.runtimes[0]!, name: "second", codeLocation: "app/second" },
        { ...SPEC.runtimes[0]!, name: "quiet", codeLocation: "app/quiet" },
      ],
      agentCoreGateways: [
        boxGatewaySpec("agent"),
        boxGatewaySpec("second"),
        boxGatewaySpec("quiet"),
      ],
    } as unknown as ProjectSpec;
    const logs = (log_group: string) => ({
      kind: "cloudwatch_logs",
      region: "us-west-2",
      log_group,
      log_stream: "s",
      secret: { ref: "aws://default" },
    });
    const groups: Record<string, string> = {
      ".box/agent/local/profile.toml": "group-a",
      ".box/second/local/profile.toml": "group-b",
    };
    const calls: string[] = [];
    const resolver: BoxProfileResolver = {
      resolve: async (_root, profilePath) => {
        calls.push(profilePath);
        const shown = boxShowOf({ egress: API_ROUTE });
        const group = groups[profilePath];
        if (group === undefined) return shown;
        return { ...shown, boxToml: { ...shown.boxToml, telemetry: { logs: logs(group) } } };
      },
    };

    const networks = await readBoxNetworks(spec, root, resolver);

    const logsOf = (logGroup: string) => ({
      name: "logs",
      kind: "cloudwatch_logs" as const,
      region: "us-west-2",
      logGroup,
      logStream: "s",
    });
    expect(calls).toEqual([
      ".box/agent/local/profile.toml",
      ".box/second/local/profile.toml",
      ".box/quiet/local/profile.toml",
    ]);
    expect(networks.map(({ runtime, telemetry }) => [runtime, telemetry])).toEqual([
      ["agent", [logsOf("group-a")]],
      ["second", [logsOf("group-b")]],
      ["quiet", undefined],
    ]);
  });
});

describe("the default X-Ray target of a runtime with OTEL on", () => {
  const OTEL_SPEC = {
    ...SPEC,
    runtimes: [{ ...SPEC.runtimes[0]!, instrumentation: undefined }],
  } as unknown as ProjectSpec;
  const TRACES = {
    name: "agentcore_traces",
    kind: "cloudwatch_traces" as const,
    region: "us-west-2",
    include: ["deny", "permit", "trace"],
  };
  const X_RAY = {
    Sid: "BoxTelemetryToXRay",
    Effect: "Allow",
    Action: ["xray:PutSpans", "xray:PutTraceSegments"],
    Resource: "*",
  };

  /** The telemetry policy file that build writes for the model `network`. */
  const policyOf = (network: NonNullable<Awaited<ReturnType<typeof readBoxNetworks>>[number]>) =>
    telemetryPolicyWriter.edits([network], {
      spec: OTEL_SPEC,
      projectRoot: "/project",
      env: {},
      envLocal: {},
    }).files ?? [];

  test("gets the grant of the execution role for X-Ray, and with OTEL off gets none", async () => {
    const root = await project([]);
    const box = new FakeBoxProfileResolver(boxShowOf({ egress: API_ROUTE }));

    const [on] = await readBoxNetworks(OTEL_SPEC, root, box);
    const [off] = await readBoxNetworks(SPEC, root, box);

    expect(on?.telemetry).toEqual([TRACES]);
    const telemetry = on?.runtimeProfile?.telemetry as Record<string, unknown>;
    expect(telemetry.agentcore_traces).toEqual({
      kind: "cloudwatch_traces",
      region: "${{ inputs.aws.region }}",
      include: ["deny", "permit", "trace"],
      secret: { ref: "aws://" },
      ...(tracesToRuntimeLogGroup(BOX_RELEASE.version) && {
        log_group: "${{ inputs.runtime.traces_log_group }}",
        log_stream: "${{ inputs.runtime.traces_log_stream }}",
      }),
    });
    const [file] = policyOf(on!);
    expect(JSON.parse((file as { text: string }).text)).toEqual({
      Version: "2012-10-17",
      Statement: [X_RAY],
    });
    expect(off?.telemetry).toBeUndefined();
    expect(policyOf(off!)).toEqual([{ path: boxTelemetryPolicyFile("agent"), remove: true }]);
  });

  test("is not added, and gets no grant, when the envVars set DISABLE_ADOT_OBSERVABILITY to true", async () => {
    const root = await project([]);
    const box = new FakeBoxProfileResolver(boxShowOf({ egress: API_ROUTE }));
    const spec = {
      ...OTEL_SPEC,
      runtimes: [
        {
          ...OTEL_SPEC.runtimes[0]!,
          envVars: [{ name: "DISABLE_ADOT_OBSERVABILITY", value: "true" }],
        },
      ],
    } as unknown as ProjectSpec;

    const [network] = await readBoxNetworks(spec, root, box);

    expect(network?.runtimeProfile?.telemetry).toEqual({});
    expect(network?.telemetry).toBeUndefined();
    expect(policyOf(network!)).toEqual([{ path: boxTelemetryPolicyFile("agent"), remove: true }]);
  });

  test("is not added, and gets no second grant, when the profile has its own cloudwatch_traces target", async () => {
    const root = await project([]);
    const shown = boxShowOf({ egress: API_ROUTE });
    const own = { kind: "cloudwatch_traces", region: "eu-west-1", secret: { ref: "aws://" } };
    const box = new FakeBoxProfileResolver({
      ...shown,
      boxToml: { ...shown.boxToml, telemetry: { mine: own } },
    });

    const [network] = await readBoxNetworks(OTEL_SPEC, root, box);

    expect(network?.telemetry).toEqual([
      { name: "mine", kind: "cloudwatch_traces", region: "eu-west-1" },
    ]);
    expect(network?.runtimeProfile?.telemetry).not.toHaveProperty("agentcore_traces");
    const [file] = policyOf(network!);
    expect(JSON.parse((file as { text: string }).text).Statement).toEqual([X_RAY]);
  });
});

describe("two routes of one profile to one host", () => {
  /** The Box network model of `agent` for the local profile `text`, which box resolves to `egress`. */
  async function networkOf(text: string, egress: Record<string, unknown>) {
    const root = await project([]);
    await writeFile(join(root, ...LOCAL, "profile.toml"), text);
    const [network] = await readBoxNetworks(
      SPEC,
      root,
      new FakeBoxProfileResolver(boxShowOf({ egress })),
    );
    return network!;
  }
  const open = { destinations: ["api.example.com"] };
  const keyed = { destinations: ["api.example.com"], secret: { ref: "env://A_TOKEN" } };

  test.each([
    [
      "two open routes",
      '[egress.a]\ndestinations = ["api.example.com"]\n' +
        '[egress.b]\ndestinations = ["api.example.com"]\n',
      { a: open, b: open },
      ".box/agent/local/profile.toml:3:1",
    ],
    [
      "a route with a secret and an open route",
      '[egress.a]\ndestinations = ["api.example.com"]\nsecret.ref = "env://A_TOKEN"\n' +
        '[egress.b]\ndestinations = ["api.example.com"]\n',
      { a: keyed, b: open },
      ".box/agent/local/profile.toml:4:1",
    ],
  ])(
    "stop build for %s to one host, with one problem that names both entries",
    async (_label, text, egress, place) => {
      const network = await networkOf(text, egress);

      expect(network.failures.map(({ code, reason, place }) => [code, reason, place])).toEqual([
        [
          "EGRESS_DESTINATION_OVERLAP",
          "[egress.b] names api.example.com, and [egress.a] names it too, but one host has only " +
            "one entry. Keep api.example.com in only one of the two.",
          place,
        ],
      ]);
      expect(boxNetworkFailureMessage([network], "build")).toStartWith("Build stopped: 1 problem");
    },
  );

  test("gives an entry that names its host twice one target and one route", async () => {
    const twice = { destinations: ["api.example.com", "api.example.com:443"] };
    const network = await networkOf(
      '[egress.a]\ndestinations = ["api.example.com", "api.example.com:443"]\n' +
        'secret.ref = "env://A_TOKEN"\n',
      { a: { ...twice, secret: keyed.secret } },
    );

    expect(network.failures).toEqual([]);
    expect(network.hosts.map(({ authority, target }) => [authority, target])).toEqual([
      ["api.example.com", "egress-a"],
    ]);
    const routes = Object.entries(network.runtimeProfile!.egress as Record<string, any>).filter(
      ([, route]) => (route.destinations as string[]).some((host) => host === "api.example.com"),
    );
    expect(routes.map(([name, route]) => [name, route.destinations])).toEqual([
      ["a", ["api.example.com"]],
    ]);
  });
});

describe("the record of the targets build writes", () => {
  const mine = {
    name: "egress-mine",
    targetType: "passthrough",
    passthrough: { endpoint: "https://mine.example.com", protocolType: "CUSTOM" },
  };
  const withTarget = {
    ...SPEC,
    agentCoreGateways: [{ ...boxGatewaySpec("agent"), targets: [mine] }],
  } as unknown as ProjectSpec;
  const managed = async (root: string) => [
    ...(await readBoxNetworks(withTarget, root, new FakeBoxProfileResolver()))[0]!.managedTargets,
  ];

  test("makes only the targets it names build's", async () => {
    const root = await project([]);
    await mkdir(join(root, "agentcore"));
    await writeFile(
      join(root, "agentcore", "box-gateway-targets.json"),
      '{"agent-box-egress": []}',
    );
    expect(await managed(root)).not.toContain("egress-mine");
  });

  test("makes each egress- target of the shape build writes build's, for a gateway it does not name", async () => {
    const root = await project([]);
    expect(await managed(root)).toContain("egress-mine");
    await mkdir(join(root, "agentcore"));
    await writeFile(
      join(root, "agentcore", "box-gateway-targets.json"),
      '{"other-box-egress": []}',
    );
    expect(await managed(root)).toContain("egress-mine");
  });

  test("stops on a record that is not the one build writes, and names the file", async () => {
    const root = await project([]);
    await mkdir(join(root, "agentcore"));
    await writeFile(
      join(root, "agentcore", "box-gateway-targets.json"),
      '{"agent-box-egress": "x"}',
    );
    await expect(readBoxNetworks(withTarget, root, new FakeBoxProfileResolver())).rejects.toThrow(
      "agentcore/box-gateway-targets.json is not the record of the gateway targets that build " +
        "writes: a JSON object with a list of target names for each Box gateway. Remove the " +
        "file, and build writes it again.",
    );
  });
});

describe("the IAM policy files of the Box gateway", () => {
  test("counts the actions of each listed file, and warns for one it cannot count", async () => {
    const root = await project([]);
    await mkdir(join(root, "agentcore"));
    await writeFile(join(root, "agentcore", "broken.json"), "{ not json");
    await writeFile(join(root, "agentcore", "list.json"), "[]");
    await writeFile(
      join(root, "agentcore", "grants.json"),
      JSON.stringify({ Statement: [{ Effect: "Allow", Action: ["bedrock:InvokeModel"] }] }),
    );
    const listed = ["missing", "broken", "list", "grants"].map((name) => `agentcore/${name}.json`);
    const spec = {
      ...SPEC,
      agentCoreGateways: [{ ...boxGatewaySpec("agent"), additionalPolicies: listed }],
    } as unknown as ProjectSpec;

    const [network] = await readBoxNetworks(spec, root, new FakeBoxProfileResolver());

    expect(network?.grantedActions).toEqual(["bedrock:InvokeModel"]);
    const listing = "in additionalPolicies of the gateway 'agent-box-egress'";
    const check = "so build cannot check the permissions it grants.";
    expect(network?.warnings).toEqual([
      `agentcore/missing.json, ${listing}, does not exist, ${check} Create it, or remove it ` +
        "from additionalPolicies.",
      expect.stringMatching(
        /^agentcore\/broken\.json, in additionalPolicies of the gateway 'agent-box-egress', is not valid JSON \(.+\), so build cannot check the permissions it grants\. Correct the JSON\.$/,
      ),
      `agentcore/list.json, ${listing}, is not a JSON object, ${check} Make it an IAM policy ` +
        "document.",
    ]);
  });

  test("counts the actions of an Allow statement in each form IAM takes, and of no other", async () => {
    const root = await project([]);
    await mkdir(join(root, "agentcore"));
    const files: Record<string, unknown> = {
      one: { Statement: { Effect: "Allow", Action: "lambda:InvokeFunctionUrl" } },
      mixed: { Statement: [{ Effect: "Deny", Action: "s3:*" }, null, "text", { Effect: "Allow" }] },
      none: { Version: "2012-10-17" },
    };
    for (const [name, document] of Object.entries(files)) {
      await writeFile(join(root, "agentcore", `${name}.json`), JSON.stringify(document));
    }
    const spec = {
      ...SPEC,
      agentCoreGateways: [
        {
          ...boxGatewaySpec("agent"),
          additionalPolicies: Object.keys(files).map((name) => `agentcore/${name}.json`),
        },
      ],
    } as unknown as ProjectSpec;

    const [network] = await readBoxNetworks(spec, root, new FakeBoxProfileResolver());

    expect(network?.grantedActions).toEqual(["lambda:InvokeFunctionUrl"]);
    expect(network?.warnings).toEqual([]);
  });

  test("gives no warning for the Bedrock policy file that build writes before it writes it", async () => {
    const root = await project([]);
    const spec = {
      ...SPEC,
      agentCoreGateways: [
        { ...boxGatewaySpec("agent"), additionalPolicies: ["agentcore/box-bedrock-policy.json"] },
      ],
    } as unknown as ProjectSpec;

    const [network] = await readBoxNetworks(spec, root, new FakeBoxProfileResolver());

    expect(network?.grantedActions).toEqual([]);
    expect(network?.warnings).toEqual([]);
  });

  test("does not count the actions of the policy files that build writes", async () => {
    const root = await project([]);
    await mkdir(join(root, "agentcore"));
    const grant = (action: string) =>
      JSON.stringify({ Statement: [{ Effect: "Allow", Action: [action] }] });
    await writeFile(join(root, "agentcore", "box-bedrock-policy.json"), "{ not json");
    await writeFile(join(root, "agentcore", "grants.json"), grant("lambda:InvokeFunctionUrl"));
    const listed = ["box-bedrock-policy", "grants"].map((name) => `agentcore/${name}.json`);
    const spec = {
      ...SPEC,
      agentCoreGateways: [{ ...boxGatewaySpec("agent"), additionalPolicies: listed }],
    } as unknown as ProjectSpec;

    const [network] = await readBoxNetworks(spec, root, new FakeBoxProfileResolver());

    expect(network?.grantedActions).toEqual(["lambda:InvokeFunctionUrl"]);
    expect(network?.warnings).toEqual([]);
  });
});

describe("boxNetworkFailureMessage", () => {
  test("lists a problem of the one box runtime with no runtime, and says nothing changed", async () => {
    // Each boxed agent reads its own .box/<name>/local profile, so a failure names that path.
    const root = await project(["missing.dw"]);

    const networks = await readBoxNetworks(SPEC, root, new FakeBoxProfileResolver());

    expect(boxNetworkFailureMessage(networks, "deploy")).toBe(
      "Deploy stopped: 1 problem in the Box profile. Deploy wrote nothing from the Box profile.\n" +
        ".box/agent/local/profile.toml:1:1  `policies` names missing.dw, but " +
        ".box/agent/local/missing.dw does not exist. Create it, or remove it from `policies`.",
    );
  });

  test("names the runtime of a problem that only some box runtimes have", async () => {
    const root = await project(["missing.dw"]);
    await writeProfile(root, "second", ["missing.dw"]);
    const spec = {
      ...SPEC,
      runtimes: [...SPEC.runtimes, { ...SPEC.runtimes[0]!, name: "second" }],
      agentCoreGateways: [
        boxGatewaySpec("agent"),
        {
          ...boxGatewaySpec("second"),
          targets: [
            {
              name: "api",
              targetType: "passthrough",
              passthrough: { endpoint: "https://api.example.com/v1", protocolType: "CUSTOM" },
            },
          ],
        },
      ],
    } as unknown as ProjectSpec;

    const networks = await readBoxNetworks(
      spec,
      root,
      new FakeBoxProfileResolver(boxShowOf({ egress: API_ROUTE })),
    );

    expect(boxNetworkFailureMessage(networks, "build")).toBe(
      "Build stopped: 3 problems in the Box profile and agentcore.json. Build wrote nothing from the Box profile.\n" +
        "In runtime agent:\n" +
        "  .box/agent/local/profile.toml:1:1  `policies` names missing.dw, but " +
        ".box/agent/local/missing.dw does not exist. Create it, or remove it from `policies`.\n" +
        "In runtime second:\n" +
        "  .box/second/local/profile.toml:1:1  `policies` names missing.dw, but " +
        ".box/second/local/missing.dw does not exist. Create it, or remove it from `policies`.\n" +
        "  agentcore/agentcore.json  The gateway target 'api' for api.example.com has the path " +
        "/v1 in its endpoint, and the agent's requests do not include it. Remove /v1 from the " +
        "endpoint, or remove the target.",
    );
  });
});
