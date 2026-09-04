import { expect, test } from "bun:test";
import { createHandler, PlatformKey, Router } from "../router";
import { withPlatform } from "./withPlatform";

test("pins the configured platform on the context", async () => {
  let seen: NodeJS.Platform | undefined;
  const app = new Router("myapp").use(withPlatform("win32"));
  app.handler(
    createHandler({
      name: "whoami",
      description: "",
      handle: async (ctx) => {
        seen = ctx.require(PlatformKey);
      },
    }),
  );

  await app.route(["node", "myapp", "whoami"]);

  expect(seen).toBe("win32");
});
