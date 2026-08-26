import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "bun:test";
import type { BedrockAgentCoreControlClient } from "@aws-sdk/client-bedrock-agentcore-control";
import type { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import type { IAMClient } from "@aws-sdk/client-iam";
import type { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import type {
  ClientConfig,
  CreateControlClient,
  CreateDataClient,
  CreateIamClient,
  CreateLogsClient,
  CoreFetch,
} from "../core/types";
import {
  createControlClient,
  createDataClient,
  createIamClient,
  createLogsClient,
} from "../core/factories";
import { parse, stringify } from "./serialization";

// Golden-file record/replay for the AWS SDK seam.
//
// The whole suite runs in one of two modes, selected by the RECORD env var:
//
//   RECORD=1 bun test   — hit the live AWS APIs through the real client factories
//                         and save each response as a fixture (golden file).
//   bun test            — replay the saved fixtures; never touch the network.
//
// Recording plugs in at the SDK `.send()` seam (the same seam src/index.ts wires
// the real clients into), so replayed tests still exercise the real CoreClient,
// HarnessClient, and option translation — only the network call is swapped out.

// isRecording reports whether the suite should call the live APIs and refresh
// fixtures. Any truthy-ish RECORD value ("1", "true") turns it on.
export function isRecording(): boolean {
  const v = process.env.RECORD;
  return v === "1" || v === "true";
}

// settle waits out a service-side state transition between two calls that cannot
// overlap (e.g. AgentCore rejects an update while the resource is still UPDATING).
// It only sleeps while recording: on replay the fixtures are served from disk, so
// there is no state machine to wait for and the test stays fast and deterministic.
// Give the enclosing test a timeout that accommodates the wait.
export async function settle(ms = 5_000): Promise<void> {
  if (!isRecording()) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// An AWS SDK command as seen at the `.send()` boundary: its class carries the
// operation name and it holds the request `input`. We only read these.
interface SdkCommand {
  input: unknown;
  constructor: { name: string };
}

// fixturePath derives a stable, human-readable golden-file path for a command
// invocation: `<dir>/<Operation>.<inputHash>.json`. Keying on the input hash
// lets one operation have several fixtures (e.g. different harness IDs) while
// staying deterministic and offline-stable across runs.
function fixturePath(dir: string, command: SdkCommand): string {
  const op = command.constructor.name;
  const hash = Bun.hash(stringify(normalizeFixtureInput(command.input ?? {}))).toString(16);
  return join(dir, `${op}.${hash}.json`);
}

// The top-level clientToken is intentionally nondeterministic for idempotent
// mutations. Nested fields belong to the command payload and remain part of the
// fixture key.
function normalizeFixtureInput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { clientToken: _clientToken, ...input } = value as Record<string, unknown>;
  return input;
}

const PRESIGNED_QUERY_KEYS = [
  "X-Amz-Credential",
  "X-Amz-Security-Token",
  "X-Amz-Signature",
] as const;

// Recording continues with the original response so live downloads work. Only
// the persisted fixture or golden copy has presigned credentials removed.
export function sanitizePresignedUrls<T>(value: T): T {
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      if (PRESIGNED_QUERY_KEYS.some((key) => url.searchParams.has(key))) {
        url.search = "";
        return url.toString() as T;
      }
    } catch {
      // Most strings are not URLs.
    }
    return value;
  }
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(sanitizePresignedUrls) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        sanitizePresignedUrls(entry),
      ]),
    ) as T;
  }
  return value;
}

// normalizeResponse strips volatile transport metadata from a recorded SDK
// response. `$metadata` holds the HTTP status, retry counts, and a per-request
// `requestId` — none of it domain data, all of it non-deterministic across
// recordings. Dropping it keeps fixtures stable and keeps golden output focused
// on behavior (the harness data) rather than transport implementation details.
// Handlers/screens never read `$metadata`, so this is behavior-preserving.
function normalizeResponse(response: unknown): unknown {
  if (response && typeof response === "object" && "$metadata" in response) {
    // eslint-disable-next-line no-unused-vars
    const { $metadata, ...rest } = response as Record<string, unknown>;
    return rest;
  }
  return response;
}

// Service errors are as much a part of a recorded flow as successes (e.g. the
// default-execution-role flow probes GetRole and expects NoSuchEntityException
// on a fresh account). A rejected send is recorded under this tag and re-thrown
// with the same name/message on replay.
const ERROR_TAG = "$error";

interface TaggedError {
  [ERROR_TAG]: { name: string; message: string };
}

function isTaggedError(value: unknown): value is TaggedError {
  return typeof value === "object" && value !== null && ERROR_TAG in value;
}

function reviveError(tagged: TaggedError): Error {
  const error = new Error(tagged[ERROR_TAG].message);
  error.name = tagged[ERROR_TAG].name;
  return error;
}

const STREAM_TAG = "$stream";

async function freezeStream(response: unknown): Promise<unknown> {
  const stream = (response as { response?: { transformToString?: () => Promise<string> } })
    ?.response;
  if (typeof stream?.transformToString !== "function") return response;
  return {
    ...(response as Record<string, unknown>),
    response: { [STREAM_TAG]: await stream.transformToString() },
  };
}

async function* streamOf(text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
}

function reviveStream(recorded: unknown): unknown {
  const stream = (recorded as { response?: Record<string, unknown> })?.response;
  if (!stream || typeof stream !== "object" || !(STREAM_TAG in stream)) return recorded;
  return {
    ...(recorded as Record<string, unknown>),
    response: streamOf(stream[STREAM_TAG] as string),
  };
}

// makeRecordingSend returns a `.send()` that records to / replays from `dir`.
// In record mode it delegates to the real client, saves the response (or the
// service error), and propagates it; otherwise it reads the fixture, failing
// with an actionable message when one is missing.
function makeRecordingSend<C extends { send: (command: any) => Promise<any> }>(
  realClient: C,
  dir: string,
): (command: SdkCommand) => Promise<unknown> {
  return async (command: SdkCommand) => {
    const path = fixturePath(dir, command);

    if (isRecording()) {
      mkdirSync(dir, { recursive: true });
      let response: unknown;
      try {
        response = normalizeResponse(await realClient.send(command as never));
      } catch (error) {
        const tagged: TaggedError = {
          [ERROR_TAG]: { name: (error as Error).name, message: (error as Error).message },
        };
        writeFileSync(path, stringify(sanitizePresignedUrls(tagged)));
        throw error;
      }
      const frozen = await freezeStream(response);
      writeFileSync(path, stringify(sanitizePresignedUrls(frozen)));
      return reviveStream(frozen);
    }

    if (!existsSync(path)) {
      throw new Error(
        `Missing fixture ${path} for ${command.constructor.name}. ` +
          `Re-run with RECORD=1 to record it against the live API.`,
      );
    }
    const recorded = parse(readFileSync(path, "utf8"));
    if (isTaggedError(recorded)) throw reviveError(recorded);
    return reviveStream(recorded);
  };
}

// fixtureFactories builds Core client factories backed by the golden files in
// `dir`. Drop these into `new CoreClient(...)` to run the real command flow
// (parsing → middleware → handler → CoreClient) against recorded data. The fake
// clients only implement `.send()`, which is all CoreClient uses.
export function fixtureFactories(dir: string): {
  createControlClient: CreateControlClient;
  createDataClient: CreateDataClient;
  createIamClient: CreateIamClient;
  createLogsClient: CreateLogsClient;
} {
  return {
    createControlClient: (config: ClientConfig) => {
      // The real client is only constructed to satisfy record mode; in replay
      // mode its `.send()` is never reached.
      const real = createControlClient(config);
      return {
        send: makeRecordingSend(real, dir),
      } as unknown as BedrockAgentCoreControlClient;
    },
    createDataClient: (config: ClientConfig) => {
      const real = createDataClient(config);
      return {
        send: makeRecordingSend(real, dir),
      } as unknown as BedrockAgentCoreClient;
    },
    createIamClient: (config: ClientConfig) => {
      const real = createIamClient(config);
      return {
        send: makeRecordingSend(real, dir),
      } as unknown as IAMClient;
    },
    createLogsClient: (config: ClientConfig) => {
      const real = createLogsClient(config);
      return {
        send: makeRecordingSend(real, dir),
      } as unknown as CloudWatchLogsClient;
    },
  };
}

type FetchFixture = {
  status: number;
  statusText?: string;
  body: string;
};

function fetchFixturePath(
  dir: string,
  input: Parameters<CoreFetch>[0],
  init: Parameters<CoreFetch>[1],
): string {
  const url = input instanceof Request ? input.url : String(input);
  const parsed = new URL(url);
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const hash = Bun.hash(stringify({ method, path: parsed.pathname })).toString(16);
  return join(dir, `Fetch.${hash}.json`);
}

// fixtureFetch records/replays presigned content downloads, which sit outside
// the AWS SDK `.send()` seam. The fixture key ignores volatile query params on
// presigned URLs and keys on the stable object path instead.
export function fixtureFetch(dir: string): CoreFetch {
  return (async (input, init) => {
    const path = fetchFixturePath(dir, input, init);

    if (isRecording()) {
      mkdirSync(dir, { recursive: true });
      const response = await globalThis.fetch(input, init);
      const fixture: FetchFixture = {
        status: response.status,
        statusText: response.statusText,
        body: await response.text(),
      };
      writeFileSync(path, stringify(fixture));
      return new Response(fixture.body, {
        status: fixture.status,
        statusText: fixture.statusText,
      });
    }

    if (!existsSync(path)) {
      throw new Error(`Missing fetch fixture ${path}. Re-run with RECORD=1 to record it.`);
    }
    const fixture = parse<FetchFixture>(readFileSync(path, "utf8"));
    return new Response(fixture.body, {
      status: fixture.status,
      statusText: fixture.statusText,
    });
  }) as CoreFetch;
}

// matchGolden compares `actual` against the golden file `<dir>/<name>`. In record
// mode it (re)writes the file; otherwise it asserts equality, so a behavior change
// surfaces as a reviewable golden diff. Use for asserting a command's rendered
// output rather than pinning exact strings inline.
//
// Trailing whitespace is ignored on both sides: golden files are committed and
// the pre-commit Prettier hook adds a final newline to *.json, which is not a
// behavior difference worth failing on.
export function matchGolden(dir: string, name: string, actual: string): void {
  const path = join(dir, name);
  const sanitizedActual = sanitizeGoldenOutput(actual);

  if (isRecording()) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, sanitizedActual);
    return;
  }

  if (!existsSync(path)) {
    throw new Error(`Missing golden file ${path}. Re-run with RECORD=1 to record expected output.`);
  }
  const expected = readFileSync(path, "utf8");
  expect(sanitizedActual.replace(/\s+$/, "")).toBe(
    sanitizeGoldenOutput(expected).replace(/\s+$/, ""),
  );
}

function sanitizeGoldenOutput(output: string): string {
  try {
    return JSON.stringify(sanitizePresignedUrls(JSON.parse(output)), null, 2);
  } catch {
    return output;
  }
}
