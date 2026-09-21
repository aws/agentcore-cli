import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanupScreens,
  compiledRootCommand,
  menuEntries,
  renderScreen,
  waitForText,
} from "../testing";
import type { ProjectOnlyResource } from "./ProjectResourceCreateScreen";

afterEach(cleanupScreens);

const RESOURCES = [
  {
    resource: "runtime",
    label: "Runtime",
    parentDescription: "inspect AgentCore Runtimes",
    addCommand: "agentcore project add runtime",
  },
  {
    resource: "memory",
    label: "Memory",
    parentDescription: "inspect AgentCore Memories",
    addCommand: "agentcore project add memory",
  },
] as const satisfies {
  resource: ProjectOnlyResource;
  label: string;
  parentDescription: string;
  addCommand: string;
}[];

describe("project-only resource creation guidance", () => {
  test.each(RESOURCES)(
    "$resource lists create in its TUI menu and opens project instructions",
    async ({ resource, label, parentDescription, addCommand }) => {
      const r = renderScreen(`/agentcore/${resource}`);

      await waitForText(r.lastFrame, "❯ create");
      expect(menuEntries(r.lastFrame()!).screens[0]).toBe("create");

      await r.press("return");
      await waitForText(r.lastFrame, `Create an AgentCore ${label}`);

      const frame = r.lastFrame()!;
      expect(frame).toContain("agentcore project create");
      expect(frame).toContain("cd <project-directory>");
      expect(frame).toContain(addCommand);
      expect(frame).toContain("agentcore project deploy");
      expect(frame).not.toContain("┌");

      await r.press("escape");
      await waitForText(r.lastFrame, parentDescription);
      r.unmount();
    },
  );

  test("the guidance does not add unsupported imperative CLI commands", () => {
    const root = compiledRootCommand();
    for (const resource of RESOURCES) {
      const command = root.commands.find((candidate) => candidate.name() === resource.resource);
      expect(command?.commands.some((candidate) => candidate.name() === "create")).toBe(false);
    }
  });
});
