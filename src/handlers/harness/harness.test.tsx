import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { CoreClient } from "../../core";
import { createRootHandler } from "../index";
import {
  createSilentLogger,
  fixtureFactories,
  isRecording,
  matchGolden,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";

// End-to-end command-flow tests for the `harness` subtree.
//
// Each test builds the *real* root handler over a *real* CoreClient whose SDK
// clients are the fixture-backed fakes, then drives it through the top-level
// `route()` exactly as the CLI does. So a single test covers argument parsing,
// the withRegion / withTuiOnEmptyFlagsAndArgs middleware, the leaf handler, the
// CoreClient/HarnessClient, and the rendered output — against recorded data.
//
// Record fixtures + golden output with `RECORD=1 bun test`; every other run
// replays them offline.

const FIXTURES = join(import.meta.dir, "__fixtures__");
// Pin a region so recordings are stable regardless of the machine's AWS env.
const REGION = "us-west-2";

// run builds a fresh handler tree (CoreClient carries per-run caches, so this
// keeps tests isolated) over an in-memory io, routes `args` beneath `agentcore`,
// and returns whatever the command wrote to stdout.
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
  const core = createFixtureCore();
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return io.stdout();
}

describe("harness list", () => {
  // `--json` keeps output machine-readable; without any own flags the
  // withTuiOnEmptyFlagsAndArgs middleware would instead launch the interactive
  // TUI (covered by the screen tests).
  test("prints the listed harnesses as JSON", async () => {
    const out = await run(["harness", "list", "--json"]);
    matchGolden(FIXTURES, "list.golden.json", out);
  });

  test("output is valid JSON containing a harnesses array", async () => {
    const out = await run(["harness", "list", "--json"]);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed.harnesses)).toBe(true);
  });
});

describe("harness get", () => {
  test("prints the harness detail as JSON for a given id", async () => {
    const out = await run(["harness", "get", "--id", "MyPDXHarness-rhkXkAE1IS"]);
    matchGolden(FIXTURES, "get.golden.json", out);
  });

  test("errors when --id is omitted (leaf requires it)", async () => {
    // No id and no other flags would normally open the TUI, but withRegion adds
    // no arg; the get leaf throws its own required-option error. Assert the flow
    // surfaces it rather than printing output.
    await expect(run(["harness", "get", "--id", ""])).rejects.toThrow(/--id/);
  });
});

describe("harness runtime resolution", () => {
  test("resolves the underlying Runtime from a recorded harness response", async () => {
    const core = createFixtureCore();

    await expect(
      core.harness.resolveRuntime("MyPDXHarness-rhkXkAE1IS", { region: REGION }),
    ).resolves.toEqual({
      runtimeId: "harness_MyPDXHarness-8WBKGfHzjg",
      runtimeName: "harness_MyPDXHarness",
    });
  });
});

describe("harness endpoint list", () => {
  test("prints the harness's endpoints as JSON for a given id", async () => {
    const out = await run(["harness", "endpoint", "list", "--id", "MyPDXHarness-rhkXkAE1IS"]);
    matchGolden(FIXTURES, "endpoint-list.golden.json", out);
  });

  test("output is valid JSON containing an endpoints array", async () => {
    const out = await run(["harness", "endpoint", "list", "--id", "MyPDXHarness-rhkXkAE1IS"]);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed.endpoints)).toBe(true);
  });

  test("errors when --id is omitted (leaf requires it)", async () => {
    await expect(run(["harness", "endpoint", "list", "--id", ""])).rejects.toThrow(/--id/);
  });
});

describe("harness endpoint get", () => {
  test("prints the endpoint detail as JSON for a given id and qualifier", async () => {
    const out = await run([
      "harness",
      "endpoint",
      "get",
      "--id",
      "MyPDXHarness-rhkXkAE1IS",
      "--qualifier",
      "DEFAULT",
    ]);
    matchGolden(FIXTURES, "endpoint-get.golden.json", out);
  });

  test("errors when --id is omitted (leaf requires it)", async () => {
    await expect(
      run(["harness", "endpoint", "get", "--id", "", "--qualifier", "DEFAULT"]),
    ).rejects.toThrow(/--id/);
  });

  test("errors when --qualifier is omitted (leaf requires it)", async () => {
    await expect(
      run(["harness", "endpoint", "get", "--id", "MyPDXHarness-rhkXkAE1IS", "--qualifier", ""]),
    ).rejects.toThrow(/--qualifier/);
  });
});

describe("harness version list", () => {
  test("prints the harness's versions as JSON for a given id", async () => {
    const out = await run(["harness", "version", "list", "--id", "MyPDXHarness-rhkXkAE1IS"]);
    matchGolden(FIXTURES, "version-list.golden.json", out);
  });

  test("output is valid JSON containing a harnessVersions array", async () => {
    const out = await run(["harness", "version", "list", "--id", "MyPDXHarness-rhkXkAE1IS"]);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed.harnessVersions)).toBe(true);
  });

  test("errors when --id is omitted (leaf requires it)", async () => {
    await expect(run(["harness", "version", "list", "--id", ""])).rejects.toThrow(/--id/);
  });
});

describe("harness version get", () => {
  test("prints the harness detail as JSON for a given id and version", async () => {
    const out = await run([
      "harness",
      "version",
      "get",
      "--id",
      "MyPDXHarness-rhkXkAE1IS",
      "--version",
      "1",
    ]);
    matchGolden(FIXTURES, "version-get.golden.json", out);
  });

  test("errors when --id is omitted (leaf requires it)", async () => {
    await expect(run(["harness", "version", "get", "--id", "", "--version", "1"])).rejects.toThrow(
      /--id/,
    );
  });

  test("errors when --version is omitted (leaf requires it)", async () => {
    await expect(
      run(["harness", "version", "get", "--id", "MyPDXHarness-rhkXkAE1IS", "--version", ""]),
    ).rejects.toThrow(/--version/);
  });
});

describe("write command validation", () => {
  // Each write leaf declares its identifying flags optional (so a bare
  // invocation opens the TUI) but requires them at runtime.
  test("`harness create` errors when --name is omitted", async () => {
    await expect(run(["harness", "create", "--name", ""])).rejects.toThrow(/--name/);
  });

  test("`harness update` errors when --id is omitted", async () => {
    await expect(run(["harness", "update", "--id", ""])).rejects.toThrow(/--id/);
  });

  test("`harness delete` errors when --id is omitted", async () => {
    await expect(run(["harness", "delete", "--id", ""])).rejects.toThrow(/--id/);
  });

  test("`harness endpoint create` errors when --id or --name is omitted", async () => {
    await expect(run(["harness", "endpoint", "create", "--id", ""])).rejects.toThrow(/--id/);
    await expect(
      run(["harness", "endpoint", "create", "--id", "h-1", "--name", ""]),
    ).rejects.toThrow(/--name/);
  });

  test("`harness endpoint update` errors when --id or --qualifier is omitted", async () => {
    await expect(run(["harness", "endpoint", "update", "--id", ""])).rejects.toThrow(/--id/);
    await expect(
      run(["harness", "endpoint", "update", "--id", "h-1", "--qualifier", ""]),
    ).rejects.toThrow(/--qualifier/);
  });

  test("`harness endpoint delete` errors when --id or --qualifier is omitted", async () => {
    await expect(run(["harness", "endpoint", "delete", "--id", ""])).rejects.toThrow(/--id/);
    await expect(
      run(["harness", "endpoint", "delete", "--id", "h-1", "--qualifier", ""]),
    ).rejects.toThrow(/--qualifier/);
  });

  test("`harness create` rejects malformed JSON flags", async () => {
    await expect(
      run(["harness", "create", "--name", "Broken", "--tools", "{not json"]),
    ).rejects.toThrow(/Invalid JSON for option '--tools'/);
  });
});

// ─── write flow (create → update → endpoint lifecycle → delete) ───────────────
//
// These tests drive the full lifecycle of a real harness, in order, through the
// top-level route(). In record mode they hit the live control plane (and IAM,
// for the default execution role) and persist every exchange; replays are
// offline and instant. The suite deletes everything it creates, so re-recording
// from a steady state converges. Later tests consume ids parsed from earlier
// output, which replays identically from the fixtures.

const E2E_NAME = "AgentCoreCliE2E";
const ENDPOINT_NAME = "live";
// Generous timeouts: in record mode, readiness polls wait on real control-plane
// transitions (a create takes ~30s). Replay never sleeps.
const FLOW_TIMEOUT = 600_000;

// state threads the created harness's id through the ordered flow tests.
const state: { harnessId?: string } = {};

// pollUntil re-runs `command` until `done(parsed output)` is true. Polling only
// sleeps in record mode; in replay the fixture already holds the settled state
// (the last recorded poll), so the first read satisfies `done`.
async function pollUntil(command: string[], done: (output: any) => boolean): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const parsed = JSON.parse(await run(command));
    if (done(parsed)) return;
    if (!isRecording()) {
      throw new Error(
        `Replayed fixture for \`${command.join(" ")}\` is not in the awaited state; re-record.`,
      );
    }
    await Bun.sleep(5_000);
  }
  throw new Error(`Timed out waiting for \`${command.join(" ")}\``);
}

describe("harness write flow", () => {
  test(
    "`harness create` provisions a default execution role and creates the harness",
    async () => {
      const out = await run([
        "harness",
        "create",
        "--name",
        E2E_NAME,
        "--system-prompt",
        "You are a concise assistant used in an end-to-end CLI test.",
        "--max-iterations",
        "25",
        "--tags",
        '{"created-by":"agentcore-cli-e2e"}',
      ]);
      matchGolden(FIXTURES, "create.golden.json", out);

      const parsed = JSON.parse(out);
      expect(parsed.harness.harnessName).toBe(E2E_NAME);
      // No --execution-role-arn was passed: the default role was provisioned.
      expect(parsed.harness.executionRoleArn).toContain(`AgentCoreHarness-${E2E_NAME}`);
      expect(parsed.harness.harnessId).toBeDefined();
      state.harnessId = parsed.harness.harnessId;

      await pollUntil(
        ["harness", "get", "--id", state.harnessId!],
        (o) => o.harness.status === "READY",
      );
    },
    FLOW_TIMEOUT,
  );

  test(
    "`harness update` updates the prompt and creates version 2",
    async () => {
      const out = await run([
        "harness",
        "update",
        "--id",
        state.harnessId!,
        "--system-prompt",
        "You are an updated assistant used in an end-to-end CLI test.",
        "--max-iterations",
        "30",
      ]);
      matchGolden(FIXTURES, "update.golden.json", out);

      const parsed = JSON.parse(out);
      expect(parsed.harness.harnessVersion).toBe("2");

      await pollUntil(
        ["harness", "get", "--id", state.harnessId!],
        (o) => o.harness.status === "READY",
      );
    },
    FLOW_TIMEOUT,
  );

  test(
    "`harness endpoint create` points a named endpoint at version 1",
    async () => {
      const out = await run([
        "harness",
        "endpoint",
        "create",
        "--id",
        state.harnessId!,
        "--name",
        ENDPOINT_NAME,
        "--target-version",
        "1",
      ]);
      matchGolden(FIXTURES, "endpoint-create.golden.json", out);

      const parsed = JSON.parse(out);
      expect(parsed.endpoint.endpointName).toBe(ENDPOINT_NAME);
      expect(parsed.endpoint.targetVersion).toBe("1");

      await pollUntil(
        ["harness", "endpoint", "get", "--id", state.harnessId!, "--qualifier", ENDPOINT_NAME],
        (o) => o.endpoint.status === "READY",
      );
    },
    FLOW_TIMEOUT,
  );

  test(
    "`harness endpoint update` repoints the endpoint at version 2",
    async () => {
      const out = await run([
        "harness",
        "endpoint",
        "update",
        "--id",
        state.harnessId!,
        "--qualifier",
        ENDPOINT_NAME,
        "--target-version",
        "2",
      ]);
      matchGolden(FIXTURES, "endpoint-update.golden.json", out);

      const parsed = JSON.parse(out);
      expect(parsed.endpoint.targetVersion).toBe("2");

      await pollUntil(
        ["harness", "endpoint", "get", "--id", state.harnessId!, "--qualifier", ENDPOINT_NAME],
        (o) => o.endpoint.status === "READY" && o.endpoint.liveVersion === "2",
      );
    },
    FLOW_TIMEOUT,
  );

  test(
    "`harness endpoint delete` deletes the endpoint",
    async () => {
      const out = await run([
        "harness",
        "endpoint",
        "delete",
        "--id",
        state.harnessId!,
        "--qualifier",
        ENDPOINT_NAME,
      ]);
      matchGolden(FIXTURES, "endpoint-delete.golden.json", out);
      expect(JSON.parse(out).endpoint.status).toBe("DELETING");
    },
    FLOW_TIMEOUT,
  );

  test(
    "`harness delete` deletes the harness",
    async () => {
      // Endpoint deletion must settle before the harness itself can go.
      if (isRecording()) await Bun.sleep(10_000);
      const out = await run(["harness", "delete", "--id", state.harnessId!]);
      matchGolden(FIXTURES, "delete.golden.json", out);
      expect(JSON.parse(out).harness.status).toBe("DELETING");
    },
    FLOW_TIMEOUT,
  );
});
