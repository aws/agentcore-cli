import { expect, test } from "bun:test";
import type { ProcessEvent } from "../../../io";
import { harnessImage, pullHarnessImage } from "./image";

const IMAGE = harnessImage("us-west-2");

function pull(options: { cached?: boolean; pullError?: string; pullDelayMs?: number } = {}) {
  const commands: string[][] = [];
  const streamProcess = async function* (command: string[]): AsyncGenerator<ProcessEvent, void> {
    commands.push(command);
    const [, verb] = command;
    if (verb === "image") {
      const pulled = commands.some(([, candidate]) => candidate === "pull");
      if (!options.cached && (!pulled || options.pullError)) throw new Error("No such image");
      yield { type: "stdout", line: "sha256:digest" };
    }
    if (verb === "pull") {
      if (options.pullDelayMs) await Bun.sleep(options.pullDelayMs);
      if (options.pullError) throw new Error(options.pullError);
    }
  };
  const lines = (async () => {
    const collected: string[] = [];
    const generator = pullHarnessImage({
      region: "us-west-2",
      cwd: "/project",
      env: {},
      signal: new AbortController().signal,
      streamProcess,
      toolAvailable: async (tool) => tool === "docker",
      progressIntervalMs: 5,
    });
    for (let next = await generator.next(); ; next = await generator.next()) {
      if (next.done) return { lines: collected, tool: next.value };
      collected.push(next.value);
    }
  })();
  return { commands, result: lines };
}

test.each([
  [
    "first pull",
    false,
    [`Pulling ${IMAGE} with docker, first pull, about 1 GiB`, "Image ready (sha256:digest)"],
  ],
  ["cached image", true, [`Pulling ${IMAGE} with docker`, "Image ready (sha256:digest)"]],
])("%s status lines", async (_case, cached, expected) => {
  const { commands, result } = pull({ cached });

  expect(await result).toEqual({ lines: expected, tool: "docker" });
  expect(commands.find(([, verb]) => verb === "pull")).toEqual([
    "docker",
    "pull",
    "--quiet",
    "--platform",
    "linux/arm64",
    IMAGE,
  ]);
});

test("reports progress while a pull runs", async () => {
  const { lines } = await pull({ pullDelayMs: 40 }).result;

  expect(lines.some((line) => /^Still pulling \(\d+ s\)$/.test(line))).toBe(true);
});

test("a pull failure with a cached image warns and continues", async () => {
  const { lines } = await pull({ cached: true, pullError: "network down" }).result;

  expect(lines).toContain(
    `Could not pull ${IMAGE} (network down). Using the cached image sha256:digest.`,
  );
});

test("a pull failure without a cached image fails", async () => {
  await expect(pull({ cached: false, pullError: "network down" }).result).rejects.toThrow(
    `Could not pull ${IMAGE}: network down`,
  );
});

test("an unknown region lists the supported regions", () => {
  expect(() => harnessImage("eu-central-1")).toThrow(
    "us-west-2, us-east-1, us-east-2, eu-west-1, ap-southeast-2",
  );
});
