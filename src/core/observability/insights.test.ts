import { describe, expect, test } from "bun:test";
import {
  GetQueryResultsCommand,
  StartQueryCommand,
  type CloudWatchLogsClient,
} from "@aws-sdk/client-cloudwatch-logs";
import { CloudWatchQueryError, InputValidationError, ResultTruncationError } from "../../errors";
import { runInsightsQuery, sanitizeQueryValue } from "./insights";

type Send = (command: unknown) => Promise<unknown>;

function fakeLogs(send: Send): CloudWatchLogsClient {
  return { send } as unknown as CloudWatchLogsClient;
}

function row(field: string, value: string) {
  return [{ field, value }];
}

describe("runInsightsQuery", () => {
  test("waits for completion and drains every result page", async () => {
    const logs = fakeLogs(async (command) => {
      if (command instanceof StartQueryCommand) {
        expect(command.input).toEqual({
          logGroupNames: ["/aws/group-a", "/aws/group-b"],
          queryString: "fields @message",
          startTime: 100,
          endTime: 200,
        });
        return { queryId: "q-1" };
      }
      const input = (command as GetQueryResultsCommand).input;
      if (input.nextToken === "page-2") {
        return { status: "Complete", results: [row("@message", "second")] };
      }
      return {
        status: "Complete",
        results: [row("@message", "first")],
        nextToken: "page-2",
      };
    });

    await expect(
      runInsightsQuery(logs, ["/aws/group-a", "/aws/group-b"], "fields @message", 100, 200),
    ).resolves.toEqual([row("@message", "first"), row("@message", "second")]);
  });

  test("throws a typed error for terminal failure states", async () => {
    const logs = fakeLogs(async (command) =>
      command instanceof StartQueryCommand ? { queryId: "q-2" } : { status: "Failed" },
    );

    await expect(runInsightsQuery(logs, ["/aws/g"], "q", 0, 1)).rejects.toThrow(
      CloudWatchQueryError,
    );
  });

  test("applies caller-provided row-ceiling errors", async () => {
    const logs = fakeLogs(async (command) =>
      command instanceof StartQueryCommand
        ? { queryId: "q-3" }
        : { status: "Complete", results: [row("@message", "a"), row("@message", "b")] },
    );

    await expect(
      runInsightsQuery(logs, ["/aws/g"], "q", 0, 1, {
        maxRows: 2,
        buildError: (maxRows) => new ResultTruncationError(`hit ceiling ${maxRows}`),
      }),
    ).rejects.toThrow("hit ceiling 2");
    await expect(
      runInsightsQuery(logs, ["/aws/g"], "q", 0, 1, {
        maxRows: 1,
        buildError: () => new InputValidationError("narrow the scope"),
      }),
    ).rejects.toThrow(InputValidationError);
  });
});

test("sanitizeQueryValue strips quotes from interpolated values", () => {
  expect(sanitizeQueryValue("abc'| drop '123")).toBe("abc| drop 123");
  expect(sanitizeQueryValue("clean-id")).toBe("clean-id");
});
