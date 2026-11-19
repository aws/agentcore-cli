import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidEnvironmentError } from "../../errors/errors";
import { ProcessFailedError, type ProcessEvent, type StreamProcessOptions } from "../../io";
import { BoxCliProfileResolver, parseBoxProfileShow } from "./boxProfileResolver";
import { boxNetworkRules, boxReachRules } from "./boxProfileResolver-test-support";

const NC = 'action == Box::Action::"net:connect"';
const HR = 'action == Box::Action::"http:request"';

/**
 * `box profile show <profile> --format json --full` for a profile with the route `keyed` and the
 * HTTP MCP server `docs`, trimmed, with this test's profile and paths in it.
 */
const SHOWN = String.raw`{
  "profile": ".box/profile.toml",
  "packs": [
    {
      "name": "@box/base",
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
  "open_routes": [],
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

const PINNED =
  "box 0.1.11-linux-preview.7 or a later release " +
  "(https://github.com/mquang-amazon/box-releases/releases/tag/v0.1.11-linux-preview.7)";

/**
 * `box profile show open --format json --full` for a profile with the routes `auth` and `github`
 * with no secret, the route `keyed` with one, and {@link POLICY}, as box prints it, with HOME at
 * /tmp/acbox/home. Box 0.1.11-linux-preview.6 joins the destinations of an open route into one
 * string, and later boxes give a list.
 */
const OPEN_ROUTES_SHOWN = Object.entries({
  "one string": readFileSync(
    join(import.meta.dir, "__fixtures__", "box-profile-show-open-routes.json"),
    "utf8",
  ),
  "a list": readFileSync(
    join(import.meta.dir, "__fixtures__", "box-profile-show-open-routes-list.json"),
    "utf8",
  ),
});

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
      openRoutes: [],
      packs: [{ name: "@box/base", version: "1" }],
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
        "profile .box/profile.toml resolves for this directory\n  packs    @box/base 1\n",
        ".box/profile.toml",
      ),
    ).toThrow(
      new InvalidEnvironmentError(
        "Build cannot read what Box printed for the profile .box/profile.toml, as it is not one " +
          "JSON document. Run 'box profile show .box/profile.toml --format json --full' in the project folder " +
          "to see it.",
      ),
    );
  });

  test.each(OPEN_ROUTES_SHOWN)(
    "takes each open route, which box.toml leaves out, and its destinations from %s",
    (_, shown) => {
      const resolved = parseBoxProfileShow(shown, ".box/profile.toml");

      expect(resolved.openRoutes).toEqual([
        { route: "auth", destinations: ["login.example.com", "auth.example.com:8443"] },
        { route: "github", destinations: ["api.github.com"] },
      ]);
      expect(resolved.boxToml.egress).toEqual({
        keyed: { destinations: ["k.example.com:8443"], secret: { ref: "env://KEY" } },
      });
    },
  );

  const document = JSON.parse(SHOWN) as Record<string, unknown>;
  const { box_toml: _boxToml, ...noBoxToml } = document;
  const { open_routes: _openRoutes, ...noOpenRoutes } = document;
  test.each([
    ["no box_toml", noBoxToml, "a box.toml table"],
    ["no open_routes", noOpenRoutes, "a list of open routes"],
    ["box_toml as TOML text", { ...document, box_toml: 'name = "x"' }, "a box.toml table"],
    [
      "box_toml as a list, and no policy",
      { ...noBoxToml, box_toml: [], policy: undefined },
      "a box.toml table or the policy.dw text",
    ],
    ["packs as text", { ...document, packs: "@box/base 1" }, "a list of packs"],
    [
      "a destination that is not text",
      { ...document, open_routes: [{ route: "auth", destinations: ["login.example.com", 443] }] },
      "a list of open routes",
    ],
    [
      "no box_toml and no policy, as box prints it without --full",
      { ...noBoxToml, policy: undefined },
      "a box.toml table or the policy.dw text",
    ],
    ["a list, not an object", [], "a box.toml table or the policy.dw text"],
  ])("refuses a document with %s, and names what it lacks", (_, shown, lacks) => {
    expect(() => parseBoxProfileShow(JSON.stringify(shown), ".box/profile.toml")).toThrow(
      new InvalidEnvironmentError(
        `Box printed the profile .box/profile.toml without ${lacks}, which build reads. Install ` +
          `${PINNED}, then retry.`,
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

/** What clap prints for `--format` in a box that has no such flag. */
const NO_JSON_FLAG = [
  "error: unexpected argument '--format' found",
  "",
  "  tip: to pass '--format' as a value, use '-- --format'",
  "",
  "Usage: box profile show [OPTIONS] <NAME>",
  "",
  "For more information, try '--help'.",
];

/** What clap prints for `--full` in a box that has `--format` and no `--full`. */
const NO_FULL_FLAG = [
  "error: unexpected argument '--full' found",
  "",
  "Usage: box profile show [OPTIONS] <NAME>",
  "",
  "For more information, try '--help'.",
];

describe("BoxCliProfileResolver", () => {
  test("runs `box profile show <profile> --format json --full` in the project folder, with no colour", async () => {
    const fake = streamer(stdout(SHOWN));
    const resolver = new BoxCliProfileResolver({ env: { PATH: "/bin" }, ...fake });

    const resolved = await resolver.resolve("/work/demo", ".box/profile.toml");

    expect(resolved).toEqual(parseBoxProfileShow(SHOWN, ".box/profile.toml"));
    expect(fake.calls).toEqual([
      {
        command: ["box", "profile", "show", ".box/profile.toml", "--format", "json", "--full"],
        options: { cwd: "/work/demo", env: { PATH: "/bin", NO_COLOR: "1" } },
      },
    ]);
  });

  const COMMAND = ["box", "profile", "show", ".box/profile.toml", "--format", "json", "--full"];
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
      new BoxCliProfileResolver({ env: { PATH: "" }, ...fake }).resolve(
        "/work/demo",
        ".box/profile.toml",
      ),
    ).rejects.toThrow(
      new InvalidEnvironmentError(
        "Box is not installed or not on PATH. Install box 0.1.11-linux-preview.7 " +
          "(https://github.com/mquang-amazon/box-releases/releases/tag/v0.1.11-linux-preview.7), " +
          "then retry.",
      ),
    );
  });

  test("does not say Box is not installed when a signal stops the box on PATH", async () => {
    const bin = await mkdtemp(join(tmpdir(), "box-path-"));
    directories.push(bin);
    await writeFile(join(bin, process.platform === "win32" ? "box.exe" : "box"), "", {
      mode: 0o755,
    });
    const fake = streamer(
      [],
      new ProcessFailedError(COMMAND, "/work/demo", null, "terminated by SIGKILL"),
    );

    const error = await new BoxCliProfileResolver({ env: { PATH: bin }, ...fake })
      .resolve("/work/demo", ".box/profile.toml")
      .catch((caught: unknown) => caught);

    expect((error as Error).message).toBe(
      "Box stopped on .box/profile.toml with exit code unknown and printed no error. Run " +
        "'box profile show .box/profile.toml' in the project folder to see why.",
    );
  });

  test.each([
    ["--format", NO_JSON_FLAG],
    ["--full", NO_FULL_FLAG],
  ])(
    "says to install a Box with --format json --full when the box on PATH has no %s",
    async (_, stderr) => {
      const error = await failure(refusal(stderr, 2));

      expect(error).toBeInstanceOf(InvalidEnvironmentError);
      expect((error as Error).message).toBe(
        "This Box cannot print the profile .box/profile.toml as JSON, which build reads. Install " +
          `${PINNED}, then retry.`,
      );
    },
  );

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

const POLICY =
  "// No admin paths on GitHub.\n" +
  '@id("no_admin") forbid (principal, action == Box::Action::"http:request", resource) when { context.input.host == "api.github.com" && context.input.path like "/admin/*" };\n';
const ROUTES = {
  github: { destinations: ["api.github.com"] },
  keyed: { destinations: ["k.example.com:8443"], secret: { ref: "env://KEY" } },
};
const SERVERS = { docs: { type: "http", destinations: ["docs.example.com"] } };

/** Whether the box on PATH has `box profile show --format json --full`. */
const boxPrintsJson = (() => {
  if (!Bun.which("box")) return false;
  const help = Bun.spawnSync(["box", "profile", "show", "--help"], { stderr: "ignore" }).stdout;
  return ["--format", "--full"].every((flag) => help.toString().includes(flag));
})();

describe("the box on PATH", () => {
  test.skipIf(!boxPrintsJson)(
    "resolves a profile into the rules the tests fake (skipped when the box on PATH has no --format json --full)",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "box-profile-resolver-"));
      directories.push(root);
      await mkdir(join(root, ".box"), { recursive: true });
      await writeFile(
        join(root, ".box", "profile.toml"),
        'packs = ["@box/base"]\npolicies = ["policy.dw"]\n\n[profile]\nname = "resolver-test"\n\n' +
          '[agent]\ncommand = ["/bin/sh"]\n\n[egress.github]\ndestinations = ["api.github.com"]\n\n' +
          '[egress.keyed]\ndestinations = ["k.example.com:8443"]\nsecret.ref = "env://KEY"\n\n' +
          '[mcp.docs]\ntype = "http"\ndestinations = ["docs.example.com"]\n',
      );
      await writeFile(join(root, ".box", "policy.dw"), POLICY);

      const resolved = await new BoxCliProfileResolver().resolve(root, ".box/profile.toml");

      const lines = resolved.policy.split("\n");
      for (const rule of boxNetworkRules(ROUTES, SERVERS).trimEnd().split("\n")) {
        expect(lines).toContain(rule);
      }
    },
    120_000,
  );
});
