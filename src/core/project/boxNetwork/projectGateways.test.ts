import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import type { ProjectSpec } from "../../../projectSchemas/project";
import { profileKeyPlaces, runtimeProfileContext } from "../runtimeProfile/context";
import { apply } from "../runtimeProfile/rules/gateway";
import { serializeRuntimeProfile } from "../runtimeProfile/serialize";
import type { TomlTable } from "../runtimeProfile/types";
import { AGENTCORE_PACK_PATH, renderAgentCorePack } from "../templates/boxProfile";
import {
  projectGatewaysOf,
  projectGatewayTargetFor,
  type BoxProjectGateway,
} from "./projectGateways";

const TOOLS: BoxProjectGateway = {
  name: "tools",
  target: "egress-gateway-tools",
  variablePrefix: "AGENTCORE_GATEWAY_TOOLS",
  auth: "iam",
};

describe("projectGatewayTargetFor", () => {
  test("names the gateway and signs for AgentCore in the build region, for an AWS_IAM gateway", () => {
    expect(projectGatewayTargetFor(TOOLS, "us-west-2")).toEqual({
      name: "egress-gateway-tools",
      targetType: "passthrough",
      passthrough: { gateway: "tools", protocolType: "CUSTOM" },
      outboundAuth: { type: "GATEWAY_IAM_ROLE", service: "bedrock-agentcore", region: "us-west-2" },
    });
  });

  test("sends no credential to a gateway that takes none", () => {
    expect(projectGatewayTargetFor({ ...TOOLS, auth: "none" }, "us-west-2").outboundAuth).toBe(
      undefined,
    );
  });
});

describe("the target name of each gateway", () => {
  const targetsOf = (...names: string[]) =>
    projectGatewaysOf(
      {
        agentCoreGateways: names.map((name) => ({ name, authorizerType: "AWS_IAM", targets: [] })),
      } as unknown as ProjectSpec,
      { name: "agent" },
    ).gateways.map(({ target }) => target);

  test("is egress-gateway-<name> when the name fits as it is", () => {
    expect(targetsOf("tools", "My-Tools-GW")).toEqual([
      "egress-gateway-tools",
      "egress-gateway-My-Tools-GW",
    ]);
  });

  test.each([
    ["a--b", "a-b"],
    ["x".repeat(95) + "1", "x".repeat(95) + "2"],
    ["a".repeat(90) + "x1", "a".repeat(90) + "x2"],
  ])("is not the same for %s and %s", (first, second) => {
    const targets = targetsOf(first, second);
    expect(new Set(targets).size).toBe(2);
    for (const target of targets) {
      expect(target.length).toBeLessThanOrEqual(100);
      expect(target).toMatch(/^egress-gateway-[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/);
    }
  });

  test("is the same on each build", () => {
    expect(targetsOf("a--b")).toEqual(targetsOf("a--b"));
  });
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** The box on PATH, when it has `box profile show --format json --full`. */
const box = (() => {
  const path = Bun.which("box");
  if (!path) return undefined;
  const help = Bun.spawnSync([path, "profile", "show", "--help"], { stderr: "ignore" }).stdout;
  return ["--format", "--full"].every((flag) => help.toString().includes(flag)) ? path : undefined;
})();

const HOST = "demo-default-tools-abcdefghij.gateway.bedrock-agentcore.us-west-2.amazonaws.com";
const BOX_GATEWAY_URL =
  "https://demo-default-agent-box-egress-klmnopqrst.gateway.bedrock-agentcore.us-west-2.amazonaws.com";

/** A gateway named `name`, with the variable prefix and the target that build gives it. */
const gatewayNamed = (name: string, prefix: string): BoxProjectGateway => ({
  name,
  target: `egress-gateway-${name}`,
  variablePrefix: prefix,
  auth: "iam",
});

describe("the box on PATH", () => {
  // A gateway name can hold "-" and upper case, which reach an input name and a server name.
  test
    .skipIf(box === undefined)
    .each([[TOOLS], [gatewayNamed("My-Tools-GW", "AGENTCORE_GATEWAY_MY_TOOLS_GW")]])(
    "resolves the server and the agent variable of the gateway %o from the variables the CDK library sets (skipped without a box with --format json --full on PATH)",
    async (gateway) => {
      const root = await mkdtemp(join(tmpdir(), "box-project-gateway-"));
      directories.push(root);
      const resources = join(root, "resources");
      await cp(join(dirname(await realpath(box!)), "resources"), resources, { recursive: true });
      const spec = { name: "demo", memories: [] } as unknown as ProjectSpec;
      const pack = join(root, AGENTCORE_PACK_PATH);
      await mkdir(dirname(pack), { recursive: true });
      await writeFile(
        pack,
        renderAgentCorePack(spec, { name: "agent", instrumentation: { enableOtel: false } }, [
          gateway,
        ]),
      );
      const local =
        'packs = ["@box/base", "@box/agentcore"]\n\n[profile]\nname = "demo"\n\n' +
        '[agent]\ncommand = ["/bin/sh"]\n';
      const context = runtimeProfileContext({
        spec,
        runtime: { name: "agent", build: "Container" } as never,
        profileFile: ".box/profile.toml",
        region: "us-west-2",
        gateway: { name: "agent-box-egress", targets: [] },
        hosts: [],
        projectGateways: [gateway],
        telemetry: [],
        places: profileKeyPlaces(local, ".box/profile.toml"),
      });
      const runtimeProfile = apply(parse(local) as TomlTable, context).table;
      const project = join(root, "project");
      await mkdir(join(project, ".box"), { recursive: true });
      await writeFile(
        join(project, ".box", "profile.toml"),
        serializeRuntimeProfile(runtimeProfile),
      );

      const run = Bun.spawnSync(
        [box!, "profile", "show", ".box/profile.toml", "--format", "json", "--full"],
        {
          cwd: project,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            BOX_RESOURCES: resources,
            AWS_REGION: "us-west-2",
            AGENTCORE_GATEWAY_BOX_URL: BOX_GATEWAY_URL,
            [`${gateway.variablePrefix}_URL`]: `https://${HOST}/mcp`,
            [`${gateway.variablePrefix}_HOST`]: HOST,
          },
        },
      );
      expect(run.stderr.toString()).toBe("");
      const shown = JSON.parse(run.stdout.toString()) as {
        box_toml: {
          agent: { env: Record<string, string> };
          mcp: Record<string, { destinations: string[]; backends: { url: string }[] }>;
        };
        policy: string;
      };
      const server = shown.box_toml.mcp[gateway.name]!;
      expect(server.destinations).toEqual([HOST]);
      expect(server.backends.map(({ url }) => url)).toEqual([
        `${BOX_GATEWAY_URL}/${gateway.target}`,
      ]);
      expect(shown.box_toml.agent.env[`${gateway.variablePrefix}_URL`]).toBe(`https://${HOST}/mcp`);
      expect(shown.policy).toContain(`context.input.server == "${gateway.name}"`);
      expect(shown.policy).toContain(
        `permit (principal, action == Box::Action::"net:connect", resource) when { (context.input.host == "${HOST}" && context.input.port == 443) };`,
      );
    },
    120_000,
  );
});
