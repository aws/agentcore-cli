import { expect, test } from "bun:test";
import { DebugKey, ErrorReportKey } from "../handlers/keys";
import { createHandler, Router, ValueContext } from "../router";
import type { ErrorReport } from "../runnable";
import { withErrorReport } from "./withErrorReport";

function createApp() {
  const app = new Router("myapp").use(withErrorReport());
  app.groupFlags(DebugKey);
  const group = new Router("harness");
  group.handler(
    createHandler({
      name: "get",
      description: "",
      handle: async () => {
        throw new Error("service failed");
      },
    }),
  );
  app.handler(group);
  return app;
}

test.each([
  ["before the command", ["--debug", "harness", "get"], true],
  ["between commands", ["harness", "--debug", "get"], true],
  ["after the command", ["harness", "get", "--debug"], true],
  ["absent", ["harness", "get"], false],
])("records --debug %s for the root error print", async (_name, args, debug) => {
  const report: ErrorReport = { debug: !debug };
  const ctx = ValueContext.EmptyContext().withValue(ErrorReportKey, report);

  await expect(createApp().route(["node", "myapp", ...args], ctx)).rejects.toThrow(
    "service failed",
  );

  expect(report.debug).toBe(debug);
});

test("runs without a report on the context", async () => {
  await expect(createApp().route(["node", "myapp", "harness", "get", "--debug"])).rejects.toThrow(
    "service failed",
  );
});
