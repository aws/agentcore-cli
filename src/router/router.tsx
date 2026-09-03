import type { Argument, Flag, GlobalFlag, Handler } from "./handler";
import { type Middleware, type MiddlewareProvider, isMiddlewareProvider } from "./middleware";
import { type Context, type ContextKey, ValueContext, contextKey } from "./context";
import { applyGlobalFlags, formatParameterDetails, parseFlags, toOption } from "./flags";
import { parseArguments, toCommanderArgument } from "./args";

import { Command, CommanderError } from "commander";
import type { Logger } from "../logging";
import type { GlobalConfigAccessor } from "../globalConfig";
import type { Project } from "../handlers/project/types";
import { type MetricEvent } from "../telemetry";

// CommandKey exposes the Commander Command for the executing leaf via context.
export const CommandKey: ContextKey<Command> = contextKey<Command>("commander.command");
// PathKey exposes the path to the executing leaf via context.
export const PathKey: ContextKey<string> = contextKey<string>("path");

export const LoggerKey = contextKey<Logger>("logger");

export const CommandRunMetricEventKey =
  contextKey<MetricEvent<"cli.command_run">>("commandRunMetricEvent");

export const GlobalConfigAccessorKey: ContextKey<GlobalConfigAccessor> =
  contextKey<GlobalConfigAccessor>("globalConfigAccessor");
export const ProjectKey = contextKey<Project>("project");

// RoutedCommand keeps the compiled handler and Commander command tree together.
// TUI consumers can therefore read handler metadata without module-level state.
class RoutedCommand extends Command {
  constructor(readonly handler: Handler) {
    super(handler.name());
  }
}

export function isTuiCommandSupported(command: Command): boolean {
  return command instanceof RoutedCommand ? command.handler.doesSupportTui() : true;
}

// commandParameterDetails is the "Parameter details" section `--help` appends
// for flags with long-form documentation; undefined when the command has none.
// Commander emits added help text only on outputHelp, so helpInformation()
// does not include it and a TUI rendering of the help must ask for it.
export function commandParameterDetails(command: Command): string | undefined {
  return command instanceof RoutedCommand
    ? formatParameterDetails(command.handler.flags())
    : undefined;
}

interface TuiChildSupportProvider {
  supportsTuiCommand(commandName: string): boolean;
}

function isTuiChildSupportProvider(h: Handler): h is Handler & TuiChildSupportProvider {
  return typeof (h as Partial<TuiChildSupportProvider>).supportsTuiCommand === "function";
}

function withEffectiveTuiSupport(handler: Handler, supported: boolean): Handler {
  return {
    name: () => handler.name(),
    description: () => handler.description(),
    flags: () => handler.flags(),
    arguments: () => handler.arguments(),
    doesSupportTui: () => supported,
    handle: (ctx, flags, args) => handler.handle(ctx, flags, args),
    children: () => handler.children(),
  };
}

// DefaultHandle runs when a group is selected without a subcommand (e.g.
// `agentcore` or `agentcore harness`). It reads group-level/global flags from the
// context; own flags/arguments are not supported, so it receives empty objects.
export type DefaultHandle = (ctx: Context, flags: {}, args: {}) => Promise<void>;

// DefaultHandlerProvider is a branch node that also carries a leaf-like handler to
// execute when the branch is invoked without a subcommand. The returned Handler is
// adapted from the group's DefaultHandle (see Router.default).
export interface DefaultHandlerProvider {
  defaultHandler(): Handler | undefined;
}

export function isDefaultHandlerProvider(h: Handler): h is Handler & DefaultHandlerProvider {
  return typeof (h as Partial<DefaultHandlerProvider>).defaultHandler === "function";
}

// declareFlags wires a node's zod-typed flags onto a Commander command. Each
// flag's option shape (value/toggle, variadic, required, default) is derived
// from its schema; see flags.ts/toOption.
function declareFlags(c: Command, flags: Flag[]): void {
  for (const flag of flags) {
    c.addOption(toOption(flag));
  }
}

function declareArguments(c: Command, args: Argument[]): void {
  for (const arg of args) {
    c.addArgument(toCommanderArgument(arg));
  }
}

// attachAction wires `node` as the executing handler for command `c`. The
// accumulated middleware `stack` wraps the node (ancestor-first, via reduceRight),
// `globals` are validated and injected into the context under their keys, and the
// node's own `ownFlags` are parsed into the typed object handed to `handle`. This
// is shared by leaves and by a group's default handler so both execute uniformly.
function attachAction(
  c: Command,
  node: Handler,
  ctx: Context,
  stack: Middleware[],
  globals: GlobalFlag[],
  ownFlags: Flag[],
): void {
  const wrapped = stack.reduceRight((h, mw) => mw(h), node);
  // `optsWithGlobals()` merges this command's options with all ancestors', so
  // group-level flags declared higher in the tree are visible here regardless
  // of where they appear on the command line.
  c.action(async (...actionArgs: unknown[]) => {
    const command = actionArgs[actionArgs.length - 1] as Command;
    const merged = command.optsWithGlobals();

    recordCommandPath(ctx);

    // Inherited group/global flags -> context (typed, read via ctx.value(key)).
    let leafCtx = ctx.withValue(CommandKey, command);
    leafCtx = applyGlobalFlags(globals, merged, leafCtx);

    // Own flags -> the statically-typed object passed to handle.
    const parsedFlags = parseFlags(ownFlags, merged);
    const parsedArguments = parseArguments(node.arguments(), command);

    await wrapped.handle(leafCtx, parsedFlags, parsedArguments);
  });
}

// globalFlagsOf recovers the GlobalFlags (which double as context keys) from a
// node's declared flags. Only group flags created via globalFlag() carry a key.
function globalFlagsOf(node: Handler): GlobalFlag[] {
  return node.flags().filter((f): f is GlobalFlag => "id" in f);
}

/** Add the command path to active command run metric **/
function recordCommandPath(ctx: Context): void {
  ctx.value(CommandRunMetricEventKey)?.setAttributes({ command_path: ctx.value(PathKey) });
}

// compile walks the Handler tree into a Commander Command tree.
//
// `stack` is the accumulated middleware declared by ancestors. A node's own
// middleware is appended before descending, so middleware applies *down* the
// tree. The stack is materialized only at leaves (branches never execute), and
// `reduceRight` makes ancestor middleware the outermost wrapper so it runs first.
//
// `inheritedGlobals` are the group-level flags declared by ancestor groups. They
// accumulate down the tree the same way; at a leaf each is validated and injected
// into the context under its own key, so any descendant can read a group-level /
// global flag via `ctx.value(theGlobalFlag)`. A leaf's *own* flags remain the
// statically-typed object handed to `handle`.
export function compile(
  node: Handler,
  ctx: Context,
  stack: Middleware[] = [],
  inheritedGlobals: GlobalFlag[] = [],
  tuiSupported = true,
): Command {
  const effectiveTuiSupport = tuiSupported && node.doesSupportTui();
  const compiledNode = withEffectiveTuiSupport(node, effectiveTuiSupport);
  const c = new RoutedCommand(compiledNode);
  c.description(node.description());

  const ownFlags = node.flags();
  declareFlags(c, ownFlags);
  declareArguments(c, node.arguments());

  // Flags with long-form documentation get a "Parameter details" section after
  // the option list in `--help` output.
  const parameterDetails = formatParameterDetails(ownFlags);
  if (parameterDetails) {
    c.addHelpText("after", parameterDetails);
  }

  const own = isMiddlewareProvider(node) ? node.middlewares() : [];
  const nextStack = [...stack, ...own];

  const path = ctx.value(PathKey) || "";
  const newPath = `${path}/${node.name()}`;
  ctx = ctx.withValue(PathKey, newPath);

  // commander may fail on invalid flags before we are able to record on the happy path, so we must record here as well
  c.exitOverride((e) => {
    recordCommandPath(ctx);
    throw e;
  });

  const children = node.children();
  if (children.length > 0) {
    // attaching both children and subcommands leads to ambiguity.
    if (node.arguments().length > 0) {
      throw new Error(
        `Invalid command '${node.name()}' contains both subcommands and positional arguments.`,
      );
    }
    // A group's own global flags become inherited flags for everything beneath it.
    const childGlobals = [...inheritedGlobals, ...globalFlagsOf(node)];
    for (const child of children) {
      const childTuiSupported =
        effectiveTuiSupport &&
        (!isTuiChildSupportProvider(node) || node.supportsTuiCommand(child.name()));
      c.addCommand(compile(child, ctx, nextStack, childGlobals, childTuiSupported));
    }
    // A group may also carry a default handler that runs when it is invoked
    // without a subcommand. It executes with this group's own middleware and can
    // read this group's own globals (plus inherited ones) from the context; it
    // has no own flags/arguments (globals-only).
    const fallback = isDefaultHandlerProvider(node) ? node.defaultHandler() : undefined;
    if (fallback) {
      attachAction(
        c,
        withEffectiveTuiSupport(fallback, effectiveTuiSupport && fallback.doesSupportTui()),
        ctx,
        nextStack,
        childGlobals,
        [],
      );
    }
  } else {
    // Middleware wraps the node here; the wrapper's logic runs at leaf execution.
    attachAction(c, compiledNode, ctx, nextStack, inheritedGlobals, ownFlags);
  }

  return c;
}

export class Router implements Handler, MiddlewareProvider, DefaultHandlerProvider {
  private mws: Middleware[] = [];
  private handlers: Handler[] = [];
  private globalFlags: GlobalFlag[] = [];
  private defaultHandle?: DefaultHandle;
  private tuiCommandNames?: ReadonlySet<string>;
  private cliVersion?: string;

  constructor(
    private readonly cmdName: string,
    private readonly cmdDescription: string = "",
  ) {}

  // --- Router authoring API ---

  use(...middlewares: Middleware[]): this {
    this.mws.push(...middlewares);
    return this;
  }

  handler(handler: Handler): this {
    this.handlers.push(handler);
    return this;
  }

  groupFlags(...flags: GlobalFlag[]): this {
    this.globalFlags.push(...flags);
    return this;
  }

  // supportedTuiCommands limits this router's interactive menu and bare-command
  // TUI dispatch to the named children. Without this call, every child keeps the
  // existing TUI behavior.
  supportedTuiCommands(...commands: string[]): this {
    this.tuiCommandNames = new Set(commands);
    return this;
  }

  supportsTuiCommand(commandName: string): boolean {
    return this.tuiCommandNames?.has(commandName) ?? true;
  }

  // default registers a handler that runs when this group is selected without a
  // subcommand (e.g. `agentcore` or `agentcore harness`). It reads group-level
  // flags from the context and has no own flags/arguments.
  default(fn: DefaultHandle): this {
    this.defaultHandle = fn;
    return this;
  }

  // version makes a bare `--version`/`-V` on this router print the given
  // string and exit 0. It is handled before Commander parses (root command
  // only, like the original CLI) rather than registered as a Commander
  // option: a root-level --version option would shadow subcommands that
  // declare their own `--version <value>` flag (e.g. `harness version get`).
  version(version: string): this {
    this.cliVersion = version;
    return this;
  }

  // --- Handler API: a router is itself a mountable branch node ---

  name(): string {
    return this.cmdName;
  }

  description(): string {
    return this.cmdDescription;
  }

  // A router's flags are group-level (global): declared here, inherited by every
  // descendant and exposed through the context.
  flags(): Flag[] {
    return this.globalFlags;
  }

  // global arguments are not supported.
  arguments(): Argument[] {
    return [];
  }

  doesSupportTui(): boolean {
    return true;
  }

  // A group/branch never executes directly; it just hosts subcommands.
  async handle(_ctx: Context, _flags: any, _args: any): Promise<void> {}

  children(): Handler[] {
    return this.handlers;
  }

  // --- MiddlewareProvider: exposes this level's middleware to the walk ---

  middlewares(): Middleware[] {
    return this.mws;
  }

  // --- DefaultHandlerProvider: adapts the registered DefaultHandle into a leaf-
  // like Handler so compile() can wrap it in middleware and execute it uniformly.

  defaultHandler(): Handler | undefined {
    const fn = this.defaultHandle;
    if (!fn) return undefined;
    return {
      name: () => this.cmdName,
      description: () => this.cmdDescription,
      flags: () => [],
      arguments: () => [],
      doesSupportTui: () => true,
      handle: fn,
      children: () => [],
    };
  }

  // --- Router execution ---

  async route(argv: string[], ctx: Context = ValueContext.EmptyContext()): Promise<void> {
    const commandArgs = argv.slice(2);
    if (
      this.cliVersion &&
      commandArgs.length === 1 &&
      (commandArgs[0] === "--version" || commandArgs[0] === "-V")
    ) {
      process.stdout.write(`${this.cliVersion}\n`);
      // The same exit shape Commander's own version option produces, so the
      // error layer maps it to a silent exit 0.
      throw new CommanderError(0, "commander.version", this.cliVersion);
    }

    const command = compile(this, ctx);
    if (this.cliVersion) {
      command.addHelpText("after", `\nRun '${this.cmdName} --version' to print the CLI version.`);
    }
    await command.parseAsync(argv);
  }
}
