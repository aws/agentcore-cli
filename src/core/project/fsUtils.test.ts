import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputValidationError } from "../../errors";
import { readHarnessFiles } from "./fsUtils";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-files-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const model = { bedrockModelConfig: { modelId: "m1" } };
const writeSpec = (spec: Record<string, unknown>) =>
  writeFile(join(dir, "harness.yaml"), JSON.stringify({ name: "h1", model, ...spec }));

test.each([
  ["inline prompt", { systemPrompt: [{ text: "inline" }] }, "from file", "inline"],
  ["prompt file", {}, "from file", "from file"],
  ["no prompt", {}, undefined, undefined],
])("reads the %s", async (_case, spec, file, expected) => {
  await writeSpec(spec);
  if (file) await writeFile(join(dir, "system-prompt.md"), file);

  const files = await readHarnessFiles(dir);

  expect(files.spec.name).toBe("h1");
  expect(files.systemPrompt).toBe(expected);
});

test.each([
  [
    "a flat model",
    { model: { provider: "bedrock", modelId: "m1" } },
    undefined,
    /Invalid harness.yaml/,
  ],
  ["an empty prompt file", {}, "  \n", /is empty or whitespace-only/],
])("rejects %s", async (_case, spec, file, message) => {
  await writeSpec(spec);
  if (file) await writeFile(join(dir, "system-prompt.md"), file);

  const read = readHarnessFiles(dir);

  await expect(read).rejects.toBeInstanceOf(InputValidationError);
  await expect(read).rejects.toThrow(message);
});
