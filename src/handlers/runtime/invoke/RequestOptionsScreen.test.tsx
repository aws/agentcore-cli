import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import { cleanup, render } from "ink-testing-library";
import { keys, tick } from "../../../testing";
import {
  RequestOptionsScreen,
  type RequestOptionsMode,
  type RuntimeInvokeOptions,
} from "./RequestOptionsScreen";

const defaults: RuntimeInvokeOptions = {
  payloadSource: "Inline",
  responseDestination: "Console",
  contentType: "application/json",
};

type OptionsProps = {
  initial?: RuntimeInvokeOptions;
  customJwt?: boolean;
  mcp?: boolean;
  onModeChange?: (mode: RequestOptionsMode) => void;
};

function Options({
  initial = defaults,
  customJwt = false,
  mcp = false,
  onModeChange,
}: OptionsProps) {
  const [value, setValue] = useState(initial);
  return (
    <RequestOptionsScreen
      value={value}
      onChange={setValue}
      onClose={() => {}}
      onModeChange={onModeChange}
      customJwt={customJwt}
      mcp={mcp}
    />
  );
}

type RenderedOptions = ReturnType<typeof render>;

async function write(screen: RenderedOptions, input: string) {
  await tick();
  screen.stdin.write(input);
  await tick();
}

async function press(screen: RenderedOptions, key: keyof typeof keys) {
  await write(screen, keys[key]);
}

async function moveDown(screen: RenderedOptions, count: number) {
  for (let index = 0; index < count; index++) await press(screen, "down");
}

afterEach(cleanup);

describe("Request options", () => {
  test("groups context-specific options and redacts sensitive values", () => {
    const httpScreen = render(<Options />);
    const httpFrame = httpScreen.lastFrame()!;

    expect(httpFrame).toContain("Request options");
    expect(httpFrame).toMatch(
      /Payload[\s\S]*Source\s+Inline[\s\S]*Content type\s+application\/json/,
    );
    expect(httpFrame).toMatch(/Response[\s\S]*Accept\s+Automatic[\s\S]*Destination\s+Console/);
    expect(httpFrame).toMatch(/Runtime[\s\S]*Session ID\s+Not set[\s\S]*User ID\s+Not set/);
    expect(httpFrame).toContain("Trace");
    expect(httpFrame).not.toContain("MCP");
    expect(httpFrame).not.toContain("Bearer JWT");
    httpScreen.unmount();

    const mcpScreen = render(
      <Options
        customJwt
        mcp
        initial={{
          ...defaults,
          headers: "X-Tenant: retail\nX-Mode: fast",
          bearerToken: "secret-token",
          mcpSessionId: "mcp-session",
        }}
      />,
    );
    const mcpFrame = mcpScreen.lastFrame()!;

    expect(mcpFrame).toMatch(/Application headers\s+2 headers/);
    expect(mcpFrame).toMatch(/Bearer JWT\s+Configured/);
    expect(mcpFrame).toMatch(/MCP[\s\S]*Session ID\s+mcp-session[\s\S]*Protocol version\s+Not set/);
    expect(mcpFrame).not.toContain("secret-token");
    expect(mcpFrame).not.toContain("X-Tenant");
    expect(mcpFrame).not.toContain("retail");
  });

  test("highlights saved choices and reveals conditional rows", async () => {
    const modes: RequestOptionsMode[] = [];
    const screen = render(<Options onModeChange={(mode) => modes.push(mode)} />);

    await press(screen, "return");
    const frame = screen.lastFrame()!;
    expect(frame).not.toContain("Request options");
    expect(frame).toContain("Source");
    expect(frame).toContain("❯ Inline");
    expect(frame).toContain("  File");
    expect(modes).toEqual(["choice"]);

    await press(screen, "down");
    await press(screen, "return");
    expect(screen.lastFrame()).toMatch(/Source\s+File[\s\S]*File path\s+Not set/);
    expect(modes).toEqual(["choice", "overview"]);

    await press(screen, "return");
    expect(screen.lastFrame()).toContain("❯ File");
    await press(screen, "escape");
    expect(modes).toEqual(["choice", "overview", "choice", "overview"]);
  });

  test("cancels and saves a custom media type", async () => {
    const screen = render(<Options />);

    await press(screen, "down");
    await press(screen, "return");
    await moveDown(screen, 3);
    await press(screen, "return");
    await write(screen, "application/cancelled");
    await press(screen, "escape");
    expect(screen.lastFrame()).toMatch(/Content type\s+application\/json/);
    expect(screen.lastFrame()).not.toContain("application/cancelled");

    await press(screen, "return");
    await moveDown(screen, 3);
    await press(screen, "return");
    await write(screen, "application/vnd.example+json");
    await press(screen, "return");
    expect(screen.lastFrame()).toMatch(/Content type\s+application\/vnd\.example\+json/);

    await press(screen, "return");
    expect(screen.lastFrame()).toContain("❯ Custom");
    await press(screen, "return");
    expect(screen.lastFrame()).toContain("application/vnd.example+json");
  });

  test("resets Accept to Automatic", async () => {
    const screen = render(<Options initial={{ ...defaults, accept: "text/plain" }} />);

    await moveDown(screen, 2);
    await press(screen, "return");
    expect(screen.lastFrame()).toContain("❯ text/plain");
    await press(screen, "up");
    await press(screen, "up");
    await press(screen, "return");

    expect(screen.lastFrame()).toMatch(/Accept\s+Automatic/);
  });

  test("saves multiline headers with Ctrl+D and cancels without leaking values", async () => {
    const screen = render(<Options />);

    await moveDown(screen, 6);
    await press(screen, "return");
    await write(screen, "X-Tenant: retail\nX-Mode: fast");
    await write(screen, "\x04");
    expect(screen.lastFrame()).toMatch(/Application headers\s+2 headers/);
    expect(screen.lastFrame()).not.toContain("retail");

    await press(screen, "return");
    await write(screen, "\nX-Cancelled: secret");
    await press(screen, "escape");
    expect(screen.lastFrame()).toMatch(/Application headers\s+2 headers/);
    expect(screen.lastFrame()).not.toContain("X-Cancelled");
  });
});
