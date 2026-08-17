import { afterEach, describe, expect, test } from "bun:test";
import type { HttpRequest } from "../../../io/httpServer";
import { ServerFarm, fakeSupervisor, post, runningAgent, sseBody } from "./testkit";
import type { InspectorDeps } from "./types";

const farm = new ServerFarm();
afterEach(() => farm.close());

/** An inspector whose "orders" agent is the given stub server. */
async function inspectorWithAgent(
  agent: { port: number },
  protocol = "HTTP",
  extra: Partial<InspectorDeps> = {},
) {
  const supervisor = fakeSupervisor({ agents: [runningAgent("orders", agent.port, protocol)] });
  return farm.inspector({ supervisor, ...extra });
}

describe("POST /invocations (HTTP agents)", () => {
  test("proxies to the agent and normalizes SSE events to plain text", async () => {
    const seen: HttpRequest[] = [];
    const agent = await farm.serve((request) => {
      seen.push(request);
      return {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: sseBody([
          '{"text":"Hel"}',
          '{"event":{"contentBlockDelta":{"delta":{"text":"lo"}}}}',
        ]),
      };
    });
    const { url } = await inspectorWithAgent(agent);

    const response = await post(url, "/invocations", {
      agentName: "orders",
      prompt: "hi",
      sessionId: "session-1",
      userId: "user-1",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-session-id")).toBe("session-1");
    expect(await response.text()).toBe('data: "Hel"\n\ndata: "lo"\n\n');
    expect(seen[0]?.url).toBe("/invocations");
    expect(seen[0]?.headers["x-amzn-bedrock-agentcore-runtime-session-id"]).toBe("session-1");
    expect(seen[0]?.headers["x-amzn-bedrock-agentcore-runtime-user-id"]).toBe("user-1");
    expect(seen[0]?.body.toString()).toContain('"prompt":"hi"');
  });

  test("SSE error events are forwarded as error frames", async () => {
    const agent = await farm.serve(() => ({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: sseBody(['{"error":"model exploded"}']),
    }));
    const { url } = await inspectorWithAgent(agent);
    const response = await post(url, "/invocations", { agentName: "orders", prompt: "hi" });
    expect(await response.text()).toBe('data: {"error":"model exploded"}\n\n');
  });

  test("non-SSE responses pass through untouched", async () => {
    const agent = await farm.serve(() => ({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result: "done" }),
    }));
    const { url } = await inspectorWithAgent(agent);
    const response = await post(url, "/invocations", { agentName: "orders", prompt: "hi" });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ result: "done" });
  });

  test("falls back to the first running agent when agentName is absent", async () => {
    const agent = await farm.serve(() => ({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: '{"ok":true}',
    }));
    const { url } = await inspectorWithAgent(agent);
    const response = await post(url, "/invocations", { prompt: "hi" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("answers 409 when no agent is running", async () => {
    const { url } = await farm.inspector({ supervisor: fakeSupervisor() });
    const response = await post(url, "/invocations", { prompt: "hi" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      error: "No agent is running. Call POST /api/start first.",
    });
  });

  test("answers 502 when the agent connection fails", async () => {
    // Nothing listens on port 1, so the proxy target refuses connections.
    const { url } = await inspectorWithAgent({ port: 1 });
    const response = await post(url, "/invocations", { agentName: "orders", prompt: "hi" });
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toStartWith("Agent server error:");
  });
});

describe("POST /invocations (A2A agents)", () => {
  test("translates the prompt to JSON-RPC message/stream and reduces events to text", async () => {
    const seen: HttpRequest[] = [];
    const agent = await farm.serve((request) => {
      seen.push(request);
      return {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: sseBody([
          JSON.stringify({
            result: {
              kind: "status-update",
              status: { state: "working", message: { parts: [{ kind: "text", text: "Hel" }] } },
            },
          }),
          JSON.stringify({
            result: {
              kind: "artifact-update",
              artifact: { parts: [{ kind: "text", text: "Hello (final)" }] },
            },
          }),
        ]),
      };
    });
    const { url } = await inspectorWithAgent(agent, "A2A");

    const response = await post(url, "/invocations", {
      agentName: "orders",
      prompt: "hi",
      sessionId: "ctx-1",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-session-id")).toBe("ctx-1");
    // The artifact-update is skipped because text already streamed via status-update.
    expect(await response.text()).toBe('data: "Hel"\n\n');
    const rpc = JSON.parse(seen[0]!.body.toString()) as {
      method: string;
      params: { message: { contextId?: string; parts: { kind: string; text: string }[] } };
    };
    expect(seen[0]?.url).toBe("/");
    expect(rpc.method).toBe("message/stream");
    expect(rpc.params.message.contextId).toBe("ctx-1");
    expect(rpc.params.message.parts).toEqual([{ kind: "text", text: "hi" }]);
  });

  test("non-streaming JSON-RPC results become a single SSE text event", async () => {
    const agent = await farm.serve(() => ({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        result: { artifacts: [{ parts: [{ kind: "text", text: "answer" }] }] },
      }),
    }));
    const { url } = await inspectorWithAgent(agent, "A2A");
    const response = await post(url, "/invocations", { agentName: "orders", prompt: "hi" });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe('data: "answer"\n\n');
  });

  test("requires a prompt", async () => {
    const agent = await farm.serve(() => ({ status: 200 }));
    const { url } = await inspectorWithAgent(agent, "A2A");
    const response = await post(url, "/invocations", { agentName: "orders" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: "prompt is required" });
  });
});

describe("POST /invocations (AGUI agents)", () => {
  test("translates the prompt to RunAgentInput and passes the SSE through raw", async () => {
    const seen: HttpRequest[] = [];
    const agent = await farm.serve((request) => {
      seen.push(request);
      return {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: sseBody(['{"type":"TEXT_MESSAGE_CONTENT","delta":"raw"}']),
      };
    });
    const { url } = await inspectorWithAgent(agent, "AGUI");

    const response = await post(url, "/invocations", {
      agentName: "orders",
      prompt: "hi",
      sessionId: "thread-1",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-session-id")).toBe("thread-1");
    expect(await response.text()).toBe('data: {"type":"TEXT_MESSAGE_CONTENT","delta":"raw"}\n\n');
    const input = JSON.parse(seen[0]!.body.toString()) as {
      threadId: string;
      messages: { role: string; content: string }[];
      tools: unknown[];
    };
    expect(seen[0]?.url).toBe("/invocations");
    expect(input.threadId).toBe("thread-1");
    expect(input.messages).toMatchObject([{ role: "user", content: "hi" }]);
    expect(input.tools).toEqual([]);
  });
});

describe("POST /invocations?target=deployed", () => {
  test("streams the deployed invocation as SSE data frames", async () => {
    const calls: unknown[] = [];
    const { url } = await farm.inspector({
      supervisor: fakeSupervisor(),
      aws: {
        invokeDeployed: async (request) => {
          calls.push(request);
          return {
            sessionId: "aws-session",
            stream: (async function* () {
              yield "Hel";
              yield { text: "lo" };
            })(),
          };
        },
      },
    });

    const response = await post(url, "/invocations?target=deployed", {
      agentName: "orders",
      prompt: "hi",
      sessionId: "session-1",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-session-id")).toBe("aws-session");
    expect(await response.text()).toBe('data: "Hel"\n\ndata: {"text":"lo"}\n\n');
    expect(calls).toEqual([
      {
        agentName: "orders",
        targetName: undefined,
        prompt: "hi",
        sessionId: "session-1",
        userId: undefined,
      },
    ]);
  });

  test("a stream failure becomes an SSE error frame", async () => {
    const { url } = await farm.inspector({
      supervisor: fakeSupervisor(),
      aws: {
        invokeDeployed: async () => ({
          stream: (async function* () {
            yield "partial";
            throw new Error("throttled");
          })(),
        }),
      },
    });
    const response = await post(url, "/invocations?target=deployed", { prompt: "hi" });
    expect(await response.text()).toBe('data: "partial"\n\ndata: {"error":"throttled"}\n\n');
  });

  test("answers 404 when deployed invocation is not wired", async () => {
    const { url } = await farm.inspector({ supervisor: fakeSupervisor() });
    const response = await post(url, "/invocations?target=deployed", { prompt: "hi" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: "Deployed invocation is not available",
    });
  });
});

describe("harness invocations", () => {
  const harnessDeps = (events: unknown[] = [{ type: "text", text: "hi" }]) => {
    const calls: unknown[] = [];
    const deps: InspectorDeps = {
      supervisor: fakeSupervisor(),
      aws: {
        harness: {
          invoke: async (request) => {
            calls.push(request);
            if (request.harnessName === "ghost") throw new Error('Harness "ghost" not found');
            return (async function* () {
              yield* events;
            })();
          },
        },
      },
    };
    return { deps, calls };
  };

  test("a harnessName in the /invocations body routes to the harness and streams SSE", async () => {
    const { deps, calls } = harnessDeps();
    const { url } = await farm.inspector(deps);
    const response = await post(url, "/invocations", {
      harnessName: "support",
      prompt: "help",
      sessionId: "hs-1",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-session-id")).toBe("hs-1");
    expect(await response.text()).toBe('data: {"type":"text","text":"hi"}\n\n');
    expect(calls).toMatchObject([
      {
        harnessName: "support",
        sessionId: "hs-1",
        messages: [{ role: "user", content: [{ text: "help" }] }],
      },
    ]);
  });

  test("an unknown harness yields a 404 error envelope", async () => {
    const { deps } = harnessDeps();
    const { url } = await farm.inspector(deps);
    const response = await post(url, "/invocations", { harnessName: "ghost", prompt: "help" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, error: 'Harness "ghost" not found' });
  });

  test("harness invocation requires a prompt", async () => {
    const { deps } = harnessDeps();
    const { url } = await farm.inspector(deps);
    const response = await post(url, "/invocations", { harnessName: "support" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: "prompt is required" });
  });

  test("answers 404 when harness invocation is not wired", async () => {
    const { url } = await farm.inspector({ supervisor: fakeSupervisor() });
    const response = await post(url, "/invocations", { harnessName: "support", prompt: "help" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: "Harness invocation is not available",
    });
  });

  test("POST /api/harness/tool-response continues the session with tool results", async () => {
    const { deps, calls } = harnessDeps([{ type: "done" }]);
    const { url } = await farm.inspector(deps);
    const messages = [{ role: "user", content: [{ toolResult: { ok: true } }] }];
    const response = await post(url, "/api/harness/tool-response", {
      harnessName: "support",
      sessionId: "hs-1",
      messages,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('data: {"type":"done"}\n\n');
    expect(calls).toMatchObject([{ harnessName: "support", sessionId: "hs-1", messages }]);
  });

  test("tool-response requires a sessionId", async () => {
    const { deps } = harnessDeps();
    const { url } = await farm.inspector(deps);
    const response = await post(url, "/api/harness/tool-response", {
      harnessName: "support",
      messages: [],
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: "sessionId is required" });
  });

  test("a harness stream failure becomes an SSE error event", async () => {
    const deps: InspectorDeps = {
      supervisor: fakeSupervisor(),
      aws: {
        harness: {
          invoke: async () =>
            (async function* () {
              yield { type: "text", text: "partial" };
              throw new Error("stream cut");
            })(),
        },
      },
    };
    const { url } = await farm.inspector(deps);
    const response = await post(url, "/invocations", { harnessName: "support", prompt: "help" });
    expect(await response.text()).toBe(
      'data: {"type":"text","text":"partial"}\n\n' +
        'data: {"type":"error","errorType":"invocationError","message":"stream cut"}\n\n',
    );
  });
});
