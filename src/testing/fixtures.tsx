import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "bun:test";
import type { BedrockAgentCoreControlClient } from "@aws-sdk/client-bedrock-agentcore-control";
import type { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import type { IAMClient } from "@aws-sdk/client-iam";
import type {
  ClientConfig,
  CreateControlClient,
  CreateDataClient,
  CreateIamClient,
} from "../core/types";
import { createControlClient, createDataClient, createIamClient } from "../core/factories";
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
  const hash = Bun.hash(stringify(command.input ?? {})).toString(16);
  return join(dir, `${op}.${hash}.json`);
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
        writeFileSync(path, stringify(tagged));
        throw error;
      }
      writeFileSync(path, stringify(response));
      return response;
    }

    if (!existsSync(path)) {
      throw new Error(
        `Missing fixture ${path} for ${command.constructor.name}. ` +
          `Re-run with RECORD=1 to record it against the live API.`,
      );
    }
    const recorded = parse(readFileSync(path, "utf8"));
    if (isTaggedError(recorded)) throw reviveError(recorded);
    return recorded;
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
  };
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

  if (isRecording()) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, actual);
    return;
  }

  if (!existsSync(path)) {
    throw new Error(`Missing golden file ${path}. Re-run with RECORD=1 to record expected output.`);
  }
  const expected = readFileSync(path, "utf8");
  expect(actual.replace(/\s+$/, "")).toBe(expected.replace(/\s+$/, ""));
}
