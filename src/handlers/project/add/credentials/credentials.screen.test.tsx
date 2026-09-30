import { afterEach, describe, expect, test } from "bun:test";
import { cleanupScreens, menuEntries, renderScreen, waitForText } from "../../../../testing";
import { createGatewayProjectTestHarness } from "../gateway-test-support";

const { cleanup, inProject } = createGatewayProjectTestHarness("add-credentials-menu");

afterEach(cleanup);
afterEach(cleanupScreens);

describe("project add credentials menu", () => {
  test("lists api-key as a wizard and the remaining credential types as CLI-only", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/credentials");

    await waitForText(
      screen.lastFrame,
      "add AgentCore Identity credential providers to the current project",
    );
    const { screens, cliOnly } = menuEntries(screen.lastFrame()!);
    expect(screens).toEqual(["api-key"]);
    expect(cliOnly).toEqual(["oauth", "payment"]);

    await screen.press("escape");
    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();
  });
});
