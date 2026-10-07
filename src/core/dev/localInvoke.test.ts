import { describe, expect, test } from "bun:test";
import { AgentCoreCLIError, InvalidEnvironmentError } from "../../errors";
import { sseEvent } from "./inspector/respond";
import { invokeLocalHarness } from "./localInvoke";

describe("invokeLocalHarness", () => {
  test("posts to the harness endpoint and yields native events", async () => {
    const seen: { path: string; local: string | null }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        seen.push({
          path: new URL(request.url).pathname,
          local: request.headers.get("x-agentcore-local"),
        });
        return new Response(sseEvent({ event: { messageStart: { role: "assistant" } } }), {
          headers: { "x-session-id": "s1" },
        });
      },
    });
    try {
      const turn = await invokeLocalHarness({ port: server.port!, name: "h1", prompt: "hi" });
      expect(turn.sessionId).toBe("s1");
      expect(await Array.fromAsync(turn.events)).toEqual([{ messageStart: { role: "assistant" } }]);
      expect(seen).toEqual([{ path: "/harness/h1/invocations", local: "1" }]);
    } finally {
      server.stop(true);
    }
  });

  test.each([
    ["no server", undefined, InvalidEnvironmentError, "agentcore dev --harness h1 --port"],
    ["an error status", 404, AgentCoreCLIError, "Harness 'h1' was not found."],
  ])("%s", async (_case, status, type, message) => {
    const server = status
      ? Bun.serve({
          port: 0,
          fetch: () =>
            Response.json({ success: false, error: "Harness 'h1' was not found." }, { status }),
        })
      : undefined;
    const port = server?.port ?? 1;
    try {
      const turn = invokeLocalHarness({ port, name: "h1", prompt: "hi" });

      await expect(turn).rejects.toBeInstanceOf(type);
      await expect(turn).rejects.toThrow(message);
    } finally {
      server?.stop(true);
    }
  });
});
