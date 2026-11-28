import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { InvalidEnvironmentError } from "../../errors/errors";
import type { ProjectRuntime } from "../../projectSchemas/runtime";
import { BoxDevRunner } from "../dev/box";
import { ProcessFailedError, type ProcessEvent, type StreamProcessOptions } from "../../io";
import { BOX_RELEASE } from "./backends/boxRelease";
import { BoxCliProfileResolver, parseBoxProfileShow } from "./boxProfileResolver";
import { boxErrorLines, boxNetworkRules, boxReachRules } from "./boxProfileResolver-test-support";

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

/** The last sentence of each error that says to install another box: the pinned release. */
const INSTALL = `Install box ${BOX_RELEASE.version} (https://github.com/strands-agents/box/releases/tag/v${BOX_RELEASE.version}), then retry.`;

/**
 * `box profile show open --format json --full` for a profile with the routes `auth` and `github`
 * with no secret, the route `keyed` with one, and {@link POLICY}, as box prints it, with HOME at
 * /tmp/acbox/home.
 */
const OPEN_ROUTES_SHOWN = readFileSync(
  join(import.meta.dir, "__fixtures__", "box-profile-show-open-routes-list.json"),
  "utf8",
);

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

  test("takes each open route, which box.toml leaves out, and its destinations", () => {
    const resolved = parseBoxProfileShow(OPEN_ROUTES_SHOWN, ".box/profile.toml");

    expect(resolved.openRoutes).toEqual([
      { route: "auth", destinations: ["login.example.com", "auth.example.com:8443"] },
      { route: "github", destinations: ["api.github.com"] },
    ]);
    expect(resolved.boxToml.egress).toEqual({
      keyed: { destinations: ["k.example.com:8443"], secret: { ref: "env://KEY" } },
    });
  });

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
        `Box printed the profile .box/profile.toml without ${lacks}, which build reads. ` + INSTALL,
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

  test("runs box in the start folder, with the profile path from there", async () => {
    const fake = streamer(stdout(SHOWN));
    const resolver = new BoxCliProfileResolver({ env: { PATH: "/bin" }, ...fake });

    await resolver.resolve("/work/demo", ".box/agent/local/profile.toml", "app/agent");

    expect(fake.calls).toEqual([
      {
        command: [
          "box",
          "profile",
          "show",
          "../../.box/agent/local/profile.toml",
          "--format",
          "json",
          "--full",
        ],
        options: { cwd: join("/work/demo", "app", "agent"), env: { PATH: "/bin", NO_COLOR: "1" } },
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

  test("says to install the pinned box when an older box refuses an @box/ pack", async () => {
    // An older box wraps its error, here inside the pack name's line.
    const error = await failure(
      refusal([
        'box: error: /work/demo/.box/profile.toml: "@box/base" is',
        "            not a pack name",
        "Usage: box profile show [OPTIONS] <NAME>",
      ]),
    );

    expect((error as Error).message).toBe(
      "Box refused the profile .box/profile.toml:\n" +
        '  box: error: /work/demo/.box/profile.toml: "@box/base" is\n' +
        "              not a pack name\n" +
        `This box is older than the pinned box, which names its packs @box/<name>. ${INSTALL}`,
    );
  });

  describe("the uv sync hint, when Box refuses a missing .venv under a write grant", () => {
    /** A project folder with a space in its path, and the agent folders `agent` and `my agent`. */
    const project = async () => {
      const root = await mkdtemp(join(tmpdir(), "box uv "));
      directories.push(root);
      await mkdir(join(root, "app", "agent"), { recursive: true });
      await mkdir(join(root, "app", "my agent"), { recursive: true });
      return root;
    };
    /** The last line of the error, which gives the hint. */
    const hint = async (root: string, lines: string[]) => {
      const error = await new BoxCliProfileResolver(refusal(lines))
        .resolve(root, ".box/profile.toml")
        .catch((caught: unknown) => caught);
      return (error as Error).message.split("\n").at(-1);
    };
    // Box 0.1.11-preview.10 wraps its error at 80 columns, at a space or inside a word, and
    // indents each next line by 12 spaces.
    const MORE = " ".repeat(12);
    const grant = (root: string) => `lies under the write grant ${root} of \`[agent]\``;

    test("names the agent's folder", async () => {
      const root = await project();
      const error = await new BoxCliProfileResolver(
        refusal([`box: error: ${root}/app/agent/.venv/bin/python ${grant(root)}`]),
      )
        .resolve(root, ".box/profile.toml")
        .catch((caught: unknown) => caught);

      expect((error as Error).message).toBe(
        "Box refused the profile .box/profile.toml:\n" +
          `  box: error: ${root}/app/agent/.venv/bin/python ${grant(root)}\n` +
          "Run 'uv sync' in app/agent, then retry.",
      );
    });

    test("quotes a folder with a space, which Box wraps at that space", async () => {
      const root = await project();
      const lines = [`box: error: ${root}/app/my`, `${MORE}agent/.venv/bin/python ${grant(root)}`];
      expect(await hint(root, lines)).toBe(`Run 'uv sync' in "app/my agent", then retry.`);
    });

    test("names the whole folder when Box wraps the path before the agent's folder", async () => {
      const root = await project();
      const lines = [`box: error: ${root}/app`, `${MORE}/agent/.venv/bin/python lies under the`];
      lines.push(`${MORE}write grant ${root} of \`[agent]\``);
      expect(await hint(root, lines)).toBe("Run 'uv sync' in app/agent, then retry.");
    });

    test("names the whole folder when Box wraps the path inside a word", async () => {
      const root = await project();
      const lines = [`box: error: ${root}/app/ag`, `${MORE}ent/.venv/bin/python ${grant(root)}`];
      expect(await hint(root, lines)).toBe("Run 'uv sync' in app/agent, then retry.");
    });

    test("names no folder when the path names no folder of the project", async () => {
      const root = await project();
      const lines = [`box: error: ${root}/app/gone/.venv/bin/python ${grant(root)}`];
      expect(await hint(root, lines)).toBe("Fix what Box reports, then retry.");
    });
  });

  describe("a profile name that an earlier agentcore dev bound to its copy", () => {
    /** A project `Demo`, and a box home whose record of `Demo-agent` names dev's copy. */
    const stuck = async () => {
      const folder = realpathSync(await mkdtemp(join(tmpdir(), "box-dev-name-")));
      directories.push(folder);
      const root = join(folder, "Demo");
      const copy = join(root, "agentcore", ".cli", "box-dev", "agent", "profile.toml");
      const record = join(folder, "box-home", "storage", "Demo-agent", ".profile-source");
      await mkdir(dirname(record), { recursive: true });
      await writeFile(record, `${copy}\n`);
      const refusal = boxErrorLines(
        `the profile name "Demo-agent" in ${join(root, ".box", "agent", "local", "profile.toml")} ` +
          `belongs to ${copy}; give this profile another \`[profile] name\``,
      );
      return { root, record, refusal, env: { BOX_HOME: join(folder, "box-home") } };
    };
    /** Box refuses the first show with `refusal`, and prints {@link SHOWN} for the next. */
    const refusedOnce = (refusal: string[]) => {
      const calls: string[][] = [];
      return {
        calls,
        async *streamProcess(command: string[]): AsyncGenerator<ProcessEvent> {
          calls.push(command);
          if (calls.length > 1) {
            yield* stdout(SHOWN);
            return;
          }
          for (const line of refusal) yield { type: "stderr", line };
          throw new ProcessFailedError(command, "/work/demo", 1, "box: error: ...");
        },
      };
    };

    test("releases the name, shows the profile again, and says what it removed", async () => {
      const { root, record, refusal, env } = await stuck();
      const fake = refusedOnce(refusal);

      const resolved = await new BoxCliProfileResolver({ env, ...fake }).resolve(
        root,
        ".box/agent/local/profile.toml",
      );

      expect(fake.calls).toHaveLength(2);
      expect(existsSync(record)).toBe(false);
      expect(resolved).toEqual({
        ...parseBoxProfileShow(SHOWN, ".box/agent/local/profile.toml"),
        notes: [expect.stringContaining(record)],
      });
    });

    test("shows Box's refusal when Box refuses the profile again", async () => {
      const { root, record, refusal, env } = await stuck();
      const fake = streamer(
        refusal.map((line) => ({ type: "stderr", line })),
        new ProcessFailedError(COMMAND, root, 1, "box: error: ..."),
      );

      const error = await new BoxCliProfileResolver({ env, ...fake })
        .resolve(root, ".box/agent/local/profile.toml")
        .catch((caught: unknown) => caught);

      expect(fake.calls).toHaveLength(2);
      expect(existsSync(record)).toBe(false);
      expect((error as Error).message).toStartWith(
        "Box refused the profile .box/agent/local/profile.toml:\n  box: error: the profile name",
      );
    });

    test("keeps a name that belongs to another profile file, and shows Box's refusal", async () => {
      const { root, record, env } = await stuck();
      await writeFile(record, `${join(root, "..", "mine", "profile.toml")}\n`);
      const refusal = boxErrorLines(
        `the profile name "Demo-agent" in ${join(root, ".box", "agent", "local", "profile.toml")} ` +
          `belongs to ${join(root, "..", "mine", "profile.toml")}; give this profile another ` +
          "`[profile] name`",
      );
      const fake = refusedOnce(refusal);

      const error = await new BoxCliProfileResolver({ env, ...fake })
        .resolve(root, ".box/agent/local/profile.toml")
        .catch((caught: unknown) => caught);

      expect(fake.calls).toHaveLength(1);
      expect(existsSync(record)).toBe(true);
      expect(error).toBeInstanceOf(InvalidEnvironmentError);
    });
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
      new InvalidEnvironmentError(`Box is not installed or not on PATH. ${INSTALL}`),
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
        "This Box cannot print the profile .box/profile.toml as JSON, which build reads. " +
          INSTALL,
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

  /** A project `Demo` with the local box profile `Demo-agent` of the CodeZip runtime `agent`. */
  const demo = async () => {
    const folder = realpathSync(await mkdtemp(join(tmpdir(), "box-dev-name-")));
    directories.push(folder);
    const root = join(folder, "Demo");
    await mkdir(join(root, ".box", "agent", "local"), { recursive: true });
    await writeFile(
      join(root, ".box", "agent", "local", "profile.toml"),
      'packs = ["@box/base"]\n\n[profile]\nname = "Demo-agent"\n\n[agent]\ncommand = ["/bin/sh"]\n',
    );
    await mkdir(join(root, "app", "agent", ".venv", "bin"), { recursive: true });
    await writeFile(join(root, "app", "agent", ".venv", "bin", "python"), "");
    const copy = join(root, "agentcore", ".cli", "box-dev", "agent", "profile.toml");
    const boxHome = join(folder, "box-home");
    /** Binds `name` to `owner`, as `box run` does before it starts the agent. */
    const bind = async (name: string, owner: string) => {
      const record = join(boxHome, "storage", name, ".profile-source");
      await mkdir(dirname(record), { recursive: true });
      await writeFile(record, `${owner}\n`);
      return record;
    };
    return { root, copy, bind, env: { ...process.env, BOX_HOME: boxHome } };
  };

  test.skipIf(!boxPrintsJson)(
    "shows the local profile after dev runs its copy, which box binds to a name of its own (skipped when the box on PATH has no --format json --full)",
    async () => {
      const { root, copy, bind, env } = await demo();
      const runner = new BoxDevRunner({
        fallback: { run: () => (async function* () {})() },
        streamProcess: async function* () {},
        runProcess: () => Promise.reject(new Error("no opentelemetry in the venv")),
        checkTool: () => Promise.resolve(),
        processEnv: env,
      });
      for await (const _ of runner.run({
        runtime: {
          name: "agent",
          build: "CodeZip",
          codeLocation: "app/agent",
          entrypoint: "main.py",
          box: { version: "1.0.0" },
        } as ProjectRuntime,
        projectRoot: root,
        boxProject: true,
        port: 8080,
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" },
        signal: new AbortController().signal,
      }));
      const name = (parseToml(readFileSync(copy, "utf8")) as { profile: { name: string } }).profile
        .name;
      const record = await bind(name, copy);

      const resolved = await new BoxCliProfileResolver({ env }).resolve(
        root,
        ".box/agent/local/profile.toml",
        "app/agent",
      );

      expect(name).toBe("Demo-agent-dev");
      expect(resolved.notes).toBeUndefined();
      expect(existsSync(record)).toBe(true);
    },
    120_000,
  );

  for (const [refusal, copyName] of [
    ["belongs to the copy", "Demo-agent"],
    ["was recorded for the copy", "Demo-agent-dev"],
  ] as const) {
    test.skipIf(!boxPrintsJson)(
      `shows the local profile when box says its name ${refusal} of an earlier dev (skipped when the box on PATH has no --format json --full)`,
      async () => {
        const { root, copy, bind, env } = await demo();
        await mkdir(dirname(copy), { recursive: true });
        await writeFile(
          copy,
          `packs = ["@box/base"]\n\n[profile]\nname = "${copyName}"\n\n[agent]\ncommand = ["/bin/sh"]\n`,
        );
        const record = await bind("Demo-agent", copy);

        const resolved = await new BoxCliProfileResolver({ env }).resolve(
          root,
          ".box/agent/local/profile.toml",
          "app/agent",
        );

        expect(resolved.notes).toEqual([expect.stringContaining(record)]);
        expect(existsSync(record)).toBe(false);
      },
      120_000,
    );
  }
});
