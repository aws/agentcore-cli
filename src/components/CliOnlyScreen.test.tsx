import { test, expect, describe, afterEach } from "bun:test";
import { Command, Option } from "commander";
import stringWidth from "string-width";
import {
  cleanupScreens,
  compiledRootCommand,
  hasCliDivider,
  menuEntries,
  renderScreen,
  waitFor,
  waitForText,
  inProjectContext,
} from "../testing";
import { CommandKey, isTuiCommandSupported } from "../router";

afterEach(cleanupScreens);

// Commands that close the TUI and run instead of showing their help (see
// CommandHandoffScreen); tui.test covers them.
const HANDED_OFF = new Set(["agentcore dev"]);

// cliOnlyCommands walks the compiled Commander tree for every command without
// a screen, so a command added later is covered without a new test. `help` is
// Commander's own, not one of ours.
function cliOnlyCommands(
  command = compiledRootCommand(),
  path: string[] = [],
): [string[], Command][] {
  const here = [...path, command.name()];
  const own: [string[], Command][] =
    isTuiCommandSupported(command) || HANDED_OFF.has(here.join(" ")) ? [] : [[here, command]];
  return [
    ...own,
    ...command.commands
      .filter((child) => child.name() !== "help")
      .flatMap((child) => cliOnlyCommands(child, here)),
  ];
}

const CLI_ONLY = cliOnlyCommands();

describe("menus separate mixed command groups with a divider", () => {
  test("the root menu", async () => {
    const r = renderScreen("/agentcore", { withContext: inProjectContext });

    await waitForText(r.lastFrame, "❯ dev");
    // build is hidden from the menu: deploy already runs it.
    expect(menuEntries(r.lastFrame()!)).toEqual({
      screens: [
        "dev",
        "deploy",
        "invoke",
        "status",
        "logs",
        "traces",
        "add",
        "remove",
        "export",
        "harness",
        "runtime",
        "gateway",
        "identity",
        "memory",
        "eval",
        "payment",
      ],
      cliOnly: ["feedback", "config", "update"],
    });
    r.unmount();
  });

  test("the eval menu", async () => {
    const r = renderScreen("/agentcore/eval");

    await waitFor(() => hasCliDivider(r.lastFrame()!));
    expect(menuEntries(r.lastFrame()!).cliOnly).toEqual(["ondemand"]);
    r.unmount();
  });

  test("a menu whose every subcommand is command line only has no redundant divider", async () => {
    const r = renderScreen("/agentcore/eval/ondemand");

    await waitForText(r.lastFrame, "❯ evaluate");
    expect(hasCliDivider(r.lastFrame()!)).toBe(false);
    expect(menuEntries(r.lastFrame()!)).toEqual({
      screens: ["evaluate", "simulate"],
      cliOnly: [],
    });
    r.unmount();
  });

  test("the harness menu", async () => {
    const r = renderScreen("/agentcore/harness");

    await waitForText(r.lastFrame, "type to choose a command");
    await r.resize(100, 45);
    expect(menuEntries(r.lastFrame()!)).toEqual({
      screens: [
        "create",
        "get",
        "list",
        "update",
        "delete",
        "invoke",
        "exec",
        "shell",
        "logs",
        "traces",
        "endpoint",
        "version",
      ],
      cliOnly: [],
    });
    expect(r.lastFrame()).toContain("── resources");
    expect(hasCliDivider(r.lastFrame()!)).toBe(false);
    r.unmount();
  });

  test("the divider is omitted when nothing is command line only", async () => {
    const r = renderScreen("/agentcore/harness/endpoint");

    await waitForText(r.lastFrame, "manage harness endpoints");
    expect(hasCliDivider(r.lastFrame()!)).toBe(false);
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
      const r = renderScreen("/" + path.join("/"), { withContext: inProjectContext });
      // Wide and tall enough that no option term wraps and nothing is below the
      // fold; scrolling and wrapping have their own tests.
      await r.resize(220, 200);
      const parent = command.parent!;

      if (command.commands.length > 0) {
        // A CLI-only group opens its own menu without a redundant separator.
        await waitForText(r.lastFrame, path.join(" → "));
        expect(hasCliDivider(r.lastFrame()!)).toBe(false);
        expect(menuEntries(r.lastFrame()!).screens).toEqual(
          command.commands.map((child) => child.name()),
        );
      } else {
        await waitForText(r.lastFrame, "run it with:");
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
  test("an unknown command retains the standard help fallback", async () => {
    const r = renderScreen("/agentcore/gateway/no-such-command");

    await waitForText(() => r.frames.join("\n"), "Usage:");
    const output = r.frames.join("\n");
    expect(output).toMatch(/^\s+create\s+/m);
    expect(output).not.toContain("type to choose a command");
    r.unmount();
  });

  test("a group drills down to a leaf's help and back", async () => {
    const r = renderScreen("/agentcore/eval/evaluator");

    await waitForText(r.lastFrame, "type to choose a command");
    expect(r.lastFrame()).toContain("── resources");
    await r.write("delete");
    await waitForText(r.lastFrame, "❯ delete");
    await r.press("return");

    await waitForText(r.lastFrame, "agentcore → eval → evaluator → delete");
    const frame = r.lastFrame()!.replace(/\s+/g, " ");
    expect(frame).toContain("run it with:");
    expect(frame).toContain("agentcore eval evaluator delete [options]");
    expect(frame).toContain("--id");

    await r.press("escape");
    await waitForText(r.lastFrame, "manage AgentCore evaluators");
    r.unmount();
  });
});

describe("option help groups", () => {
  // A heading is its own line, so match it that way: "evaluation" also appears
  // inside the "batch-evaluation" breadcrumb, and "configuration" inside flags
  // like --protocol-configuration.
  const headingLine = (title: string) => `\n ${title}\n`;

  test("a grouped command renders one section per heading, in --help order", async () => {
    const r = renderScreen("/agentcore/eval/batch-evaluation/evaluate");
    await r.resize(220, 200);

    await waitForText(r.lastFrame, "run it with:");
    const frame = r.lastFrame()!;
    const positions = [
      "configuration",
      "session source (choose exactly one)",
      "source filters",
      "evaluation",
    ].map((title) => frame.indexOf(headingLine(title)));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(frame).not.toContain(headingLine("other options"));
    expect(frame).not.toContain(headingLine("options"));
    const command = CLI_ONLY.find(
      ([path]) => path.join("/") === "agentcore/eval/batch-evaluation/evaluate",
    )![1];
    const help = command.createHelp();
    const descriptionColumns = help
      .visibleOptions(command)
      .filter((option) => option.long !== "--help")
      .map((option) => {
        const line = frame
          .split("\n")
          .find((line) => line.trimStart().startsWith(help.optionTerm(option)))!;
        const description = help.optionDescription(option);
        expect(line).toContain(description);
        return stringWidth(line.slice(0, line.indexOf(description)));
      });
    expect(new Set(descriptionColumns).size).toBe(1);
    r.unmount();
  });

  test("a command whose flags carry no group keeps a single options section", async () => {
    const r = renderScreen("/agentcore/eval/evaluator/delete");

    await waitForText(r.lastFrame, "run it with:");
    const frame = r.lastFrame()!;
    expect(frame).toContain(headingLine("options"));
    expect(frame).not.toContain(headingLine("configuration"));
    expect(frame).not.toContain(headingLine("source filters"));
    r.unmount();
  });

  test("arguments and visible option groups stay aligned across resizes", async () => {
    const root = compiledRootCommand();
    const longest = new Option("--longest-visible-option <value>", "LASTVALUE").helpGroup("Last:");
    root.addCommand(
      new Command("layout-probe")
        .argument("<input>", "ARGUMENTVALUE")
        .addOption(new Option("--short <value>", "FIRSTVALUE").helpGroup("First:"))
        .addOption(longest)
        .addOption(new Option(`--${"hidden".repeat(20)} <value>`, "HIDDENVALUE").hideHelp()),
    );
    const r = renderScreen("/agentcore/layout-probe", {
      withContext: (ctx) => ctx.withValue(CommandKey, root),
    });

    for (const width of [140, 60, 101, 140]) {
      await r.resize(width, 100);
      await waitForText(r.lastFrame, "LASTVALUE");
      const frame = r.lastFrame()!;
      const columns = ["ARGUMENTVALUE", "FIRSTVALUE", "LASTVALUE"].map((value) => {
        const line = frame.split("\n").find((line) => line.includes(value))!;
        return stringWidth(line.slice(0, line.indexOf(value)));
      });

      expect(new Set(columns).size).toBe(1);
      if (width === 140) expect(columns[0]).toBe(stringWidth(longest.flags) + 5);
      expect(frame).not.toContain("HIDDENVALUE");
      expect(frame).not.toContain("--help");
      expect(frame.split("\n").every((line) => stringWidth(line) <= width)).toBe(true);
    }
    r.unmount();
  });

  test("a scrolled help table remains reachable and clamps when the terminal grows", async () => {
    const root = compiledRootCommand();
    const command = new Command("scroll-probe").addOption(
      new Option("--short <value>", "FIRSTVALUE").helpGroup("First:"),
    );
    for (let index = 0; index < 14; index += 1) {
      command.addOption(
        new Option(
          `--field-${index} <value>`,
          `Field ${index} has a description that wraps in a narrow terminal`,
        ).helpGroup("More options:"),
      );
    }
    command.addOption(
      new Option("--longest-option-below-the-fold <value>", "FINALVALUE").helpGroup("Last:"),
    );
    root.addCommand(command);
    const r = renderScreen("/agentcore/scroll-probe", {
      withContext: (ctx) => inProjectContext(ctx.withValue(CommandKey, root)),
    });

    await r.resize(80, 16);
    await waitForText(r.lastFrame, "FIRSTVALUE");
    expect(r.lastFrame()).not.toContain("FINALVALUE");

    for (const width of [80, 60]) {
      await r.resize(width, 16);
      for (let page = 0; page < 30 && !r.lastFrame()?.includes("FINALVALUE"); page += 1) {
        await r.write("\u001b[6~");
      }
      await waitForText(r.lastFrame, "FINALVALUE");
      await r.write("\u001b[6~");
      const bottom = r.lastFrame();
      await r.write("\u001b[6~");
      expect(r.lastFrame()).toBe(bottom);
      expect(r.lastFrame()).toContain("FINALVALUE");
    }

    await r.resize(180, 100);
    await waitForText(r.lastFrame, "run it with:");
    expect(r.lastFrame()).toContain("FIRSTVALUE");
    expect(r.lastFrame()).toContain("FINALVALUE");
    await r.press("escape");
    await waitForText(r.lastFrame, "add project resources");
    r.unmount();
  });
});
