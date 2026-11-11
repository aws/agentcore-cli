import { afterEach, expect, test } from "bun:test";
import type { Command } from "commander";
import { isTuiCommandSupported } from "../router";
import {
  cleanupScreens,
  compiledRootCommand,
  inProjectContext,
  menuEntries,
  renderScreen,
  waitForText,
} from "../testing";

afterEach(cleanupScreens);

function menusWithCliOnlyChildren(command: Command, path: string[] = []): [string[], string[]][] {
  const here = [...path, command.name()];
  const hidden = command.commands
    .filter((child) => !isTuiCommandSupported(child) && child.name() !== "dev")
    .map((child) => child.name());
  return [
    ...(hidden.length > 0 && isTuiCommandSupported(command)
      ? [[here, hidden] as [string[], string[]]]
      : []),
    ...command.commands.flatMap((child) => menusWithCliOnlyChildren(child, here)),
  ];
}

test.each(
  menusWithCliOnlyChildren(compiledRootCommand()).map(
    ([path, hidden]) => [path.join(" "), path, hidden] as const,
  ),
)("%s hides CLI-only children", async (_label, path, hidden) => {
  const screen = renderScreen("/" + path.join("/"), { withContext: inProjectContext });
  await waitForText(screen.lastFrame, "type to choose a command");
  const entries = menuEntries(screen.lastFrame()!);
  const visible = [...entries.screens, ...entries.cliOnly];
  for (const name of hidden) expect(visible).not.toContain(name);
  screen.unmount();
});

test("the root menu retains the dev handoff", async () => {
  const screen = renderScreen("/agentcore", { withContext: inProjectContext });
  await waitForText(screen.lastFrame, "❯ add");
  expect(menuEntries(screen.lastFrame()!).screens).toContain("dev");
  screen.unmount();
});

test.each([
  ["/agentcore/config", "agentcore → the platform for production AI agents"],
  ["/agentcore/eval/ondemand/evaluate", "agentcore → eval →"],
  ["/agentcore/identity/payment-credential-provider/list", "agentcore → identity →"],
  ["/agentcore/payment/manager/list", "agentcore → the platform for production AI agents"],
])("%s returns to a supported menu", async (path, header) => {
  const screen = renderScreen(path, { withContext: inProjectContext });
  await waitForText(screen.lastFrame, header);
  expect(screen.lastFrame()).toContain("type to choose a command");
  expect(screen.lastFrame()).not.toContain("run it with:");
  screen.unmount();
});

test("an unknown command retains the original help fallback", async () => {
  const screen = renderScreen("/agentcore/gateway/no-such-command");
  await waitForText(() => screen.frames.join("\n"), "Usage:");
  expect(screen.frames.join("\n")).toContain("create");
  screen.unmount();
});
