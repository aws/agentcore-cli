import { test, expect } from "bun:test";
import { Command } from "commander";
import z from "zod";

import {
  Router,
  CommandRunMetricEventKey,
  ValueContext,
  argument,
  compile,
  contextKey,
  createHandler,
  flag,
  globalFlag,
  isTuiCommandSupported,
  type Context,
  type Handler,
  type Middleware,
} from "./index";
import { AgentCoreCLIError, InputValidationError } from "../errors";
import { DefaultTelemetryClient } from "../telemetry";
import { createSilentLogger, TestGlobalConfigAccessor } from "../testing";

// --- helpers ---------------------------------------------------------------

// record is a test middleware that appends `label` to `log` when the node it
// wraps is executed, then delegates. It passes everything else through.
function record(log: string[], label: string): Middleware {
  return (h) => ({
    name: () => h.name(),
    description: () => h.description(),
    flags: () => h.flags(),
    arguments: () => h.arguments(),
    doesSupportTui: () => h.doesSupportTui(),
    children: () => h.children(),
    handle: async (ctx: Context, flags: any, args: any) => {
      log.push(label);
      await h.handle(ctx, flags, args);
    },
  });
}

function leaf(name: string, onHandle: () => void): Handler {
  return createHandler({
    name,
    description: "",
    handle: async () => onHandle(),
  });
}

// exitOverrideAll makes every command in the tree throw (instead of calling
// process.exit) and swallows its output, so validation failures are testable.
function exitOverrideAll(cmd: Command): Command {
  cmd.exitOverride();
  cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  cmd.commands.forEach(exitOverrideAll);
  return cmd;
}

// --- middleware ------------------------------------------------------------

test("middleware accumulates down the tree and wraps the leaf in ancestor-first order", async () => {
  const log: string[] = [];

  const greet = new Router("greet").use(record(log, "greet"));
  greet.handler(leaf("hi", () => log.push("handle")));

  const root = new Router("app").use(record(log, "root"));
  root.handler(greet);

  await root.route(["node", "app", "greet", "hi"]);

  // root (outermost) runs first, then greet, then the leaf handle.
  expect(log).toEqual(["root", "greet", "handle"]);
});

test("middleware applies only to the subtree where it is declared", async () => {
  const log: string[] = [];

  const greet = new Router("greet").use(record(log, "greet"));
  greet.handler(leaf("hi", () => log.push("hi-handle")));

  const root = new Router("app").use(record(log, "root"));
  root.handler(greet);
  root.handler(leaf("top", () => log.push("top-handle"))); // sibling of greet

  await root.route(["node", "app", "top"]);

  expect(log).toEqual(["root", "top-handle"]);
});

// --- TUI command support ---------------------------------------------------

test("all commands support the TUI when no allowlist is configured", () => {
  const nested = new Router("nested").handler(leaf("deep", () => {}));
  const root = new Router("app").handler(leaf("top", () => {})).handler(nested);

  const command = compile(root, ValueContext.EmptyContext());
  const top = command.commands.find((child) => child.name() === "top")!;
  const nestedCommand = command.commands.find((child) => child.name() === "nested")!;
  const deep = nestedCommand.commands.find((child) => child.name() === "deep")!;

  expect(isTuiCommandSupported(command)).toBe(true);
  expect(isTuiCommandSupported(top)).toBe(true);
  expect(isTuiCommandSupported(nestedCommand)).toBe(true);
  expect(isTuiCommandSupported(deep)).toBe(true);
});

test("a TUI allowlist supports named children and excludes other subtrees", () => {
  const nested = new Router("nested").handler(leaf("deep", () => {}));
  const root = new Router("app")
    .supportedTuiCommands("top")
    .handler(leaf("top", () => {}))
    .handler(nested);

  const command = compile(root, ValueContext.EmptyContext());
  const top = command.commands.find((child) => child.name() === "top")!;
  const nestedCommand = command.commands.find((child) => child.name() === "nested")!;
  const deep = nestedCommand.commands.find((child) => child.name() === "deep")!;

  expect(isTuiCommandSupported(top)).toBe(true);
  expect(isTuiCommandSupported(nestedCommand)).toBe(false);
  expect(isTuiCommandSupported(deep)).toBe(false);
});

// --- default handler (group invoked without a subcommand) ------------------

test("a group's default handler runs when it is invoked without a subcommand", async () => {
  let ran = false;

  const harness = new Router("harness").default(async () => {
    ran = true;
  });
  harness.handler(leaf("get", () => {}));

  const root = new Router("app");
  root.handler(harness);

  await root.route(["node", "app", "harness"]);

  expect(ran).toBe(true);
});

test("a subcommand still routes past the group's default handler", async () => {
  const log: string[] = [];

  const harness = new Router("harness").default(async () => {
    log.push("default");
  });
  harness.handler(leaf("get", () => log.push("get")));

  const root = new Router("app");
  root.handler(harness);

  await root.route(["node", "app", "harness", "get"]);

  expect(log).toEqual(["get"]); // default did NOT fire
});

test("the root's default handler runs when invoked with no subcommand", async () => {
  let ran = false;

  const root = new Router("app").default(async () => {
    ran = true;
  });
  root.handler(leaf("get", () => {}));

  await root.route(["node", "app"]);

  expect(ran).toBe(true);
});

test("middleware wraps the default handler ancestor-first", async () => {
  const log: string[] = [];

  const harness = new Router("harness").use(record(log, "harness")).default(async () => {
    log.push("default");
  });
  harness.handler(leaf("get", () => {}));

  const root = new Router("app").use(record(log, "root"));
  root.handler(harness);

  await root.route(["node", "app", "harness"]);

  // root (outermost) runs first, then harness, then the default handle.
  expect(log).toEqual(["root", "harness", "default"]);
});

test("the default handler reads group-level flags from the context", async () => {
  const RegionKey = globalFlag("region", "AWS region", z.string().default("us-east-1"));
  let region: string | undefined;

  const harness = new Router("harness").default(async (ctx) => {
    region = ctx.value(RegionKey);
  });
  harness.handler(leaf("get", () => {}));

  const root = new Router("app").groupFlags(RegionKey);
  root.handler(harness);

  await root.route(["node", "app", "harness", "--region", "us-west-2"]);

  expect(region).toBe("us-west-2");
});

test("a group's default handler reads its OWN group-level flags from the context", async () => {
  const LevelKey = globalFlag("level", "log level", z.string().default("info"));
  let level: string | undefined;

  // LevelKey is declared on the harness group itself, not an ancestor.
  const harness = new Router("harness").groupFlags(LevelKey).default(async (ctx) => {
    level = ctx.value(LevelKey);
  });
  harness.handler(leaf("get", () => {}));

  const root = new Router("app");
  root.handler(harness);

  await root.route(["node", "app", "harness", "--level", "debug"]);

  expect(level).toBe("debug");
});

// --- flags: typing + validation + coercion ---------------------------------

test("validates and passes a typed-by-name object to handle", async () => {
  let seen: { "harness-id": string } | undefined;

  const get = createHandler({
    name: "get",
    description: "",
    flags: [flag("harness-id", "id", z.string().max(5))],
    handle: async (_ctx, flags) => {
      seen = flags; // flags is typed { "harness-id": string }
    },
  });

  const root = new Router("app");
  root.handler(get);

  await root.route(["node", "app", "get", "--harness-id", "abc"]);

  expect(seen).toEqual({ "harness-id": "abc" });
});

test("auto-coerces raw string flag values to the schema's type", async () => {
  let seen: { count: number; verbose: boolean } | undefined;

  const add = createHandler({
    name: "add",
    description: "",
    flags: [flag("count", "n", z.number().int()), flag("verbose", "v", z.boolean())],
    handle: async (_ctx, flags) => {
      seen = flags; // { count: number; verbose: boolean }
    },
  });

  const root = new Router("app");
  root.handler(add);

  await root.route(["node", "app", "add", "--count", "42", "--verbose"]);

  expect(seen).toEqual({ count: 42, verbose: true });
});

test("boolean flags default to false when omitted", async () => {
  let seen: { verbose: boolean } | undefined;

  const run = createHandler({
    name: "run",
    description: "",
    flags: [flag("verbose", "v", z.boolean())],
    handle: async (_ctx, flags) => {
      seen = flags;
    },
  });

  const root = new Router("app");
  root.handler(run);

  await root.route(["node", "app", "run"]);

  expect(seen).toEqual({ verbose: false });
});

test("a boolean flag defaulting to true is declared as its --no- negation", async () => {
  const seen: { traces: boolean }[] = [];

  const run = createHandler({
    name: "run",
    description: "",
    flags: [flag("traces", "collect traces", z.boolean().default(true))],
    handle: async (_ctx, flags) => {
      seen.push(flags);
    },
  });

  const root = new Router("app");
  root.handler(run);

  await root.route(["node", "app", "run"]);
  await root.route(["node", "app", "run", "--no-traces"]);

  expect(seen).toEqual([{ traces: true }, { traces: false }]);
});

test("applies a schema default for an omitted flag", async () => {
  let seen: { count: number } | undefined;

  const opt = createHandler({
    name: "opt",
    description: "",
    flags: [flag("count", "n", z.coerce.number().default(7))],
    handle: async (_ctx, flags) => {
      seen = flags;
    },
  });

  const root = new Router("app");
  root.handler(opt);

  await root.route(["node", "app", "opt"]);

  expect(seen).toEqual({ count: 7 });
});

test("reports invalid input via command.error (throws under exitOverride)", async () => {
  const get = createHandler({
    name: "get",
    description: "",
    flags: [flag("harness-id", "id", z.string().max(3))],
    handle: async () => {
      throw new Error("handle should not run on invalid input");
    },
  });

  const root = new Router("app");
  root.handler(get);

  const cmd = exitOverrideAll(compile(root, ValueContext.EmptyContext()));

  await expect(
    cmd.parseAsync(["node", "app", "get", "--harness-id", "toolong"]), // exceeds max(3)
  ).rejects.toThrow(InputValidationError);
});

test("a required (non-optional) flag is mandatory", async () => {
  const get = createHandler({
    name: "get",
    description: "",
    flags: [flag("harness-id", "id", z.string())],
    handle: async () => {},
  });

  const root = new Router("app");
  root.handler(get);

  const cmd = exitOverrideAll(compile(root, ValueContext.EmptyContext()));

  // Omitting the mandatory option makes Commander reject before the handler runs.
  await expect(cmd.parseAsync(["node", "app", "get"])).rejects.toThrow();
});

// --- flag inheritance (group-level / global flags) -------------------------

test("a group-level flag is validated and exposed to descendants via typed context key", async () => {
  const RegionKey = globalFlag("region", "AWS region", z.string().default("us-east-1"));
  let region: string | undefined;
  let ownFlags: { id: string } | undefined;

  const get = createHandler({
    name: "get",
    description: "",
    flags: [flag("id", "id", z.string())],
    handle: async (ctx, flags) => {
      region = ctx.value(RegionKey); // typed string | undefined
      ownFlags = flags; // only the leaf's own flags
    },
  });

  // RegionKey declared as a global flag on the root group; `--id` on the leaf.
  const root = new Router("app").groupFlags(RegionKey);
  const harness = new Router("harness");
  harness.handler(get);
  root.handler(harness);

  await root.route(["node", "app", "harness", "get", "--id", "x", "--region", "us-west-2"]);

  expect(region).toBe("us-west-2");
  expect(ownFlags).toEqual({ id: "x" }); // inherited flag is NOT in the typed object
});

test("a group-level flag falls back to its schema default when omitted", async () => {
  const RegionKey = globalFlag("region", "AWS region", z.string().default("us-east-1"));
  let region: string | undefined;

  const get = createHandler({
    name: "get",
    description: "",
    handle: async (ctx) => {
      region = ctx.value(RegionKey);
    },
  });

  const root = new Router("app").groupFlags(RegionKey);
  root.handler(get);

  await root.route(["node", "app", "get"]);

  expect(region).toBe("us-east-1");
});

test("an invalid group-level flag is reported via command.error", async () => {
  const LevelKey = globalFlag("level", "log level", z.enum(["debug", "info"]));

  const get = createHandler({
    name: "get",
    description: "",
    handle: async () => {
      throw new Error("handle should not run on invalid input");
    },
  });

  const root = new Router("app").groupFlags(LevelKey);
  root.handler(get);

  const cmd = exitOverrideAll(compile(root, ValueContext.EmptyContext()));

  await expect(cmd.parseAsync(["node", "app", "get", "--level", "nope"])).rejects.toThrow(
    InputValidationError,
  );
});

test("ContextKey identity is by symbol, not name", () => {
  const a = contextKey<string>("dup");
  const b = contextKey<number>("dup"); // same name, distinct key
  const ctx = ValueContext.EmptyContext().withValue(a, "x").withValue(b, 7);

  expect(ctx.value(a)).toBe("x");
  expect(ctx.value(b)).toBe(7);
});

test("context.require throws when a key is absent", () => {
  const Missing = contextKey<string>("missing");
  expect(() => ValueContext.EmptyContext().require(Missing)).toThrow(/missing a required value/);
});

test("compile rejects a handler with both subcommands and positional arguments", () => {
  const child = createHandler({
    name: "child",
    description: "",
    handle: async () => {},
  });

  // A parent that has both a child handler and positional arguments is invalid.
  const parent = createHandler({
    name: "parent",
    description: "",
    arguments: [argument("id", "an id", z.string())],
    children: [child],
    handle: async () => {},
  });

  const root = new Router("app");
  root.handler(parent);

  expect(() => compile(root, ValueContext.EmptyContext())).toThrow(
    /contains both subcommands and positional arguments/,
  );
});

// --- positional arguments: typing + validation + coercion --------------------

test("validates, coerces, and passes typed positional arguments to handle", async () => {
  let seen: { name: string; port: number; verbose: boolean } | undefined;

  const serve = createHandler({
    name: "serve",
    description: "",
    arguments: [
      argument("name", "service name", z.string()),
      argument("port", "port number", z.coerce.number()),
      argument("verbose", "enable verbose mode", z.coerce.boolean()),
    ],
    handle: async (_ctx, _flags, args) => {
      seen = args;
    },
  });

  const root = new Router("app");
  root.handler(serve);

  await root.route(["node", "app", "serve", "api", "8080", "true"]);

  expect(seen).toEqual({ name: "api", port: 8080, verbose: true });
});

test("optional arguments resolve to undefined when omitted", async () => {
  let seen: { key: string | undefined } | undefined;

  const config = createHandler({
    name: "config",
    description: "",
    arguments: [argument("key", "config key", z.string().optional())],
    handle: async (_ctx, _flags, args) => {
      seen = args;
    },
  });

  const root = new Router("app");
  root.handler(config);

  await root.route(["node", "app", "config"]);

  expect(seen).toEqual({ key: undefined });
});

test("arguments with schema defaults use the default when omitted", async () => {
  let seen: { env: string } | undefined;

  const deploy = createHandler({
    name: "deploy",
    description: "",
    arguments: [argument("env", "target environment", z.string().default("prod"))],
    handle: async (_ctx, _flags, args) => {
      seen = args;
    },
  });

  const root = new Router("app");
  root.handler(deploy);

  await root.route(["node", "app", "deploy"]);

  expect(seen).toEqual({ env: "prod" });
});

test("variadic argument collects multiple values into an array", async () => {
  let seen: { files: string[] } | undefined;

  const lint = createHandler({
    name: "lint",
    description: "",
    arguments: [argument("files", "files to lint", z.array(z.string()))],
    handle: async (_ctx, _flags, args) => {
      seen = args;
    },
  });

  const root = new Router("app");
  root.handler(lint);

  await root.route(["node", "app", "lint", "a.ts", "b.ts", "c.ts"]);

  expect(seen).toEqual({ files: ["a.ts", "b.ts", "c.ts"] });
});

test("a required positional argument is mandatory", async () => {
  const get = createHandler({
    name: "get",
    description: "",
    arguments: [argument("id", "resource id", z.string())],
    handle: async () => {},
  });

  const root = new Router("app");
  root.handler(get);

  const cmd = exitOverrideAll(compile(root, ValueContext.EmptyContext()));

  await expect(cmd.parseAsync(["node", "app", "get"])).rejects.toThrow();
});

test("rejects an argument that fails schema validation", async () => {
  const config = createHandler({
    name: "config",
    description: "",
    arguments: [argument("key", "config key", z.string().max(3))],
    handle: async () => {
      throw new Error("handle should not run on invalid input");
    },
  });

  const root = new Router("app");
  root.handler(config);

  const cmd = exitOverrideAll(compile(root, ValueContext.EmptyContext()));

  await expect(cmd.parseAsync(["node", "app", "config", "toolong"])).rejects.toThrow(
    /Invalid value for argument 'key'/,
  );
});

test("compile rejects a variadic argument that is not the last positional", () => {
  const handler = createHandler({
    name: "cp",
    description: "",
    arguments: [
      argument("files", "source files", z.array(z.string())),
      argument("dest", "destination", z.string()),
    ],
    handle: async () => {},
  });

  const root = new Router("app");
  root.handler(handler);

  expect(() => compile(root, ValueContext.EmptyContext())).toThrow(
    /only the last argument can be variadic/,
  );
});

// --- flags + arguments together ----------------------------------------------

test("handler receives both flags and arguments separately", async () => {
  let seenFlags: { format: string } | undefined;
  let seenArgs: { key: string; value: string } | undefined;

  const set = createHandler({
    name: "set",
    description: "",
    flags: [flag("format", "output format", z.string())],
    arguments: [
      argument("key", "config key", z.string()),
      argument("value", "config value", z.string()),
    ],
    handle: async (_ctx, flags, args) => {
      seenFlags = flags;
      seenArgs = args;
    },
  });

  const root = new Router("app");
  root.handler(set);

  await root.route(["node", "app", "set", "--format", "json", "region", "us-west-2"]);

  expect(seenFlags).toEqual({ format: "json" });
  expect(seenArgs).toEqual({ key: "region", value: "us-west-2" });
});

test("handler with overlapping flag and arg names works independently", async () => {
  let seenFlags: { id: string } | undefined;
  let seenArgs: { id: string } | undefined;

  const get = createHandler({
    name: "get",
    description: "",
    flags: [flag("id", "flag id", z.string())],
    arguments: [argument("id", "arg id", z.string())],
    handle: async (_ctx, flags, args) => {
      seenFlags = flags;
      seenArgs = args;
    },
  });

  const root = new Router("app");
  root.handler(get);

  await root.route(["node", "app", "get", "--id", "flag-value", "arg-value"]);

  expect(seenFlags).toEqual({ id: "flag-value" });
  expect(seenArgs).toEqual({ id: "arg-value" });
});

// --- parameter details help ---------------------------------------------------

// helpOutput compiles the router, triggers `--help` on the given subcommand,
// and returns what Commander printed (exitOverride turns the post-help exit
// into a caught error).
async function helpOutput(root: Router, argv: string[]): Promise<string> {
  let out = "";
  const cmd = compile(root, ValueContext.EmptyContext());
  const capture = (c: Command): Command => {
    c.exitOverride();
    c.configureOutput({ writeOut: (s) => (out += s), writeErr: () => {} });
    c.commands.forEach(capture);
    return c;
  };
  capture(cmd);
  try {
    await cmd.parseAsync(["node", ...argv]);
  } catch {
    // commander.helpDisplayed
  }
  return out;
}

test("command groups omit Commander's generated help subcommand", async () => {
  const nested = new Router("nested").handler(leaf("deep", () => {}));
  const root = new Router("app").handler(nested);

  const command = compile(root, ValueContext.EmptyContext());
  const nestedCommand = command.commands.find((child) => child.name() === "nested")!;

  // Help generation used to materialize a synthetic `help [command]` child.
  command.helpInformation();
  nestedCommand.helpInformation();
  expect(command.commands.map((child) => child.name())).not.toContain("help");
  expect(nestedCommand.commands.map((child) => child.name())).not.toContain("help");

  const out = await helpOutput(root, ["app", "nested", "--help"]);
  expect(out).toContain("deep");
  expect(out).toContain("--help");
  expect(out).not.toContain("help [command]");
});

test("flags with long-form help render a Parameter details section", async () => {
  const create = createHandler({
    name: "create",
    description: "",
    flags: [
      flag("name", "the name", z.string().optional()),
      flag("model", "model config (JSON)", z.string().optional(), {
        help: `(JSON: tagged union object)\nThe model configuration.\n\nExample:\n  --model '{"a":1}'`,
      }),
    ],
    handle: async () => {},
  });
  const root = new Router("app");
  root.handler(create);

  const out = await helpOutput(root, ["app", "create", "--help"]);

  expect(out).toContain("Parameter details:");
  // The annotation shares the flag's line; the body is indented beneath it.
  expect(out).toContain("--model (JSON: tagged union object)");
  expect(out).toContain("      The model configuration.");
  expect(out).toContain(`--model '{"a":1}'`);
  // Flags without long-form help stay out of the section.
  expect(out).not.toContain("--name (");
});

test("commands without long-form flag help have no Parameter details section", async () => {
  const get = createHandler({
    name: "get",
    description: "",
    flags: [flag("id", "the id", z.string().optional())],
    handle: async () => {},
  });
  const root = new Router("app");
  root.handler(get);

  const out = await helpOutput(root, ["app", "get", "--help"]);

  expect(out).toContain("--id");
  expect(out).not.toContain("Parameter details:");
});

// --- telemetry: command path recording -------------------------------------

test.each([
  { scenario: "flag validation succeeds", idFlag: "abc", shouldThrow: false },
  { scenario: "flag validation fails", idFlag: "toolong", shouldThrow: true },
])("records command_path on the metric event when $scenario", async ({ idFlag, shouldThrow }) => {
  // we use a real command name here so that telemetry schemas accept the path produced below
  const get = createHandler({
    name: "config",
    description: "",
    flags: [flag("id", "id", z.string().max(3))],
    handle: async () => {},
  });

  const recordedMetrics: { metricName: string; value: number; attributes: Record<string, any> }[] =
    [];
  const inMemorySink = {
    getName: () => "InMemorySink",
    send: (metricName: string, value: number, attributes: Record<string, any>) => {
      recordedMetrics.push({ metricName, value, attributes });
    },
    shutdown: async () => {},
  };

  const telemetryClient = new DefaultTelemetryClient({
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    metricSinks: [inMemorySink],
  });

  const root = new Router("agentcore");
  root.handler(get);

  const commandRunMetricEvent = telemetryClient.createMetricEvent("cli.command_run");
  const ctx = ValueContext.EmptyContext().withValue(
    CommandRunMetricEventKey,
    commandRunMetricEvent,
  );
  const cmd = compile(root, ctx);

  if (shouldThrow) {
    await expect(cmd.parseAsync(["node", "agentcore", "config", "--id", idFlag])).rejects.toThrow();
    commandRunMetricEvent.setAttributes({ exit_reason: "failure" });
  } else {
    await cmd.parseAsync(["node", "agentcore", "config", "--id", idFlag]);
    commandRunMetricEvent.setAttributes({ exit_reason: "success" });
  }

  await commandRunMetricEvent.emit(100);

  expect(recordedMetrics).toHaveLength(1);
  expect(recordedMetrics[0]!.metricName).toBe("cli.command_run");
  expect(recordedMetrics[0]!.value).toBe(100);
  expect(recordedMetrics[0]!.attributes).toMatchObject({
    command_path: "/agentcore/config",
    exit_reason: shouldThrow ? "failure" : "success",
  });
});

test("--version on a versioned router prints the version and maps to exit 0", async () => {
  const root = new Router("agentcore").version("9.9.9");
  root.handler(
    createHandler({
      name: "noop",
      description: "",
      flags: [],
      handle: async () => {},
    }),
  );

  // Commander surfaces the version exit through exitOverride as a
  // CommanderError; the error layer maps its exitCode 0 through unchanged.
  const error = await root.route(["node", "agentcore", "--version"]).then(
    () => {
      throw new Error("expected --version to exit via CommanderError");
    },
    (e: unknown) => e,
  );
  expect(error).toMatchObject({ code: "commander.version", message: "9.9.9" });
  expect(AgentCoreCLIError.fromError(error).exitCode).toBe(0);
});

test("--version is an unknown option on a router without a version", async () => {
  const root = new Router("agentcore");
  root.handler(
    createHandler({
      name: "noop",
      description: "",
      flags: [],
      handle: async () => {},
    }),
  );

  await expect(root.route(["node", "agentcore", "--version"])).rejects.toMatchObject({
    code: "commander.unknownOption",
  });
});
