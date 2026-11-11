import { describe, expect, test } from "bun:test";
import { fakeCloudFormation, moveActions, NO_WAIT } from "./migrate-cfn-test-support";
import { createRefactor, executeRefactor, needsManualRepair, StackRefactorError } from "./refactor";
import type { TemplateStore } from "./templateStore";

const STACK = "AgentCore-Proj-default";
const RENAMES = new Map([["OldMemory", "NewMemory"]]);

function stack(client: ReturnType<typeof fakeCloudFormation>["client"], store?: TemplateStore) {
  return {
    target: "default",
    region: "us-east-1",
    stackName: STACK,
    renames: RENAMES,
    template: { Resources: { NewMemory: { Type: "AWS::BedrockAgentCore::Memory" } } },
    client,
    templates: async () => store ?? noStore(),
  };
}

function noStore(): TemplateStore {
  return {
    put: async () => {
      throw new Error("a small template must not be uploaded");
    },
    remove: async () => {},
  };
}

describe("createRefactor", () => {
  test("creates the refactor, waits for it, and lists its actions", async () => {
    const { client, sent } = fakeCloudFormation({
      CreateStackRefactor: [{ StackRefactorId: "rf-1" }],
      DescribeStackRefactor: [{ Status: "CREATE_IN_PROGRESS" }, { Status: "CREATE_COMPLETE" }],
      ListStackRefactorActions: [moveActions(STACK, [["OldMemory", "NewMemory"]])],
    });

    const created = await createRefactor(stack(client), NO_WAIT);

    expect(created.refactorId).toBe("rf-1");
    expect(created.actions).toEqual([
      {
        action: "MOVE",
        entity: "RESOURCE",
        from: "OldMemory",
        to: "NewMemory",
        physicalResourceId: "phys-OldMemory",
      },
    ]);
    const create = sent.find((command) => command.name === "CreateStackRefactor")!;
    expect(create.input.EnableStackCreation).toBe(false);
    expect(create.input.ResourceMappings).toEqual([
      {
        Source: { StackName: STACK, LogicalResourceId: "OldMemory" },
        Destination: { StackName: STACK, LogicalResourceId: "NewMemory" },
      },
    ]);
    const [definition] = create.input.StackDefinitions as Array<Record<string, unknown>>;
    expect(definition!.StackName).toBe(STACK);
    expect(typeof definition!.TemplateBody).toBe("string");
    expect(sent.some((command) => command.name === "ExecuteStackRefactor")).toBe(false);
  });

  test("uploads a template over the inline limit and passes its URL", async () => {
    const uploads: string[] = [];
    const removed: string[] = [];
    const store: TemplateStore = {
      put: async (key) => {
        uploads.push(key);
        return `https://bucket.s3.amazonaws.com/${key}`;
      },
      remove: async (key) => {
        removed.push(key);
      },
    };
    const { client, sent } = fakeCloudFormation({
      CreateStackRefactor: [{ StackRefactorId: "rf-big" }],
      DescribeStackRefactor: [{ Status: "CREATE_COMPLETE" }],
      ListStackRefactorActions: [moveActions(STACK, [["OldMemory", "NewMemory"]])],
    });
    const big = {
      ...stack(client, store),
      template: { Resources: { NewMemory: { Type: "X", Metadata: { pad: "x".repeat(60_000) } } } },
    };

    await createRefactor(big, NO_WAIT);

    const [definition] = sent.find((command) => command.name === "CreateStackRefactor")!.input
      .StackDefinitions as Array<Record<string, unknown>>;
    expect(definition!.TemplateBody).toBeUndefined();
    expect(definition!.TemplateURL).toBe(`https://bucket.s3.amazonaws.com/${uploads[0]}`);
    expect(removed).toEqual(uploads);
  });

  test("a rejected refactor is a create failure that changed nothing", async () => {
    const { client } = fakeCloudFormation({
      CreateStackRefactor: [{ StackRefactorId: "rf-2" }],
      DescribeStackRefactor: [{ Status: "CREATE_FAILED", StatusReason: "bad mapping" }],
    });

    const error = await createRefactor(stack(client), NO_WAIT).catch((caught) => caught);

    expect(error).toBeInstanceOf(StackRefactorError);
    expect(error.details).toMatchObject({ kind: "create-failed", refactorId: "rf-2" });
    expect(error.message).toContain("bad mapping");
    expect(needsManualRepair(error)).toBe(false);
  });
});

describe("executeRefactor", () => {
  const created = (client: ReturnType<typeof fakeCloudFormation>["client"]) => ({
    stack: stack(client),
    refactorId: "rf-1",
    actions: [],
  });

  test("waits for EXECUTE_COMPLETE", async () => {
    const { client, sent } = fakeCloudFormation({
      ExecuteStackRefactor: [{}],
      DescribeStackRefactor: [
        { ExecutionStatus: "AVAILABLE" },
        { ExecutionStatus: "EXECUTE_IN_PROGRESS" },
        { ExecutionStatus: "EXECUTE_COMPLETE" },
      ],
    });

    await executeRefactor(created(client), NO_WAIT);

    expect(sent.filter((command) => command.name === "DescribeStackRefactor")).toHaveLength(3);
  });

  test("shows the stack's resource events under the step, like deploy, without failing on them", async () => {
    const event = (id: string, status: string, type: string, logicalId: string) => ({
      EventId: id,
      ResourceStatus: status,
      ResourceType: type,
      LogicalResourceId: logicalId,
    });
    const before = event("e0", "UPDATE_COMPLETE", "AWS::BedrockAgentCore::Memory", "OldMemory");
    const memory = "AWS::BedrockAgentCore::Memory";
    const { client } = fakeCloudFormation({
      ExecuteStackRefactor: [{}],
      // Newest first, as CloudFormation returns them.
      DescribeStackEvents: [
        { StackEvents: [before] },
        new Error("throttled"),
        {
          StackEvents: [
            event("e2", "EXPORT_COMPLETE", memory, "OldMemory"),
            event("e1", "UPDATE_IN_PROGRESS", "AWS::CloudFormation::Stack", STACK),
            before,
          ],
        },
        {
          StackEvents: [
            event("e3", "IMPORT_COMPLETE", memory, "NewMemory"),
            event("e2", "EXPORT_COMPLETE", memory, "OldMemory"),
            before,
          ],
        },
      ],
      DescribeStackRefactor: [
        { ExecutionStatus: "EXECUTE_IN_PROGRESS" },
        { ExecutionStatus: "EXECUTE_IN_PROGRESS" },
        { ExecutionStatus: "EXECUTE_COMPLETE" },
      ],
    });
    const lines: string[] = [];

    await executeRefactor(created(client), { ...NO_WAIT, onOutput: (line) => lines.push(line) });

    expect(lines).toEqual([
      `${STACK} | 1/2 | EXPORT_COMPLETE | ${memory} | OldMemory`,
      `${STACK} | 2/2 | IMPORT_COMPLETE | ${memory} | NewMemory`,
    ]);
  });

  test("a failure CloudFormation rolled back left the stack unchanged", async () => {
    const { client } = fakeCloudFormation({
      ExecuteStackRefactor: [{}],
      DescribeStackRefactor: [
        { ExecutionStatus: "EXECUTE_FAILED", ExecutionStatusReason: "Property changes detected" },
        { ExecutionStatus: "ROLLBACK_IN_PROGRESS" },
        {
          ExecutionStatus: "ROLLBACK_COMPLETE",
          ExecutionStatusReason: "Property changes detected",
        },
      ],
    });

    const error = await executeRefactor(created(client), NO_WAIT).catch((caught) => caught);

    expect(error.details.kind).toBe("execute-failed");
    expect(error.message).toContain("rolled it back");
    expect(needsManualRepair(error)).toBe(false);
  });

  test("a failed rollback needs manual repair", async () => {
    const { client } = fakeCloudFormation({
      ExecuteStackRefactor: [{}],
      DescribeStackRefactor: [{ ExecutionStatus: "ROLLBACK_FAILED" }],
    });

    const error = await executeRefactor(created(client), NO_WAIT).catch((caught) => caught);

    expect(error.details.kind).toBe("rollback-failed");
    expect(needsManualRepair(error)).toBe(true);
  });

  test("an Execute call CloudFormation refused (4xx) didn't start the refactor", async () => {
    const { client, sent } = fakeCloudFormation({
      ExecuteStackRefactor: [
        Object.assign(new Error("Rate exceeded"), { $metadata: { httpStatusCode: 400 } }),
      ],
    });

    const error = await executeRefactor(created(client), NO_WAIT).catch((caught) => caught);

    expect(error.details.kind).toBe("execute-failed");
    expect(error.message).toContain("refused to start");
    expect(needsManualRepair(error)).toBe(false);
    expect(sent.some((command) => command.name === "DescribeStackRefactor")).toBe(false);
  });

  for (const [label, failure] of [
    [
      "a server error (5xx)",
      Object.assign(new Error("Internal"), { $metadata: { httpStatusCode: 500 } }),
    ],
    ["a lost response", new Error("socket hang up")],
    ["a timeout", Object.assign(new Error("timed out"), { name: "TimeoutError" })],
  ] as const) {
    test(`an Execute call that ended in ${label} is unknown, however AVAILABLE the refactor reads`, async () => {
      const { client } = fakeCloudFormation({
        ExecuteStackRefactor: [failure],
        DescribeStackRefactor: [{ ExecutionStatus: "AVAILABLE" }],
      });

      const error = await executeRefactor(created(client), NO_WAIT).catch((caught) => caught);

      expect(error.details.kind).toBe("unknown");
      expect(error.details.refactorId).toBe("rf-1");
      expect(error.message).toContain("isn't known");
      expect(needsManualRepair(error)).toBe(true);
    });
  }

  test("losing track of the refactor is unknown, which needs a look", async () => {
    const { client } = fakeCloudFormation({
      ExecuteStackRefactor: [{}],
      DescribeStackRefactor: [new Error("network down")],
    });

    const error = await executeRefactor(created(client), NO_WAIT).catch((caught) => caught);

    expect(error.details.kind).toBe("unknown");
    expect(needsManualRepair(error)).toBe(true);
  });
});
