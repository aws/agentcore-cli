import { expect, test } from "bun:test";
import { TerraformRunner } from "./runner";

test("JSON parsing ignores stderr diagnostics", async () => {
  const runner = new TerraformRunner(async function* (command) {
    expect(command).toEqual(["terraform", "output", "-json"]);
    yield { type: "stderr", line: "provider diagnostic" };
    yield { type: "stdout", line: '{"agentcore": {"value": 42}}' };
  });
  expect(await runner.json(["output", "-json"], "/tmp", {})).toEqual({ agentcore: { value: 42 } });
});

test("does not swallow a subprocess failure", async () => {
  const runner = new TerraformRunner(async function* () {
    yield { type: "stderr", line: "state is locked" };
    throw new Error("failed");
  });
  await expect(runner.json(["output", "-json"], "/tmp", {})).rejects.toThrow("failed");
});
