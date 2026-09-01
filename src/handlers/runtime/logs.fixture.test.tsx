import { expect, test } from "bun:test";
import { join } from "node:path";
import { CoreClient } from "../../core";
import {
  createSilentLogger,
  fixtureFactories,
  matchGolden,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { createRootHandler } from "../index";

const REGION = "us-west-2";
const FIXTURES = join(import.meta.dir, "__fixtures__");
const FIXTURE_RUNTIME_ID = "asdf_MyAgent-3s5axvBC6Q";
const FIXTURE_SESSION_ID = "67ebf93b-65e3-4127-9e13-483b239f256a";
const WINDOW_START = "2026-08-12T00:00:00Z";
const WINDOW_END = "2026-08-13T00:00:00Z";

// RECORD=1 bun test src/handlers/runtime/logs.fixture.test.tsx
function createFixtureCore(): CoreClient {
  const { createControlClient, createDataClient, createIamClient, createLogsClient } =
    fixtureFactories(FIXTURES);
  return new CoreClient({
    createControlClient,
    createDataClient,
    createIamClient,
    createLogsClient,
    logger: createSilentLogger(),
  });
}

async function run(args: string[]): Promise<string> {
  const io = testIO();
  const root = createRootHandler(createFixtureCore(), {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["bun", "agentcore", ...args, "--region", REGION]);
  return io.stdout();
}

const SEARCH_ARGS = [
  "runtime",
  "logs",
  "--id",
  FIXTURE_RUNTIME_ID,
  "--since",
  WINDOW_START,
  "--until",
  WINDOW_END,
  "--query",
  `"${FIXTURE_SESSION_ID}"`,
  "--limit",
  "1",
];

test("runtime logs renders recorded search results", async () => {
  const stdout = await run(SEARCH_ARGS);

  expect(stdout).not.toBe("");
  matchGolden(FIXTURES, "logs-search.golden.txt", stdout);
});

test("runtime logs renders normalized records as JSON Lines", async () => {
  const stdout = await run([...SEARCH_ARGS, "--json"]);

  expect(JSON.parse(stdout)).toMatchObject({
    source: {
      provider: "cloudwatch",
      resource: {
        kind: "runtime",
        id: FIXTURE_RUNTIME_ID,
        qualifier: "DEFAULT",
      },
    },
  });
  matchGolden(FIXTURES, "logs-search-json.golden.json", stdout);
});
