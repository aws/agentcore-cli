import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidEnvironmentError } from "../../errors/errors";
import { ProcessFailedError, type ProcessEvent, type StreamProcessOptions } from "../../io";
import type { ProjectSpec } from "../../projectSchemas/project";
import { readBoxNetworks } from "./boxNetworkSource";
import { BoxCliProfileResolver, parseBoxProfileShow } from "./boxProfileResolver";
import { boxNetworkRules } from "./boxProfileResolver-test-support";

const NC = 'action == Box::Action::"net:connect"';

/** `box profile show .box/profile.toml --full` of box 0.1.11, trimmed. */
const SHOWN = [
  "box / profile .box/profile.toml",
  "",
  "✓ Resolves for this directory",
  "  packs     box/base 1, box/bedrock 1",
  "  ! route github: api.github.com (no credential, open to every program in the box)",
  "",
  "# box.toml",
  'name = "L3NoAuth-preview"',
  "",
  "[egress.bedrock]",
  'destinations = ["bedrock-runtime.us-west-2.amazonaws.com"]',
  "",
  "# policy.dw",
  "// No admin paths on GitHub.",
  `@id("route_github_connect") permit (principal, ${NC}, resource) when { (context.input.host == "api.github.com" && context.input.port == 443) };`,
  "",
].join("\n");

describe("parseBoxProfileShow", () => {
  test("takes the box.toml and the policy.dw that box prints after its summary", () => {
    expect(parseBoxProfileShow(SHOWN)).toEqual({
      boxToml:
        'name = "L3NoAuth-preview"\n\n[egress.bedrock]\ndestinations = ["bedrock-runtime.us-west-2.amazonaws.com"]\n',
      policy:
        "// No admin paths on GitHub.\n" +
        `@id("route_github_connect") permit (principal, ${NC}, resource) when { (context.input.host == "api.github.com" && context.input.port == 443) };\n`,
    });
  });

  test("finds no sections in the summary that `show` prints without --full", () => {
    expect(
      parseBoxProfileShow(
        "box / profile .box/profile.toml\n\nFull configuration: box profile show .box/profile.toml --full\n",
      ),
    ).toBeUndefined();
  });
});

/** A process streamer that yields `lines`, then fails with `failure` when one is given. */
function streamer(lines: ProcessEvent[], failure?: ProcessFailedError) {
  const calls: { command: string[]; options: StreamProcessOptions }[] = [];
  return {
    calls,
    async *streamProcess(command: string[], options: StreamProcessOptions) {
      calls.push({ command, options });
      yield* lines;
      if (failure) throw failure;
    },
  };
}

const stdout = (text: string): ProcessEvent[] =>
  text.split("\n").map((line) => ({ type: "stdout", line }));

describe("BoxCliProfileResolver", () => {
  test("runs `box profile show <profile> --full` in the project folder, with no colour", async () => {
    const fake = streamer(stdout(SHOWN));
    const resolver = new BoxCliProfileResolver({ env: { PATH: "/bin" }, ...fake });

    const resolved = await resolver.resolve("/work/demo", ".box/profile.toml");

    expect(resolved).toEqual(parseBoxProfileShow(SHOWN)!);
    expect(fake.calls).toEqual([
      {
        command: ["box", "profile", "show", ".box/profile.toml", "--full"],
        options: { cwd: "/work/demo", env: { PATH: "/bin", NO_COLOR: "1" } },
      },
    ]);
  });

  const COMMAND = ["box", "profile", "show", ".box/profile.toml", "--full"];
  const refusal = (lines: string[], exitCode: number | null = 1) =>
    streamer(
      lines.map((line) => ({ type: "stderr", line })),
      new ProcessFailedError(COMMAND, "/work/demo", exitCode, "box: error: ..."),
    );
  const failure = (fake: ReturnType<typeof streamer>) =>
    new BoxCliProfileResolver(fake)
      .resolve("/work/demo", ".box/profile.toml")
      .catch((caught: unknown) => caught);

  test("shows Box's own error, and not its usage text, when Box refuses the profile", async () => {
    const error = await failure(
      refusal([
        "box: error: /work/demo/.box/profile.toml:4: a profile holds no `policy`; list authored files in `policies`",
        "Usage: box profile show [OPTIONS] <NAME>",
        "For more information, try '--help'.",
      ]),
    );

    expect(error).toBeInstanceOf(InvalidEnvironmentError);
    expect((error as Error).message).toBe(
      "Box refused the profile .box/profile.toml:\n" +
        "  box: error: /work/demo/.box/profile.toml:4: a profile holds no `policy`; list authored " +
        "files in `policies`\n" +
        "Fix what Box reports, then retry.",
    );
  });

  test("says to run uv sync in the agent's folder when Box refuses its missing .venv", async () => {
    const error = await failure(
      refusal([
        "box: error: /work/demo/app/agent/.venv/bin/python lies under the write grant /work/demo, so the workload can replace it",
      ]),
    );

    expect((error as Error).message).toBe(
      "Box refused the profile .box/profile.toml:\n" +
        "  box: error: /work/demo/app/agent/.venv/bin/python lies under the write grant " +
        "/work/demo, so the workload can replace it\n" +
        "Run 'uv sync' in app/agent, then retry.",
    );
  });

  test("says how to see why when Box fails and prints no error", async () => {
    expect(((await failure(refusal([], 2))) as Error).message).toBe(
      "Box stopped on .box/profile.toml with exit code 2 and printed no error. Run " +
        "'box profile show .box/profile.toml' in the project folder to see why.",
    );
  });

  test("says Box is not installed, and where to get it, when box is not on PATH", async () => {
    const fake = streamer(
      [],
      new ProcessFailedError(COMMAND, "/work/demo", null, "Error: spawn box ENOENT"),
    );

    await expect(
      new BoxCliProfileResolver(fake).resolve("/work/demo", ".box/profile.toml"),
    ).rejects.toThrow(
      new InvalidEnvironmentError(
        "Box is not installed or not on PATH. Install it " +
          "(https://github.com/mquang-amazon/box-releases), then retry.",
      ),
    );
  });

  test("refuses the output of a box that prints no box.toml and policy.dw", async () => {
    const fake = streamer(stdout("box / profile .box/profile.toml"));

    await expect(
      new BoxCliProfileResolver(fake).resolve("/work/demo", ".box/profile.toml"),
    ).rejects.toThrow(
      new InvalidEnvironmentError(
        "This Box cannot show the full profile .box/profile.toml, which build reads. Install a " +
          "newer Box (https://github.com/mquang-amazon/box-releases), then retry.",
      ),
    );
  });
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const SPEC = {
  name: "demo",
  projectType: "box",
  runtimes: [
    { name: "agent", build: "CodeZip", entrypoint: "start.py", codeLocation: "app/agent" },
  ],
  memories: [],
  credentials: [],
  agentCoreGateways: [],
} as unknown as ProjectSpec;

const POLICY =
  "// No admin paths on GitHub.\n" +
  '@id("no_admin") forbid (principal, action == Box::Action::"http:request", resource) when { context.input.host == "api.github.com" && context.input.path like "/admin/*" };\n';
const ROUTES = {
  github: { destinations: ["api.github.com"] },
  keyed: { destinations: ["k.example.com:8443"], secret: { ref: "env://KEY" } },
};
const SERVERS = { docs: { type: "http", destinations: ["docs.example.com"] } };

describe("the box on PATH", () => {
  test.skipIf(!Bun.which("box"))(
    "resolves a profile into the model and the rules the tests fake (skipped when box is not on PATH)",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "box-profile-resolver-"));
      directories.push(root);
      await mkdir(join(root, ".box"));
      await writeFile(
        join(root, ".box", "profile.toml"),
        'packs = ["box/base"]\npolicies = ["policy.dw"]\n\n[profile]\nname = "resolver-test"\n\n' +
          '[agent]\ncommand = ["/bin/sh"]\n\n[egress.github]\ndestinations = ["api.github.com"]\n\n' +
          '[egress.keyed]\ndestinations = ["k.example.com:8443"]\nsecret.ref = "env://KEY"\n\n' +
          '[mcp.docs]\ntype = "http"\ndestinations = ["docs.example.com"]\n',
      );
      await writeFile(join(root, ".box", "policy.dw"), POLICY);
      const resolver = new BoxCliProfileResolver();

      const resolved = await resolver.resolve(root, ".box/profile.toml");
      const [network] = await readBoxNetworks(SPEC, root, resolver);

      const lines = resolved.policy.split("\n");
      for (const rule of boxNetworkRules(ROUTES, SERVERS).trimEnd().split("\n")) {
        expect(lines).toContain(rule);
      }
      const reachable = network?.hosts.filter((host) => host.reachable) ?? [];
      expect(reachable.map((h) => [h.authority, h.target, h.outboundAuth.kind])).toEqual([
        ["k.example.com:8443", "egress-keyed", "apiKey"],
        ["api.github.com", "egress-github", "none"],
      ]);
      expect(network?.failures.map(({ code, mcpEntry }) => [code, mcpEntry])).toEqual([
        ["MCP_OVER_HTTP", "docs"],
      ]);
      expect(network?.warnings).toContainEqual(
        expect.stringContaining('Box enforces "no_admin" on its own'),
      );
    },
    120_000,
  );
});
