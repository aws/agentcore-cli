import { afterEach, describe, expect, test } from "bun:test";
import type { Command } from "commander";
import { isTuiCommandSupported } from "../router";
import { cleanupScreens, compiledRootCommand, renderScreen, waitFor } from "../testing";

afterEach(cleanupScreens);

// screenCommands walks the compiled Commander tree for every command with a
// screen, so a screen added later is covered without a new test. The root is
// skipped: it has nothing to go back to. (CliOnlyScreen.test covers the rest.)
function screenCommands(command: Command, path: string[]): [string[], Command][] {
  const here = [...path, command.name()];
  return command.commands
    .filter((child) => child.name() !== "help" && isTuiCommandSupported(child))
    .flatMap((child): [string[], Command][] => [
      [[...here, child.name()], child],
      ...screenCommands(child, here),
    ]);
}

// menuHeader is the first line RouterScreen renders for a group at `path`.
function menuHeader(path: string[], command: Command): string {
  return [...path, command.description()].join(" → ");
}

// ancestorMenuHeaders lists the menu header of every group above a command,
// nearest first. Escape normally lands on the parent, but a group whose route
// only redirects to its single child (`gateway policy` → `generate`) has no
// menu of its own, so that child's escape skips to the grandparent.
function ancestorMenuHeaders(path: string[], command: Command): string[] {
  const headers: string[] = [];
  let at = path.slice(0, -1);
  for (let cur = command.parent; cur; cur = cur.parent) {
    headers.push(menuHeader(at, cur));
    at = at.slice(0, -1);
  }
  return headers;
}

function firstLine(frame: string | undefined): string {
  return (frame ?? "").split("\n")[0]?.trim() ?? "";
}

const SCREENS = screenCommands(compiledRootCommand(), []);

describe("every command with a screen", () => {
  test("there are screens to cover", () => {
    expect(SCREENS.length).toBeGreaterThan(50);
  });

  // The route table decides what each path shows and where its escape goes. A
  // path that redirects to a screen whose escape targets that same path loops
  // in place, so from wherever a command opens, escape must reach a menu above.
  // Any ancestor menu is accepted, so this catches a no-op or a loop but not
  // an escape that jumps further up than it should.
  test.each(SCREENS.map(([path, command]) => [path.join(" "), path, command] as const))(
    "%s opens, and esc returns to a menu above it",
    async (_label, path, command) => {
      const r = renderScreen("/" + path.join("/"));
      // Wide and tall enough that the header never wraps.
      await r.resize(220, 200);
      const menus = ancestorMenuHeaders(path, command);
      expect(menus).not.toContain(firstLine(r.lastFrame()));

      await r.press("escape");
      await waitFor(() => menus.includes(firstLine(r.lastFrame()))).catch(() => {});
      expect(menus).toContain(firstLine(r.lastFrame()));
      r.unmount();
    },
  );
});
