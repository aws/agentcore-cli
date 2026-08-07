import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureFactories, fixtureFetch, isRecording } from "./fixtures";
import { stringify } from "./serialization";

const dirs: string[] = [];
const replayTest = isRecording() ? test.skip : test;

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentcore-fixtures-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

replayTest("fetch fixtures ignore presigned query parameters", async () => {
  const dir = fixtureDir();
  const key = { method: "GET", path: "/bucket/dataset.jsonl" };
  const hash = Bun.hash(stringify(key)).toString(16);
  writeFileSync(
    join(dir, `Fetch.${hash}.json`),
    stringify({ status: 200, statusText: "OK", body: '{"exampleId":"e-1"}\n' }),
  );

  const fetch = fixtureFetch(dir);
  const response = await fetch("https://example.com/bucket/dataset.jsonl?signature=new");

  expect(response.status).toBe(200);
  expect(await response.text()).toBe('{"exampleId":"e-1"}\n');
});

replayTest("SDK fixtures ignore only the top-level client token", async () => {
  class FixtureCommand {
    constructor(readonly input: unknown) {}
  }

  const dir = fixtureDir();
  const normalizedInput = {
    examples: [{ content: { clientToken: "customer-data" } }],
  };
  const hash = Bun.hash(stringify(normalizedInput)).toString(16);
  writeFileSync(join(dir, `FixtureCommand.${hash}.json`), stringify({ status: "UPDATING" }));

  const { createControlClient } = fixtureFactories(dir);
  const client = createControlClient({ region: "us-west-2" });
  const response = await client.send(
    new FixtureCommand({
      clientToken: "generated-token",
      examples: [{ content: { clientToken: "customer-data" } }],
    }) as never,
  );

  expect(response as unknown).toEqual({ status: "UPDATING" });
  await expect(
    client.send(
      new FixtureCommand({
        clientToken: "another-generated-token",
        examples: [{ content: { clientToken: "different-customer-data" } }],
      }) as never,
    ),
  ).rejects.toThrow("Missing fixture");
});
