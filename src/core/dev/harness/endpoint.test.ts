import { expect, test } from "bun:test";
import type { InvokeHarnessStreamOutput } from "@aws-sdk/client-bedrock-agentcore";
import { ResourceNotFoundError } from "../../../errors";
import { sseData } from "../inspector/respond";
import { createHarnessEndpointHandler } from "./endpoint";
import type { HarnessDevHosts } from "./hosts";
import type { HarnessInvokeRequest } from "./request";

const SSE = [
  { messageStart: { role: "assistant" } },
  { messageStop: { stopReason: "end_turn" } },
] as InvokeHarnessStreamOutput[];

function fakeHosts() {
  const calls: [string, HarnessInvokeRequest][] = [];
  const hosts: Pick<HarnessDevHosts, "invoke"> = {
    invoke: async (name, request) => {
      calls.push([name, request]);
      if (name === "broken") throw new Error("container exited");
      if (name !== "h1") throw new ResourceNotFoundError(`Harness '${name}' was not found.`);
      return {
        sessionId: request.sessionId ?? "new",
        events: (async function* () {
          yield* SSE;
        })(),
      };
    },
  };
  return { calls, handler: createHarnessEndpointHandler(hosts) };
}

const request = (
  headers: Record<string, string>,
  body: unknown,
  url = "/harness/h1/invocations",
) => ({
  method: "POST",
  url,
  headers: { host: "127.0.0.1:8090", "x-agentcore-local": "1", ...headers },
  body: Buffer.from(JSON.stringify(body)),
  signal: new AbortController().signal,
});

test("streams native events with the session header", async () => {
  const { calls, handler } = fakeHosts();
  const body = { prompt: "hi", sessionId: "s1", harnessOverrides: { maxIterations: 2 } };

  const response = await handler(request({}, body));

  expect(response.status).toBe(200);
  expect(response.headers?.["x-session-id"]).toBe("s1");
  const payloads = await Array.fromAsync(sseData(response.body as AsyncIterable<Uint8Array>));
  expect(payloads.map((data) => JSON.parse(data))).toEqual(SSE.map((event) => ({ event })));
  expect(calls).toEqual([["h1", body]]);
});

test.each([
  ["endpoint rejects Origin", { origin: "http://evil.example" }, { prompt: "hi" }, undefined, 403],
  ["non-loopback Host", { host: "evil.example:8090" }, { prompt: "hi" }, undefined, 403],
  ["missing local header", { "x-agentcore-local": "" }, { prompt: "hi" }, undefined, 403],
  ["missing prompt", {}, {}, undefined, 400],
  ["unknown harness", {}, { prompt: "hi" }, "/harness/nope/invocations", 404],
  ["malformed harness name", {}, { prompt: "hi" }, "/harness/%E0/invocations", 404],
  ["unknown route", {}, { prompt: "hi" }, "/other", 404],
  ["harness failure", {}, { prompt: "hi" }, "/harness/broken/invocations", 502],
])("%s", async (_case, headers, body, url, status) => {
  const response = await fakeHosts().handler(request(headers, body, url));

  expect(response.status).toBe(status);
});
