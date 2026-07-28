import { expect, test } from "bun:test";

import { AgentCoreCLIError } from "../errors";
import { runRunnable, type Runnable } from "./index.tsx";

test("returns zero and forwards argv when run completes", async () => {
  let receivedArgv: string[] | undefined;
  const runnable: Runnable = {
    run: async (argv: string[]) => {
      receivedArgv = argv;
    },
  };

  const argv = ["node", "script", "--flag"];
  const code = await runRunnable(() => runnable, argv);

  expect(code).toBe(0);
  expect(receivedArgv).toEqual(argv);
});

test("returns the default failure code when run rejects with an Error", async () => {
  const runnable: Runnable = {
    run: async () => {
      throw new Error("boom");
    },
  };

  const code = await runRunnable(() => runnable, []);

  expect(code).toBe(1);
});

test("returns the default failure code when the factory throws a non-Error value", async () => {
  const code = await runRunnable(() => {
    throw "kaboom";
  }, []);

  expect(code).toBe(1);
});

test("respects custom errors codes from known errors", async () => {
  const runnable: Runnable = {
    run: async () => {
      throw new AgentCoreCLIError("custom failure", { exitCode: 42 });
    },
  };

  const code = await runRunnable(() => runnable, []);

  expect(code).toBe(42);
});
