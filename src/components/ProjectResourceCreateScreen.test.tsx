import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanupScreens,
  compiledRootCommand,
  menuEntries,
  renderImperativeScreen,
  IMPERATIVE_GLOBAL_CONFIG,
  waitForText,
} from "../testing";
import type { ProjectCreateResource } from "./ProjectResourceCreateScreen";

afterEach(cleanupScreens);

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
      const r = renderImperativeScreen(`/agentcore/${resource}`);

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
      expect(frame).not.toContain("this command runs from the command line");

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
});
