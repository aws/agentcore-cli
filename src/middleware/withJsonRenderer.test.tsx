import { describe, expect, test } from "bun:test";
import { ValueContext, createHandler } from "../router";
import { JsonRendererKey } from "../tui";
import { testIO } from "../testing";
import { withJsonRenderer } from "./withJsonRenderer";

describe("withJsonRenderer", () => {
  test("renderJsonLine writes a BigInt as a JSON number with every digit", async () => {
    const io = testIO();
    const handler = withJsonRenderer(io.io)(
      createHandler({
        name: "emit",
        description: "emit one line",
        flags: [] as const,
        handle: async (ctx) => {
          ctx.require(JsonRendererKey).renderJsonLine({ endTimeUnixNano: -1750000000000000001n });
        },
      }),
    );
    await handler.handle(ValueContext.EmptyContext(), {}, {});
    expect(io.stdout()).toBe('{"endTimeUnixNano":-1750000000000000001}');
  });
});
