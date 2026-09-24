import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanupScreens,
  compiledRootCommand,
  menuEntries,
  renderScreen,
  IMPERATIVE_GLOBAL_CONFIG,
  waitForText,
} from "../testing";
import type { ProjectCreateResource } from "./ProjectResourceCreateScreen";

afterEach(cleanupScreens);

const MUTATION_CONFIG = { ...IMPERATIVE_GLOBAL_CONFIG, "imperative-mutation-commands": true };

const RESOURCES = [
  {
    resource: "runtime",
    label: "Runtime",
    parentDescription: "inspect AgentCore Runtimes",
    addCommand: "agentcore add runtime",
  },
  {
    resource: "memory",
    label: "Memory",
    parentDescription: "inspect AgentCore Memories",
    addCommand: "agentcore add memory",
  },
  {
    resource: "gateway",
    label: "Gateway",
    parentDescription: "manage AgentCore Gateways",
    addCommand: "agentcore add gateway --name MyGateway",
  },
] as const satisfies {
  resource: ProjectCreateResource;
  label: string;
  parentDescription: string;
  addCommand: string;
}[];

describe("project resource creation guidance", () => {
  test.each(RESOURCES)(
    "$resource lists create in its TUI menu and opens project instructions",
    async ({ resource, label, parentDescription, addCommand }) => {
      const r = renderScreen(`/agentcore/${resource}`, { globalConfig: IMPERATIVE_GLOBAL_CONFIG });

      await waitForText(r.lastFrame, "❯ create");
      expect(menuEntries(r.lastFrame()!).screens[0]).toBe("create");

      await r.press("return");
      await waitForText(r.lastFrame, `Create an AgentCore ${label}`);

      const frame = r.lastFrame()!;
      expect(frame).toContain("agentcore create");
      expect(frame).toContain("cd <project-directory>");
      expect(frame).toContain(addCommand);
      expect(frame).toContain("agentcore deploy");
      expect(frame).not.toContain("┌");

      await r.press("escape");
      await waitForText(r.lastFrame, parentDescription);
      r.unmount();
    },
  );

  test("the guidance does not add unsupported imperative CLI commands", () => {
    const root = compiledRootCommand(undefined, IMPERATIVE_GLOBAL_CONFIG);
    for (const resource of RESOURCES) {
      const command = root.commands.find((candidate) => candidate.name() === resource.resource);
      expect(command?.commands.some((candidate) => candidate.name() === "create")).toBe(false);
    }
  });

  test.each(RESOURCES.filter(({ resource }) => resource !== "gateway"))(
    "$resource keeps project guidance when Gateway mutations are enabled",
    async ({ resource, label, addCommand }) => {
      const r = renderScreen(`/agentcore/${resource}`, { globalConfig: MUTATION_CONFIG });
      await waitForText(r.lastFrame, "type to choose a command");
      const entries = menuEntries(r.lastFrame()!);
      expect(entries.screens[0]).toBe("create");
      expect(entries.cliOnly).not.toContain("create");

      await r.press("return");
      await waitForText(r.lastFrame, `Create an AgentCore ${label}`);
      expect(r.lastFrame()).toContain(addCommand);
      expect(r.lastFrame()).not.toContain("this command runs from the command line");

      const command = compiledRootCommand(undefined, MUTATION_CONFIG).commands.find(
        (candidate) => candidate.name() === resource,
      );
      expect(command?.commands.some((candidate) => candidate.name() === "create")).toBe(false);
      r.unmount();
    },
  );
});
