import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CoreClient } from "../../core";
import { createRootHandler } from "../index";
import {
  createSilentLogger,
  fixtureFactories,
  fixtureFetch,
  matchGolden,
  TestGlobalConfigAccessor,
  testIO,
  type TestIOOptions,
} from "../../testing";
import { UserCancellationError } from "../../errors";
import { ApertureError } from "./submit";
import type { CoreFetch } from "../../core/types";

const REGION = "us-east-1";
const FIXTURES = join(import.meta.dir, "__fixtures__");
const SHOT = join(FIXTURES, "shot.png");

const neverFetch = (async () => {
  throw new Error("network should not be reached");
}) as unknown as CoreFetch;

async function run(
  args: string[],
  opts: { fetch?: CoreFetch; io?: TestIOOptions } = {},
): Promise<{ stdout: string; stderr: string }> {
  const io = testIO(opts.io);
  const core = new CoreClient({
    ...fixtureFactories(FIXTURES),
    logger: createSilentLogger(),
    fetch: opts.fetch ?? neverFetch,
  });
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", "feedback", ...args, "--region", REGION]);
  return { stdout: io.stdout(), stderr: io.stderr() };
}

describe("feedback (fixture-backed)", () => {
  test("submits text-only feedback and prints the result envelope", async () => {
    const { stdout } = await run(
      ["[agentcore-cli golden fixture] text submit — please ignore", "--yes", "--json"],
      { fetch: fixtureFetch(join(FIXTURES, "submit-text")) },
    );

    matchGolden(FIXTURES, "submit-text.golden.json", stdout);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(typeof result.id).toBe("string");
    expect(result.reference).toBe("agentcore-cli");
  }, 120_000);

  test("submits feedback with a screenshot (presign → S3 PUT → form)", async () => {
    const { stdout } = await run(
      [
        "[agentcore-cli golden fixture] screenshot submit — please ignore",
        "--screenshot",
        SHOT,
        "--yes",
        "--json",
      ],
      { fetch: fixtureFetch(join(FIXTURES, "submit-screenshot")) },
    );

    matchGolden(FIXTURES, "submit-screenshot.golden.json", stdout);
    expect(JSON.parse(stdout).success).toBe(true);
  }, 120_000);

  test("without --yes and without a TTY it fails rather than submitting", async () => {
    await expect(run(["headless", "--json"], { fetch: neverFetch })).rejects.toThrow(/--yes/);
  });

  test("declining the consent prompt cancels", async () => {
    await expect(
      run(["no thanks"], { fetch: neverFetch, io: { isTTY: true, stdin: "n\n" } }),
    ).rejects.toBeInstanceOf(UserCancellationError);
  });

  test("an empty message is rejected", async () => {
    await expect(run(["   ", "--yes"], { fetch: neverFetch })).rejects.toThrow(/cannot be empty/);
  });

  test("a message over 1000 characters is rejected", async () => {
    await expect(run(["x".repeat(1001), "--yes"], { fetch: neverFetch })).rejects.toThrow(
      /1000 characters/,
    );
  });

  test("an explicitly-empty --screenshot is rejected", async () => {
    await expect(run(["msg", "--screenshot", "", "--yes"], { fetch: neverFetch })).rejects.toThrow(
      /--screenshot requires a file path/,
    );
  });
});

type Recorded = { url: string; method: string; headers: Headers; body: unknown };

function capturingFetch(canned: { presign?: string; form?: string; formStatus?: number }): {
  fetch: CoreFetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetch = (async (input: Parameters<CoreFetch>[0], init?: Parameters<CoreFetch>[1]) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body,
    });
    if (url.includes("/presignedurl")) {
      return new Response(canned.presign ?? "", { status: 200 });
    }
    if (url.includes("/form")) {
      return new Response(canned.form ?? "{}", {
        status: canned.formStatus ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(null, { status: 200 });
  }) as unknown as CoreFetch;
  return { fetch, calls };
}

const OK_FORM = JSON.stringify({
  reference: "agentcore-cli",
  id: "id-1",
  timestamp: "2026-01-01T00:00:00Z",
});
const PRESIGN_URL =
  "https://bucket.s3.us-east-1.amazonaws.com/us-east-1/AgentCore/CLI/0.1.0/13052026/abc-123.png?X-Amz-Signature=sig";

describe("feedback (request contract)", () => {
  test("screenshot flow sends checksum + NOT_SCANNED headers and the parsed object key", async () => {
    const { fetch, calls } = capturingFetch({ presign: PRESIGN_URL, form: OK_FORM });
    await run(["with shot", "--screenshot", SHOT, "--yes", "--json"], { fetch });

    expect(
      calls.map((c) =>
        c.url.includes("/presignedurl") ? "presign" : c.url.includes("/form") ? "form" : "s3",
      ),
    ).toEqual(["presign", "s3", "form"]);

    const put = calls[1]!;
    expect(put.method).toBe("PUT");
    expect(put.headers.get("x-amz-checksum-algorithm")).toBe("SHA256");
    expect(put.headers.get("x-amz-checksum-sha256")).toBeTruthy();
    expect(put.headers.get("x-amz-tagging")).toBe("scanstatus=NOT_SCANNED");

    const form = JSON.parse(String(calls[2]!.body));
    const attachment = form.customerResponses.find(
      (r: { response: { responseType: string } }) => r.response.responseType === "fileUpload",
    );
    expect(attachment.response.responseValue).toEqual([
      "us-east-1/AgentCore/CLI/0.1.0/13052026/abc-123.png",
    ]);
  });

  test("a malformed form response is rejected as an ApertureError", async () => {
    const { fetch } = capturingFetch({ form: "{}" });
    await expect(run(["hi", "--yes", "--json"], { fetch })).rejects.toBeInstanceOf(ApertureError);
  });

  test("an invalid presign body fails before the upload (no PUT)", async () => {
    const { fetch, calls } = capturingFetch({ presign: "not-a-url", form: OK_FORM });
    await expect(
      run(["with shot", "--screenshot", SHOT, "--yes", "--json"], { fetch }),
    ).rejects.toBeInstanceOf(ApertureError);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/presignedurl");
  });
});
