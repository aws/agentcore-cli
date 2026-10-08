import { test, expect, describe, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { PACKAGE_VERSION } from "../constants";
import {
  cleanupScreens,
  inProjectContext,
  hasCliDivider,
  menuEntries,
  renderScreen,
  TestCoreClient,
  testIO,
  tick,
  waitForText,
  compiledRootCommand,
} from "../testing";
import { glyphs } from "./ui/_core";
import { createProjectHandlers } from "../handlers/project";
import type { Project } from "../handlers/project/types";

afterEach(cleanupScreens);

const PROJECT_WORKFLOW = [
  "create",
  "dev",
  "deploy",
  "invoke",
  "status",
  "logs",
  "traces",
  "add",
  "remove",
  "export",
  "build",
];

// menuGroups reads a RouterScreen frame's option names in display order,
// grouped under the divider each follows (untitled for the leading group). The
// command-line-only divider is drawn as a bare rule — the one between the
// filter row's rule and the footer's — and is labelled "cli" here.
function menuGroups(frame: string): { title: string | undefined; names: string[] }[] {
  const lines = frame.split("\n");
  const filterRow = lines.findIndex((line) => /^\s*\/ /.test(line));
  const footerRow = lines.findLastIndex((line) => /^─+$/.test(line.trim()));
  const groups: { title: string | undefined; names: string[] }[] = [];
  lines.forEach((line, index) => {
    const divider = /^── (.+?) ─/.exec(line);
    if (divider) {
      groups.push({ title: divider[1], names: [] });
      return;
    }
    if (index > filterRow + 1 && index < footerRow && /^─+$/.test(line.trim())) {
      groups.push({ title: "cli", names: [] });
      return;
    }
    const option = /^\s{1,3}(?:❯ )?\s*([a-z][a-z0-9-]*)\s{2,}\S/.exec(line);
    if (!option) return;
    if (groups.length === 0) groups.push({ title: undefined, names: [] });
    groups[groups.length - 1]!.names.push(option[1]!);
  });
  return groups;
}

// RouterScreen is the interactive command menu. These tests mount it through the
// real Root at a command path and drive it with key presses, asserting on the
// rendered frames — behavior a user would see, not internal state.

describe("menu rendering", () => {
  test.each([
    {
      path: "/agentcore/gateway",
      actions: ["create", "get", "list", "invoke"],
      related: ["target", "connector", "rule", "policy"],
      cli: [],
    },
    {
      path: "/agentcore/memory",
      actions: ["create", "get", "list"],
      related: ["event", "record", "actor", "session"],
      cli: [],
    },
    {
      path: "/agentcore/harness",
      actions: ["create", "get", "list", "update", "delete", "invoke", "exec", "shell"],
      related: ["logs", "traces", "endpoint", "version"],
      cli: [],
    },
    {
      path: "/agentcore/runtime",
      actions: ["create", "get", "list", "invoke", "shell", "exec"],
      related: ["version", "endpoint", "logs", "traces"],
      cli: [],
    },
    {
      path: "/agentcore/eval/evaluator",
      actions: ["get", "list", "delete"],
      related: ["llm-as-a-judge", "code-based"],
      cli: [],
    },
    {
      path: "/agentcore/eval/config-bundle",
      actions: ["create", "get", "list", "update", "delete"],
      related: ["version"],
      cli: [],
    },
    {
      path: "/agentcore/eval/ab-test",
      actions: ["get", "list", "pause", "resume", "stop", "delete"],
      related: ["config-based", "target-based"],
      cli: [],
    },
  ])(
    "$path separates actions from related commands in TUI and help",
    async ({ path, actions, related, cli }) => {
      const r = renderScreen(path);
      await waitForText(r.lastFrame, "type to choose a command");
      await r.resize(100, 45);
      const groups = menuGroups(r.lastFrame()!);
      expect(groups).toEqual([
        { title: undefined, names: [...actions] },
        { title: "related commands", names: [...related] },
        ...(cli.length ? [{ title: "cli", names: [...cli] }] : []),
      ]);
      r.unmount();

      const command = path
        .split("/")
        .filter(Boolean)
        .slice(1)
        .reduce(
          (parent, name) => parent.commands.find((child) => child.name() === name)!,
          compiledRootCommand(),
        );
      const help = command.helpInformation();
      const directHelp = help.split("Commands:\n")[1]?.split("Related commands:\n")[0] ?? "";
      const relatedHelp = help.split("Related commands:\n")[1] ?? "";
      for (const name of actions.filter((action) =>
        command.commands.some((child) => child.name() === action),
      )) {
        expect(directHelp).toMatch(new RegExp(`^  ${name} {2,}`, "m"));
      }
      for (const name of related) expect(relatedHelp).toMatch(new RegExp(`^  ${name} {2,}`, "m"));
      expect(relatedHelp).not.toBe("");
    },
  );

  test.each([
    "/agentcore/logs",
    "/agentcore/traces",
    "/agentcore/harness/traces",
    "/agentcore/runtime/traces",
    "/agentcore/payment",
    "/agentcore/payment/connector",
    "/agentcore/payment/manager",
    "/agentcore/payment/session",
    "/agentcore/payment/instrument",
  ])("%s has no extra divider above a CLI-only menu", async (path) => {
    const r = renderScreen(path, { withContext: inProjectContext });
    await waitForText(r.lastFrame, "type to choose a command");

    const frame = r.lastFrame()!;
    const lines = frame.split("\n");
    const filterRow = lines.findIndex((line) => /^\s*\/ /.test(line));
    expect(lines[filterRow + 2]).toMatch(/^\s*❯ /);
    expect(hasCliDivider(frame)).toBe(false);
    r.unmount();
  });

  test("CLI-only command names use the same white and focused colors as other commands", () => {
    // A separate process keeps ANSI enabled without changing the plain-text screen tests.
    const result = spawnSync(
      process.execPath,
      [
        "--eval",
        `
          import { renderScreen, waitForText } from "./src/testing/renderScreen.tsx";
          const frames = [];
          for (const [path, selected] of [
            ["/agentcore", "feedback"],
            ["/agentcore/harness", "logs"],
          ]) {
            const screen = renderScreen(path);
            await waitForText(screen.lastFrame, selected);
            const idle = screen.lastFrame();
            await screen.write(selected);
            frames.push({ idle, focused: screen.lastFrame(), selected });
            screen.unmount();
          }
          process.stdout.write(JSON.stringify(frames));
        `,
      ],
      {
        cwd: new URL("../../", import.meta.url),
        env: { ...process.env, FORCE_COLOR: "3", NO_COLOR: undefined, WT_SESSION: "bun-test" },
        timeout: 10_000,
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(0);
    const frames = JSON.parse(result.stdout) as {
      idle: string;
      focused: string;
      selected: string;
    }[];
    for (const [index, names] of [
      ["runtime", "feedback", "config", "update"],
      ["get", "update", "logs", "traces"],
    ].entries()) {
      const frame = frames[index]!;
      for (const name of names) expect(frame.idle).toContain(`\u001b[37m${name}`);
      expect(frame.focused).toContain(`\u001b[36m${glyphs.pointer} \u001b[1m${frame.selected}`);
    }
  });

  test("lists the current command's subcommands with their descriptions", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "No project detected");

    const frame = r.lastFrame()!;
    const entries = menuEntries(frame);
    expect(entries.screens).toContain("create");
    expect(entries.screens).toContain("eval");
    const visible = [...entries.screens, ...entries.cliOnly];
    const projectCommands = createProjectHandlers(r.core, testIO().io)
      .slice(1)
      .map((handler) => handler.name());
    for (const command of projectCommands) expect(visible).not.toContain(command);
    expect(frame.split("\n").filter((line) => line.includes("❯ "))).toHaveLength(1);
    expect(new Set([...entries.screens, ...entries.cliOnly]).size).toBe(
      entries.screens.length + entries.cliOnly.length,
    );
    expect(frame).toContain("config");
    expect(frame).toContain("read/write global config values");
    r.unmount();
  });

  test("lists the resource commands in the root menu", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "type to choose a command");

    const entries = menuEntries(r.lastFrame()!);
    expect(entries.screens).toEqual(
      expect.arrayContaining(["harness", "identity", "runtime", "memory", "gateway", "payment"]),
    );
    expect(entries.cliOnly).not.toContain("payment");
    r.unmount();
  });

  test("a direct root screen render does not resolve a project from the test cwd", async () => {
    const core = new TestCoreClient();
    let resolveCalls = 0;
    core.projectManager.resolve = async () => {
      resolveCalls++;
      throw new Error("unexpected filesystem project lookup");
    };

    const r = renderScreen("/agentcore", { core });
    await waitForText(r.lastFrame, "❯ create");
    expect(resolveCalls).toBe(0);
    r.unmount();
  });

  test("lists the resources under a resources divider, harness first, after the project commands", async () => {
    const r = renderScreen("/agentcore", { withContext: inProjectContext });
    await waitForText(r.lastFrame, "❯ dev");

    expect(menuGroups(r.lastFrame()!)).toEqual([
      // create and build are hidden inside a project; build stays in --help.
      {
        title: undefined,
        names: PROJECT_WORKFLOW.filter((name) => name !== "create" && name !== "build"),
      },
      {
        title: "resources",
        names: ["harness", "runtime", "gateway", "identity", "memory", "eval", "payment"],
      },
      { title: "cli", names: ["feedback", "config", "update"] },
    ]);
    r.unmount();
  });

  test("selecting update opens its screen", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "type to choose a command");

    await r.write("update");
    await waitForText(r.lastFrame, "❯ update");
    await r.press("return");
    await waitForText(r.lastFrame, `AgentCore ${PACKAGE_VERSION} is up to date.`);
    r.unmount();
  });

  test("keeps the resources divider when filtering leaves a resource", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "type to choose a command");

    await r.write("harn");
    await waitForText(r.lastFrame, "❯ harness");
    const frame = r.lastFrame()!;
    expect(frame).toContain("── resources");
    expect(hasCliDivider(frame)).toBe(false);
    r.unmount();
  });

  test("filtering to the project workflow leaves no resources divider", async () => {
    const r = renderScreen("/agentcore", { withContext: inProjectContext });
    await waitForText(r.lastFrame, "type to choose a command");

    await r.write("dep");
    await waitForText(r.lastFrame, "❯ deploy");
    expect(r.lastFrame()).not.toContain("── resources");
    r.unmount();
  });

  test("shows the command description in the header", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "the platform for production AI agents");
    r.unmount();
  });

  test("shows the brand banner only on the root menu", async () => {
    const version = `CLI v${PACKAGE_VERSION}`;
    const root = renderScreen("/agentcore");
    await waitForText(root.lastFrame, version);

    expect(root.lastFrame()).toContain(version);
    root.unmount();

    const nested = renderScreen("/agentcore/harness");
    await waitForText(nested.lastFrame, "agentcore → harness");

    expect(nested.lastFrame()).not.toContain(version);
    nested.unmount();
  });

  test("hides the brand banner when the terminal is short and restores it when enlarged", async () => {
    const version = `CLI v${PACKAGE_VERSION}`;
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, version);

    await r.resize(80, 24);
    expect(r.lastFrame()).not.toContain(version);
    expect(r.lastFrame()).toContain("[enter] select");

    await r.resize(100, 40);
    await waitForText(r.lastFrame, version);
    r.unmount();
  });

  test("renders the harness subcommands when mounted at the harness path", async () => {
    const r = renderScreen("/agentcore/harness");
    await waitForText(r.lastFrame, "list");

    const frame = r.lastFrame()!;
    for (const sub of ["get", "list", "create", "update", "delete", "invoke", "exec"]) {
      expect(frame).toContain(sub);
    }
    r.unmount();
  });

  test("highlights the first option by default", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "type to choose a command");
    // The focus caret marks the highlighted row; the first option is create.
    expect(r.lastFrame()).toContain("❯ create");
    r.unmount();
  });

  test("marks create as the starting point without a project and hides it inside one", async () => {
    const startHere = `${glyphs.leftArrow} start here`;

    const noProjectCore = new TestCoreClient();
    noProjectCore.projectManager.resolve = async () => undefined;
    const withoutProject = renderScreen("/agentcore", { core: noProjectCore });
    await waitForText(withoutProject.lastFrame, startHere);
    expect(withoutProject.lastFrame()).toContain("create");
    withoutProject.unmount();

    const withProject = renderScreen("/agentcore", { withContext: inProjectContext });
    await waitForText(withProject.lastFrame, "❯ dev");
    expect(menuEntries(withProject.lastFrame()!).screens).not.toContain("create");
    expect(menuEntries(withProject.lastFrame()!).screens).not.toContain("build");
    withProject.unmount();
  });

  test("shows the no-project banner only when no enclosing project is detected", async () => {
    const banner = "No project detected - create a new project to get started";

    const noProjectCore = new TestCoreClient();
    noProjectCore.projectManager.resolve = async () => undefined;
    const withoutProject = renderScreen("/agentcore", { core: noProjectCore });
    await waitForText(withoutProject.lastFrame, banner);
    const frame = withoutProject.lastFrame()!;
    expect(frame).toContain(`${glyphs.info} ${banner}`);
    expect(frame.indexOf("type to choose a command")).toBeLessThan(frame.indexOf(banner));
    expect(frame.indexOf(banner)).toBeLessThan(frame.indexOf("create"));
    withoutProject.unmount();

    const withProject = renderScreen("/agentcore", { withContext: inProjectContext });
    await waitForText(withProject.lastFrame, "type to choose a command");
    await tick(20);
    expect(withProject.lastFrame()).not.toContain(banner);
    withProject.unmount();
  });
});

describe("narrow terminals", () => {
  test("a description too long for the row leaves every command name in the same column", async () => {
    const r = renderScreen("/agentcore/add");
    await waitForText(r.lastFrame, "❯ ");
    // resize resolves once the frame is laid out at the new width.
    await r.resize(60);

    const lines = r.lastFrame()!.split("\n");
    const nameColumns = lines
      .map((line) => /^\s{1,3}(?:❯ )?\s*[a-z][a-z0-9-]*\s{2,}\S/.exec(line)?.[0])
      .filter((row) => row !== undefined)
      .map((row) => row.replace("❯", " ").search(/[a-z]/));
    expect(nameColumns.length).toBeGreaterThan(1);
    expect(new Set(nameColumns).size).toBe(1);
    r.unmount();
  });
});

describe("filtering", () => {
  test("removes the CLI-only divider when filtering leaves only that group and restores it", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "❯ create");
    expect(hasCliDivider(r.lastFrame()!)).toBe(true);

    await r.write("feedback");
    await waitForText(r.lastFrame, "❯ feedback");
    expect(hasCliDivider(r.lastFrame()!)).toBe(false);

    for (const _ of "feedback") await r.press("backspace");
    await waitForText(r.lastFrame, "❯ create");
    expect(hasCliDivider(r.lastFrame()!)).toBe(true);
    r.unmount();
  });

  test("typing narrows the options to matches", async () => {
    const r = renderScreen("/agentcore/harness");
    await waitForText(r.lastFrame, "list");

    await r.write("cr"); // matches "create" only
    await waitForText(r.lastFrame, "❯ create");

    const frame = r.lastFrame()!;
    expect(frame).toContain("create");
    expect(frame).not.toContain("list");
    expect(frame).not.toContain("delete");
    r.unmount();
  });

  test("filtering is case-insensitive", async () => {
    const r = renderScreen("/agentcore/harness");
    await waitForText(r.lastFrame, "list");

    await r.write("LIST");
    await waitForText(r.lastFrame, "❯ list");
    r.unmount();
  });

  test("shows a no-matches message when nothing matches", async () => {
    const r = renderScreen("/agentcore/harness");
    await waitForText(r.lastFrame, "list");

    await r.write("zzz");
    await waitForText(r.lastFrame, "No matches");
    r.unmount();
  });
});

describe("navigation", () => {
  test("down arrow moves the highlight to the next option", async () => {
    const r = renderScreen("/agentcore", { withContext: inProjectContext });
    await waitForText(r.lastFrame, "❯ dev");

    await r.press("down");
    await waitForText(r.lastFrame, "❯ deploy");
    r.unmount();
  });

  test("up arrow does not move past the first option", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "❯ create");

    await r.press("up");
    await tick(20);
    // Still on the first option.
    expect(r.lastFrame()).toContain("❯ create");
    r.unmount();
  });

  test("enter navigates into the highlighted subcommand's screen", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "❯ create");

    await r.press("return");
    await waitForText(r.lastFrame, "name your project");
    r.unmount();
  });

  test("esc from a nested menu returns to the parent menu", async () => {
    const r = renderScreen("/agentcore/harness");
    await waitForText(r.lastFrame, "agentcore → harness");

    await r.press("escape");
    // Back at the root menu (breadcrumb no longer includes harness).
    await waitForText(r.lastFrame, "❯ create");
    expect(r.lastFrame()).toContain("❯ create");
    r.unmount();
  });

  test("project detection waits until a nested launch navigates to the root menu", async () => {
    const core = new TestCoreClient();
    let resolveCalls = 0;
    core.projectManager.resolve = async () => {
      resolveCalls++;
      return {} as Project;
    };
    const r = renderScreen("/agentcore/harness", { core });
    await waitForText(r.lastFrame, "agentcore → harness");
    expect(resolveCalls).toBe(0);

    await r.press("escape");
    await waitForText(r.lastFrame, "❯ dev");
    expect(resolveCalls).toBe(1);
    r.unmount();
  });

  test("esc at the root menu is a no-op (no parent to go to)", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "❯ create");

    await r.press("escape");
    await tick(20);
    expect(r.lastFrame()).toContain("❯ create");
    r.unmount();
  });

  test("footer shows the esc hint only when there is a parent menu", async () => {
    const root = renderScreen("/agentcore");
    await waitForText(root.lastFrame, "❯ create");
    expect(root.lastFrame()).not.toContain("[esc]");
    root.unmount();

    const nested = renderScreen("/agentcore/harness");
    await waitForText(nested.lastFrame, "agentcore → harness");
    expect(nested.lastFrame()).toContain("[esc] back");
    nested.unmount();
  });
});

describe("short terminals", () => {
  const ROWS = 15;

  test("does not reserve a row for a redundant CLI-only divider", async () => {
    const r = renderScreen("/agentcore/logs", { withContext: inProjectContext });
    await waitForText(r.lastFrame, "❯ runtime");
    await r.resize(100, 8);

    expect(r.lastFrame()).toContain("❯ runtime");
    expect(r.lastFrame()).toContain("harness");
    expect(r.lastFrame()).not.toContain("more");
    expect(hasCliDivider(r.lastFrame()!)).toBe(false);
    r.unmount();
  });

  // fullMenu renders the root menu at the default height, where every option fits.
  async function fullMenu() {
    const r = renderScreen("/agentcore", { withContext: inProjectContext });
    await waitForText(r.lastFrame, "❯ dev");
    const frame = r.lastFrame()!;
    r.unmount();
    const titles = new Map<string, string | undefined>();
    for (const group of menuGroups(frame)) {
      for (const name of group.names) titles.set(name, group.title);
    }
    // Option rows keyed by name, without the highlight caret.
    const lines = new Map<string, string>();
    for (const line of frame.split("\n")) {
      const name = /^\s{1,3}(?:❯ )?\s*([a-z][a-z0-9-]*)\s{2,}\S/.exec(line)?.[1];
      if (name) lines.set(name, line.replace("❯", " "));
    }
    return { names: [...titles.keys()], titles, lines };
  }

  function highlighted(frame: string): string | undefined {
    return /❯ ([a-z][a-z0-9-]*)/.exec(frame)?.[1];
  }

  function more(frame: string, arrow: "↑" | "↓"): number | undefined {
    const count = new RegExp(`^\\s+${arrow} (\\d+) more`, "m").exec(frame)?.[1];
    return count === undefined ? undefined : Number(count);
  }

  async function shortMenu() {
    const r = renderScreen("/agentcore", { withContext: inProjectContext });
    await waitForText(r.lastFrame, "❯ dev");
    await r.resize(100, ROWS);
    return r;
  }

  // expectConsistentWindow checks one short frame against the full menu: it
  // fills the terminal exactly, every listed option is a whole row under its
  // own section title, and the markers account for every hidden option.
  function expectConsistentWindow(frame: string, full: Awaited<ReturnType<typeof fullMenu>>) {
    expect(frame.split("\n")).toHaveLength(ROWS);
    const groups = menuGroups(frame);
    const visible = groups.flatMap((group) => group.names);
    expect(visible.length).toBeGreaterThan(0);
    for (const group of groups) {
      for (const name of group.names) expect(group.title).toBe(full.titles.get(name));
    }
    const optionLines = frame
      .split("\n")
      .filter((line) => /^\s{1,3}(?:❯ )?\s*[a-z][a-z0-9-]*\s{2,}\S/.test(line));
    expect(optionLines.map((line) => line.replace("❯", " "))).toEqual(
      visible.map((name) => full.lines.get(name)!),
    );
    const first = full.names.indexOf(visible[0]!);
    expect(full.names.slice(first, first + visible.length)).toEqual(visible);
    expect(more(frame, "↑")).toBe(first > 0 ? first : undefined);
    const below = full.names.length - first - visible.length;
    expect(more(frame, "↓")).toBe(below > 0 ? below : undefined);
  }

  test("keeps the highlighted command visible while moving down through every option", async () => {
    const full = await fullMenu();
    const r = await shortMenu();

    const seen: string[] = [];
    for (let i = 0; i < full.names.length; i++) {
      if (i > 0) await r.press("down");
      await waitForText(r.lastFrame, `❯ ${full.names[i]}`);
      const frame = r.lastFrame()!;
      seen.push(highlighted(frame)!);
      expectConsistentWindow(frame, full);
    }
    expect(seen).toEqual(full.names);
    r.unmount();
  });

  test("reaches the last command-line-only option and scrolls back up to the first", async () => {
    const full = await fullMenu();
    const r = await shortMenu();
    const last = full.names[full.names.length - 1]!;

    for (let i = 1; i < full.names.length; i++) await r.press("down");
    await waitForText(r.lastFrame, `❯ ${last}`);
    let frame = r.lastFrame()!;
    expect(hasCliDivider(frame)).toBe(true);
    expect(more(frame, "↑")).toBeGreaterThan(0);
    expect(more(frame, "↓")).toBeUndefined();

    for (let i = 1; i < full.names.length; i++) {
      await r.press("up");
      expectConsistentWindow(r.lastFrame()!, full);
    }
    await waitForText(r.lastFrame, "❯ dev");
    frame = r.lastFrame()!;
    expect(more(frame, "↑")).toBeUndefined();
    expect(more(frame, "↓")).toBeGreaterThan(0);
    r.unmount();
  });

  test("a window starting mid-section shows that section's title first", async () => {
    const full = await fullMenu();
    const r = await shortMenu();

    const target = full.names.indexOf("payment");
    for (let i = 0; i < target; i++) await r.press("down");
    await waitForText(r.lastFrame, "❯ payment");
    const groups = menuGroups(r.lastFrame()!);
    expect(groups[0]!.title).toBe("resources");
    expect(groups[0]!.names[0]).not.toBe("harness");
    r.unmount();
  });

  test("typing a filter returns the window to the top", async () => {
    const full = await fullMenu();
    const r = await shortMenu();

    for (let i = 1; i < full.names.length; i++) await r.press("down");
    await waitForText(r.lastFrame, "❯ update");
    await r.write("e");
    const first = full.names.find((name) => name.includes("e"))!;
    await waitForText(r.lastFrame, `❯ ${first}`);
    expect(more(r.lastFrame()!, "↑")).toBeUndefined();
    r.unmount();
  });

  test("resizing taller shows the whole list again", async () => {
    const full = await fullMenu();
    const r = await shortMenu();

    for (let i = 1; i < full.names.length; i++) await r.press("down");
    await waitForText(r.lastFrame, "❯ update");
    await r.resize(100, 40);
    const frame = r.lastFrame()!;
    expect(menuGroups(frame).flatMap((group) => group.names)).toEqual(full.names);
    expect(frame).not.toContain(" more");
    expect(frame).toContain("❯ update");
    r.unmount();
  });

  test("resizing shorter keeps the highlight visible", async () => {
    const full = await fullMenu();
    const r = renderScreen("/agentcore", { withContext: inProjectContext });
    await waitForText(r.lastFrame, "❯ dev");

    const target = full.names.indexOf("harness");
    for (let i = 0; i < target; i++) await r.press("down");
    await waitForText(r.lastFrame, "❯ harness");
    await r.resize(100, ROWS);
    expectConsistentWindow(r.lastFrame()!, full);
    expect(r.lastFrame()).toContain("❯ harness");

    // The banner, header, filter, and footer leave the list a single row.
    await r.resize(100, 11);
    expect(r.lastFrame()).toContain("❯ harness");
    r.unmount();
  });

  test("accounts for a wrapped header when scrolling a narrow terminal", async () => {
    const full = await fullMenu();
    const r = renderScreen("/agentcore", { withContext: inProjectContext });
    await waitForText(r.lastFrame, "❯ dev");
    await r.resize(40, ROWS);

    for (let i = 0; i < full.names.length; i++) {
      if (i > 0) await r.press("down");
      expect(r.lastFrame()).toMatch(new RegExp(`❯\\s*${full.names[i]}`));
    }

    r.unmount();
  });

  test("a nested menu, without the banner, uses the rows the banner would take", async () => {
    const r = renderScreen("/agentcore/harness");
    await waitForText(r.lastFrame, "❯ ");
    const full = menuGroups(r.lastFrame()!).flatMap((group) => group.names);

    await r.resize(100, 7);
    for (let i = 0; i < full.length; i++) {
      if (i > 0) await r.press("down");
      await waitForText(r.lastFrame, `❯ ${full[i]}`);
      expect(r.lastFrame()!.split("\n")).toHaveLength(7);
    }

    await r.resize(100, ROWS);
    const frame = r.lastFrame()!;
    const visible = menuGroups(frame).flatMap((group) => group.names);
    expect(visible.length + (more(frame, "↑") ?? 0)).toBe(full.length);
    expect(frame).toContain(`❯ ${full[full.length - 1]}`);
    r.unmount();
  });
});
