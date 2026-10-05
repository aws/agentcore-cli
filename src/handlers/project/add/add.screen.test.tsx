import { test, expect, describe, afterEach } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  renderScreen,
  waitForText,
  waitForFlatText,
  cleanupScreens,
  compiledRootCommand,
  flatFrame,
  hasCliDivider,
  initProject,
  menuEntries,
  inProjectContext,
  tick,
} from "../../../testing";
import { type ChinaAddKind, isAddableInChina } from "../../../core/project/manager";
import { CHINA_ADD_MENU_ALERT } from "./screen";
import { CN_UNAVAILABLE_NOTE } from "./shared";

afterEach(cleanupScreens);

// addSubcommands reads the resources off the compiled Commander tree, so a
// An `add` resource added later is covered without editing this file.
// `help` is Commander's own, not one of ours.
function addSubcommands(): string[] {
  const root = compiledRootCommand();
  const add = root.commands.find((command) => command.name() === "add")!;
  return add.commands.map((command) => command.name()).filter((name) => name !== "help");
}

// The China kind each `add` menu command adds — the same kind its handler
// passes to addDescription. Availability itself has one source, the project
// manager's allowlist (isAddableInChina); this map only names the kinds. A
// command missing here fails the test, so a new resource is classified on
// purpose rather than slipping in unmarked.
const ADD_COMMAND_KINDS: Record<string, ChinaAddKind> = {
  runtime: "runtime",
  "runtime-endpoint": "runtime-endpoint",
  memory: "memory",
  gateway: "gateway",
  "gateway-target": "gateway-target",
  "gateway-connector": "gateway-connector",
  "online-eval": "online-eval",
  "online-insight": "online-insight",
  harness: "harness",
  "config-bundle": "config-bundle",
  "policy-engine": "policy-engine",
  policy: "policy",
  "payment-manager": "payment-manager",
  "payment-connector": "payment-connector",
  evaluator: "evaluator",
  credentials: "credential",
};

// chinaProject scaffolds a project whose only deployment target is cn-north-1.
async function chinaProject(region = "cn-north-1") {
  const project = await initProject({
    flags: ["--template", "agent-python-minimal"],
    prefix: "agentcore-add-menu-china-",
  });
  await writeFile(
    join(project.projectRoot, "agentcore", "aws-targets.json"),
    JSON.stringify([{ name: "default", account: "111122223333", region }]),
  );
  return project;
}

describe("project add menu", () => {
  test("lists every add resource", async () => {
    const r = renderScreen("/agentcore/add");

    await waitForText(r.lastFrame, "add project resources");
    const frame = r.lastFrame()!;
    for (const command of addSubcommands()) {
      expect(frame).toContain(command);
    }
    r.unmount();
  });

  // A resource without a screen would be listed below a divider and open its
  // help instead; every add resource has a wizard, so there is no divider.
  test("every resource opens a wizard, so nothing is listed below a divider", async () => {
    const r = renderScreen("/agentcore/add");

    await waitForText(r.lastFrame, "add project resources");
    const { screens, cliOnly } = menuEntries(r.lastFrame()!);
    expect(screens.toSorted()).toEqual(addSubcommands().toSorted());
    expect(cliOnly).toEqual([]);
    expect(hasCliDivider(r.lastFrame()!)).toBe(false);
    r.unmount();
  });

  test("is reachable from the root menu", async () => {
    const r = renderScreen("/agentcore", { withContext: inProjectContext });

    await waitForText(r.lastFrame, "the platform for production AI agents");
    await r.write("add");
    await waitForText(r.lastFrame, "❯ add");
    await r.press("return");

    await waitForText(r.lastFrame, "agentcore → add");
    r.unmount();
  });

  test("a resource says it is unavailable in China iff its kind is outside the allowlist", () => {
    const root = compiledRootCommand();
    const add = root.commands.find((command) => command.name() === "add")!;
    for (const command of add.commands) {
      if (command.name() === "help") continue;
      const kind = ADD_COMMAND_KINDS[command.name()];
      expect(kind, `add ${command.name()} has no China kind in ADD_COMMAND_KINDS`).toBeDefined();
      const says = command.description().endsWith(`(${CN_UNAVAILABLE_NOTE})`);
      expect({ command: command.name(), says }).toEqual({
        command: command.name(),
        says: !isAddableInChina(kind!),
      });
    }
  });

  test("warns above the menu when the project has a China deployment target", async () => {
    const { cleanup } = await chinaProject();
    try {
      const r = renderScreen("/agentcore/add");

      await waitForFlatText(r.lastFrame, "deploys to a China (aws-cn) region");
      // The alert wraps inside a bordered box, so drop the borders before
      // matching the whole sentence.
      expect(flatFrame(r.lastFrame).replace(/│/g, "").replace(/\s+/g, " ")).toContain(
        CHINA_ADD_MENU_ALERT,
      );
      // The menu itself is unchanged: every resource is still listed.
      const frame = r.lastFrame()!;
      for (const command of addSubcommands()) {
        expect(frame).toContain(command);
      }
      r.unmount();
    } finally {
      await cleanup();
    }
  }, 15000);

  test("does not warn when the project deploys to a commercial region", async () => {
    const { cleanup } = await chinaProject("us-east-1");
    try {
      const r = renderScreen("/agentcore/add");

      await waitForText(r.lastFrame, "add project resources");
      // Give the targets query time to settle before asserting its absence.
      await tick(50);
      expect(flatFrame(r.lastFrame)).not.toContain("deploys to a China (aws-cn) region");
      r.unmount();
    } finally {
      await cleanup();
    }
  }, 15000);

  test("esc returns to the root menu", async () => {
    const r = renderScreen("/agentcore/add");

    await waitForText(r.lastFrame, "agentcore → add");
    await r.press("escape");

    await waitForText(r.lastFrame, "the platform for production AI agents");
    r.unmount();
  });
});
