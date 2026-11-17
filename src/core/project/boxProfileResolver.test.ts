import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { InvalidEnvironmentError } from "../../errors/errors";
import { ProcessFailedError, type ProcessEvent, type StreamProcessOptions } from "../../io";
import type { ProjectSpec } from "../../projectSchemas/project";
import { readBoxNetworks } from "./boxNetworkSource";
import { BoxCliProfileResolver, parseBoxProfileShow } from "./boxProfileResolver";
import { boxNetworkRules, boxReachRules } from "./boxProfileResolver-test-support";

const NC = 'action == Box::Action::"net:connect"';
const HR = 'action == Box::Action::"http:request"';

/**
 * `box profile show <profile> --format json` of the staging-boxy draft, for a profile with the route
 * `keyed` and the HTTP MCP server `docs`, trimmed, with this test's profile and paths in it.
 */
const SHOWN = String.raw`{
  "profile": ".box/profile.toml",
  "packs": [
    {
      "name": "box/base",
      "version": "1"
    }
  ],
  "storage": "/home/me/.box/storage/demo/default",
  "inputs": [
    {
      "name": "terminal.term",
      "value": "xterm-256color",
      "source": "env:TERM"
    }
  ],
  "skipped": [],
  "dropped": [],
  "copies": [],
  "links": [],
  "parts": [],
  "mcp": {
    "unstarted": [],
    "servers": [],
    "dropped": [],
    "path_dropped": [],
    "skipped": [],
    "unread": []
  },
  "warnings": [],
  "box_toml": {
    "name": "demo-preview",
    "box_dir": "/home/me/.box/runs/demo-preview/box",
    "policy": "policy.dw",
    "file-attributes": true,
    "agent": {
      "command": [
        "/bin/sh"
      ],
      "workspace": "/work/demo"
    },
    "egress": {
      "keyed": {
        "destinations": [
          "k.example.com:8443"
        ],
        "secret": {
          "ref": "env://KEY"
        }
      }
    },
    "mcp": {
      "docs": {
        "destinations": [
          "docs.example.com"
        ],
        "type": "http"
      }
    },
    "telemetry": {
      "records": {
        "kind": "file",
        "include": [
          "deny"
        ]
      }
    }
  },
  "policy": "// No admin paths on GitHub.\n@id(\"no_admin\") forbid (principal, action == Box::Action::\"http:request\", resource) when { context.input.host == \"api.github.com\" && context.input.path like \"/admin/*\" };\n@id(\"metadata_hosts\") forbid (principal, action == Box::Action::\"net:connect\", resource) when { context.input.host == \"metadata.google.internal\" || context.input.host == \"metadata.azure.internal\" };\n@id(\"route_keyed_connect\") permit (principal, action == Box::Action::\"net:connect\", resource) when { (context.input.host == \"k.example.com\" && context.input.port == 8443) };\n@id(\"route_keyed_request\") permit (principal, action == Box::Action::\"http:request\", resource) when { context.input.host == \"k.example.com\" };\n@id(\"mcp_docs_call\") permit (principal, action == Box::Action::\"mcp:call\", resource) when { context.input.server == \"docs\" };\n@id(\"mcp_docs_connect\") permit (principal, action == Box::Action::\"net:connect\", resource) when { (context.input.host == \"docs.example.com\" && context.input.port == 443) };\n@id(\"mcp_docs_request\") permit (principal, action == Box::Action::\"http:request\", resource) when { context.input.host == \"docs.example.com\" };\n"
}`;

/** The `policy` of {@link SHOWN}: the profile's own rule, then rules Box adds. */
const SHOWN_POLICY =
  "// No admin paths on GitHub.\n" +
  `@id("no_admin") forbid (principal, ${HR}, resource) when { context.input.host == "api.github.com" && context.input.path like "/admin/*" };\n` +
  `@id("metadata_hosts") forbid (principal, ${NC}, resource) when { context.input.host == "metadata.google.internal" || context.input.host == "metadata.azure.internal" };\n` +
  boxReachRules("route", "keyed", ["k.example.com:8443"]) +
  boxReachRules("mcp", "docs", ["docs.example.com"]);

const RELEASES = "https://github.com/mquang-amazon/box-releases";

describe("parseBoxProfileShow", () => {
  test("takes the box.toml as a table in the order of the file, the policy.dw, the packs, and the warnings", () => {
    const resolved = parseBoxProfileShow(SHOWN, ".box/profile.toml");

    expect(resolved).toEqual({
      boxToml: {
        name: "demo-preview",
        box_dir: "/home/me/.box/runs/demo-preview/box",
        policy: "policy.dw",
        "file-attributes": true,
        agent: { command: ["/bin/sh"], workspace: "/work/demo" },
        egress: { keyed: { destinations: ["k.example.com:8443"], secret: { ref: "env://KEY" } } },
        mcp: { docs: { destinations: ["docs.example.com"], type: "http" } },
        telemetry: { records: { kind: "file", include: ["deny"] } },
      },
      policy: SHOWN_POLICY,
      packs: [{ name: "box/base", version: "1" }],
      warnings: [],
    });
    expect(Object.keys(resolved.boxToml)).toEqual([
      "name",
      "box_dir",
      "policy",
      "file-attributes",
      "agent",
      "egress",
      "mcp",
      "telemetry",
    ]);
  });

  test("refuses output that is not one JSON document, such as the text that `show` prints", () => {
    expect(() =>
      parseBoxProfileShow(
        "profile .box/profile.toml resolves for this directory\n  packs    box/base 1\n",
        ".box/profile.toml",
      ),
    ).toThrow(
      new InvalidEnvironmentError(
        "Build cannot read what Box printed for the profile .box/profile.toml, as it is not one " +
          "JSON document. Run 'box profile show .box/profile.toml --format json' in the project folder " +
          "to see it.",
      ),
    );
  });

  const document = JSON.parse(SHOWN) as Record<string, unknown>;
  const { box_toml: _boxToml, ...noBoxToml } = document;
  test.each([
    ["no box_toml", noBoxToml, "a box.toml table"],
    ["box_toml as TOML text", { ...document, box_toml: 'name = "x"' }, "a box.toml table"],
    [
      "box_toml as a list, and no policy",
      { ...noBoxToml, box_toml: [], policy: undefined },
      "a box.toml table or the policy.dw text",
    ],
    ["packs as text", { ...document, packs: "box/base 1" }, "a list of packs"],
    ["a list, not an object", [], "a box.toml table or the policy.dw text"],
  ])("refuses a document with %s, and names what it lacks", (_, shown, lacks) => {
    expect(() => parseBoxProfileShow(JSON.stringify(shown), ".box/profile.toml")).toThrow(
      new InvalidEnvironmentError(
        `Box printed the profile .box/profile.toml without ${lacks}, which build reads. Install ` +
          `a newer Box (${RELEASES}), then retry.`,
      ),
    );
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

/** What clap prints for `--format` in a box that has no such flag, as box releases to date do. */
const NO_JSON_FLAG = [
  "error: unexpected argument '--format' found",
  "",
  "  tip: to pass '--format' as a value, use '-- --format'",
  "",
  "Usage: box profile show [OPTIONS] <NAME>",
  "",
  "For more information, try '--help'.",
];

describe("BoxCliProfileResolver", () => {
  test("runs `box profile show <profile> --format json` in the project folder, with no colour", async () => {
    const fake = streamer(stdout(SHOWN));
    const resolver = new BoxCliProfileResolver({ env: { PATH: "/bin" }, ...fake });

    const resolved = await resolver.resolve("/work/demo", ".box/profile.toml");

    expect(resolved).toEqual(parseBoxProfileShow(SHOWN, ".box/profile.toml"));
    expect(fake.calls).toEqual([
      {
        command: ["box", "profile", "show", ".box/profile.toml", "--format", "json"],
        options: { cwd: "/work/demo", env: { PATH: "/bin", NO_COLOR: "1" } },
      },
    ]);
  });

  const COMMAND = ["box", "profile", "show", ".box/profile.toml", "--format", "json"];
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

  test("says to install a Box with --format json when the box on PATH has no such flag", async () => {
    const error = await failure(refusal(NO_JSON_FLAG, 2));

    expect(error).toBeInstanceOf(InvalidEnvironmentError);
    expect((error as Error).message).toBe(
      "This Box cannot print the profile .box/profile.toml as JSON, which build reads. Install " +
        `a Box release with \`box profile show --format json\` (${RELEASES}), then retry.`,
    );
  });

  test("refuses the output of a box that prints no JSON document", async () => {
    const fake = streamer(stdout("profile .box/profile.toml resolves for this directory"));

    await expect(
      new BoxCliProfileResolver(fake).resolve("/work/demo", ".box/profile.toml"),
    ).rejects.toThrow(
      "Build cannot read what Box printed for the profile .box/profile.toml, as it is not one " +
        "JSON document.",
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

describe("the copy of the profile for the build region", () => {
  /** A project whose profile imports box/bedrock for us-west-2, so a build for eu-central-1 copies it. */
  async function regionalProject(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "box-profile-region-"));
    directories.push(root);
    await mkdir(join(root, ".box"));
    await writeFile(
      join(root, ".box", "profile.toml"),
      'packs = ["box/base", "box/bedrock"]\n\n[options]\nbedrock.region = "us-west-2"\n',
    );
    return root;
  }

  test("has box print the copy as JSON, and builds the model from its box.toml table", async () => {
    const root = await regionalProject();
    const calls: { command: string[]; cwd: string; copy: string }[] = [];
    const resolver = new BoxCliProfileResolver({
      async *streamProcess(command: string[], options: StreamProcessOptions) {
        calls.push({ command, cwd: options.cwd, copy: await readFile(command[3]!, "utf8") });
        yield* stdout(SHOWN);
      },
    });

    const [network] = await readBoxNetworks(SPEC, root, resolver, "eu-central-1");

    expect(calls).toHaveLength(1);
    const [{ command, cwd, copy }] = calls as [(typeof calls)[number]];
    expect(command).toEqual(["box", "profile", "show", expect.any(String), "--format", "json"]);
    expect(isAbsolute(command[3]!)).toBe(true);
    expect(existsSync(command[3]!)).toBe(false);
    expect(cwd).toBe(root);
    expect(copy).toContain('bedrock.region = "eu-central-1"');
    const reachable = network?.hosts.filter((host) => host.reachable) ?? [];
    expect(reachable.map((h) => [h.authority, h.target, h.outboundAuth.kind])).toEqual([
      ["k.example.com:8443", "egress-keyed", "apiKey"],
    ]);
    expect(network?.failures.map(({ code, mcpEntry }) => [code, mcpEntry])).toEqual([
      ["MCP_OVER_HTTP", "docs"],
    ]);
  });

  test.each([
    [
      "refuses the copy",
      (copy: string) => [`box: error: ${copy}:4: bad`],
      "Box refused the profile .box/profile.toml:\n  box: error: .box/profile.toml:4: bad\n" +
        "Fix what Box reports, then retry.",
    ],
    [
      "has no --format json",
      () => NO_JSON_FLAG,
      "This Box cannot print the profile .box/profile.toml as JSON, which build reads. Install " +
        `a Box release with \`box profile show --format json\` (${RELEASES}), then retry.`,
    ],
  ])("names the profile, not the copy, when box %s", async (_, stderr, message) => {
    const root = await regionalProject();
    const resolver = new BoxCliProfileResolver({
      async *streamProcess(command: string[], options: StreamProcessOptions) {
        for (const line of stderr(command[3]!)) yield { type: "stderr", line } as const;
        throw new ProcessFailedError(command, options.cwd, 1, "box: error: ...");
      },
    });

    await expect(readBoxNetworks(SPEC, root, resolver, "eu-central-1")).rejects.toThrow(
      new InvalidEnvironmentError(message),
    );
  });
});

/** Whether the box on PATH has `box profile show --format json`, which no box release has yet. */
const boxPrintsJson = (() => {
  if (!Bun.which("box")) return false;
  const help = Bun.spawnSync(["box", "profile", "show", "--help"], { stderr: "ignore" });
  return help.stdout.toString().includes("--format");
})();

describe("the box on PATH", () => {
  test.skipIf(!boxPrintsJson)(
    "resolves a profile into the model and the rules the tests fake (skipped when the box on PATH has no --format json)",
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
        expect.stringContaining('Box still applies the rule "no_admin"'),
      );
    },
    120_000,
  );
});
