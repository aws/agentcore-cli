import { test, expect, describe, afterEach } from "bun:test";
import type { Command } from "commander";
import {
  renderScreen,
  waitForText,
  cleanupScreens,
  createSilentLogger,
  menuEntries,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../testing";
import { compile, isTuiCommandSupported, ValueContext } from "../router";
import { createRootHandler } from "../handlers";

afterEach(cleanupScreens);

function compiledRoot(): Command {
  return compile(
    createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    }),
    ValueContext.EmptyContext(),
  );
}

// cliOnlyCommands walks the compiled Commander tree for every command without
// a screen, so a command added later is covered without a new test. `help` is
// Commander's own, not one of ours.
function cliOnlyCommands(command = compiledRoot(), path: string[] = []): [string[], Command][] {
  const here = [...path, command.name()];
  const own: [string[], Command][] = isTuiCommandSupported(command) ? [] : [[here, command]];
  return [
    ...own,
    ...command.commands
      .filter((child) => child.name() !== "help")
      .flatMap((child) => cliOnlyCommands(child, here)),
  ];
}

const CLI_ONLY = cliOnlyCommands();

describe("menus list command-line-only subcommands below a divider", () => {
  test("the root menu", async () => {
    const r = renderScreen("/agentcore");

    await waitForText(r.lastFrame, "command line only");
    expect(menuEntries(r.lastFrame()!)).toEqual({
      screens: ["harness", "identity", "runtime", "memory", "gateway", "eval", "project"],
      cliOnly: ["feedback", "config", "update"],
    });
    r.unmount();
  });

  test("the eval menu", async () => {
    const r = renderScreen("/agentcore/eval");

    await waitForText(r.lastFrame, "command line only");
    expect(menuEntries(r.lastFrame()!).cliOnly).toEqual(["ondemand", "recommendation"]);
    r.unmount();
  });

  test("a menu whose every subcommand is command line only", async () => {
    const r = renderScreen("/agentcore/eval/recommendation");

    await waitForText(r.lastFrame, "command line only");
    expect(menuEntries(r.lastFrame()!)).toEqual({
      screens: [],
      cliOnly: ["start", "get", "list", "delete"],
    });
    r.unmount();
  });

  test("the divider is omitted when nothing is command line only", async () => {
    const r = renderScreen("/agentcore/harness");

    await waitForText(r.lastFrame, "manage AgentCore harnesses");
    expect(r.lastFrame()).not.toContain("command line only");
    r.unmount();
  });
});

describe("every command-line-only command opens on screen", () => {
  test("there are command-line-only commands to cover", () => {
    expect(CLI_ONLY.length).toBeGreaterThan(50);
  });

  test.each(CLI_ONLY.map(([path, command]) => [path.join(" "), path, command] as const))(
    "%s opens its menu or help, and esc returns to the parent",
    async (_label, path, command) => {
      const r = renderScreen("/" + path.join("/"));
      // Wide and tall enough that no option term wraps and nothing is below the
      // fold; scrolling and wrapping have their own tests.
      await r.resize(220, 200);
      const parent = command.parent!;

      if (command.commands.length > 0) {
        // A group opens its own menu, with every child under the divider.
        await waitForText(r.lastFrame, path.join(" → "));
        await waitForText(r.lastFrame, "command line only");
        expect(menuEntries(r.lastFrame()!).screens).toEqual([]);
      } else {
        await waitForText(r.lastFrame, "this command runs from the command line");
        const help = command.createHelp();
        const frame = r.lastFrame()!.replace(/\s+/g, " ");
        expect(frame).toContain(help.commandUsage(command));
        // Every option but --help, which means nothing on the help itself.
        for (const option of help.visibleOptions(command)) {
          if (option.long === "--help") expect(frame).not.toContain("--help");
          else expect(frame).toContain(help.optionTerm(option));
        }
        for (const argument of help.visibleArguments(command)) {
          expect(frame).toContain(help.argumentTerm(argument));
        }
      }

      await r.press("escape");
      await waitForText(r.lastFrame, parent.description());
      r.unmount();
    },
  );
});

describe("paths without a screen of their own", () => {
  test("an unknown path retains the standard help fallback", async () => {
    const r = renderScreen("/agentcore/gateway/no-such-command");

    await waitForText(() => r.frames.join("\n"), "Usage:");
    const output = r.frames.join("\n");
    expect(output).toContain("harness");
    expect(output).not.toContain("command line only");
    r.unmount();
  });

  test("a group drills down to a leaf's help and back", async () => {
    const r = renderScreen("/agentcore/gateway");

    await waitForText(r.lastFrame, "command line only");
    await r.write("create");
    await waitForText(r.lastFrame, "❯ create");
    await r.press("return");

    await waitForText(r.lastFrame, "agentcore → gateway → create");
    const frame = r.lastFrame()!.replace(/\s+/g, " ");
    expect(frame).toContain("this command runs from the command line");
    expect(frame).toContain("agentcore gateway create [options]");
    expect(frame).toContain("--authorizer-type");

    await r.press("escape");
    await waitForText(r.lastFrame, "manage AgentCore Gateways");
    r.unmount();
  });
});
