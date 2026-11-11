import { describe, expect, test } from "bun:test";
import { StreamController, ttyTestIO } from "../testing";
import { ShellOperation } from "./shell";
import type { RuntimeShellFrame, RuntimeShellSession } from "./runtime/types";

describe("ShellOperation", () => {
  test("detaches on Ctrl+] and returns successfully with both shell IDs visible", async () => {
    const { streams, stdin } = ttyTestIO();
    const frames = new StreamController<RuntimeShellFrame>();
    let closes = 0;
    const session: RuntimeShellSession = {
      runtimeSessionId: "session-012345678901234567890123456789",
      shellId: "server-shell",
      kicked: false,
      exitCode: null,
      send: async () => {},
      resize: async () => {},
      close: async () => {
        closes += 1;
        frames.end();
      },
      [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](),
    };

    const running = new ShellOperation(streams.io).run(session, {
      resource: "runtime",
      id: "runtime-123",
      qualifier: "DEFAULT",
      region: "us-west-2",
      requiresBearerToken: false,
    });
    stdin.write("\x1d");

    await expect(running).resolves.toBeUndefined();
    expect(closes).toBe(1);
    expect(streams.stderr()).toContain("Session ID: session-012345678901234567890123456789");
    expect(streams.stderr()).toContain("Shell ID: server-shell");
    expect(streams.stderr()).toContain("Ctrl+] to detach");
    expect(streams.stderr()).toContain(
      "To reconnect: agentcore runtime shell --id runtime-123 --qualifier DEFAULT",
    );
    expect(streams.stderr()).toContain("Detached. The remote shell is still running.");
  });
});
