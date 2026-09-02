import { describe, expect, test } from "bun:test";
import type { Project, ProjectEvent } from "../../../../handlers/project/types";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";
import {
  createQuickCreateAuthorizationReporter,
  type PaymentConnectorCalls,
} from "./paymentConnectors";
import type { CdkCredentialProvider } from "./toolkit";

const REGION = "us-east-1";
const STACK = "AgentCore-example-default";
const CREDENTIALS: CdkCredentialProvider = async () => ({
  accessKeyId: "access-key",
  secretAccessKey: "secret-key",
});

/**
 * A manager as it exists in the fake account, keyed by the physical resource ID the
 * stack reports. Tests assert on the reported messages rather than on a call log, so
 * how the reporter gets there can change without breaking them.
 */
type FakeManager = {
  name: string;
  connectors: { name: string; id: string; status: string }[];
  /** The live URL the service hands back, absent once the window has closed. */
  authorizationUrls?: Record<string, string>;
};

function fakeAccount(
  managers: Record<string, FakeManager>,
  overrides: Partial<PaymentConnectorCalls> = {},
): PaymentConnectorCalls {
  return {
    listStackManagerIds: async () => Object.keys(managers),
    getManagerName: async ({ managerId }) => managers[managerId]?.name,
    listConnectors: async ({ managerId }) =>
      (managers[managerId]?.connectors ?? []).map(({ name, id, status }) => ({
        name,
        paymentConnectorId: id,
        status,
      })),
    getAuthorizationUrl: async ({ managerId, connectorId }) =>
      managers[managerId]?.authorizationUrls?.[connectorId],
    ...overrides,
  };
}

function project(payments: unknown[], credentials: unknown[] = []): Project {
  return {
    name: "example",
    rootPath: "/tmp/example",
    spec: ProjectSpecSchema.parse({ name: "example", version: 1, payments, credentials }),
  };
}

const quickCreate = (name: string) => ({
  name,
  provider: "CoinbaseCDP",
  provisionMode: "QUICK_CREATE",
});

async function report(
  calls: PaymentConnectorCalls,
  input: Project,
): Promise<{ messages: string[] }> {
  const generator = createQuickCreateAuthorizationReporter(calls)(input, {
    stackName: STACK,
    region: REGION,
    credentials: CREDENTIALS,
  });
  const messages: string[] = [];
  while (true) {
    const next: IteratorResult<ProjectEvent, void> = await generator.next();
    if (next.done) return { messages };
    if (next.value.type === "step") messages.push(next.value.message);
  }
}

describe("Quick Create authorization reporting", () => {
  test("hands over the live authorization link and says when it expires", async () => {
    const { messages } = await report(
      fakeAccount({
        "payments-abc": {
          name: "payments",
          connectors: [{ name: "quick", id: "quick-xyz", status: "PENDING_AUTHENTICATION" }],
          authorizationUrls: { "quick-xyz": "https://example.com/authorize?request_uri=urn:x" },
        },
      }),
      project([
        { name: "payments", authorizerType: "AWS_IAM", connectors: [quickCreate("quick")] },
      ]),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Authorize payment connector "payments/quick"');
    expect(messages[0]).toContain("https://example.com/authorize?request_uri=urn:x");
    expect(messages[0]).toContain("expires 10 minutes");
  });

  test("tells the user how to get a new link once the window has closed", async () => {
    const { messages } = await report(
      fakeAccount({
        "payments-abc": {
          name: "payments",
          connectors: [{ name: "quick", id: "quick-xyz", status: "AUTHENTICATION_EXPIRED" }],
        },
      }),
      project([
        { name: "payments", authorizerType: "AWS_IAM", connectors: [quickCreate("quick")] },
      ]),
    );

    expect(messages).toEqual([
      'Payment connector "payments/quick" is AUTHENTICATION_EXPIRED. Remove and deploy it, ' +
        "then add and deploy it again to generate a new authorization URL.",
    ]);
  });

  test("reports a connector that is already authorized", async () => {
    const { messages } = await report(
      fakeAccount({
        "payments-abc": {
          name: "payments",
          connectors: [{ name: "quick", id: "quick-xyz", status: "READY" }],
        },
      }),
      project([
        { name: "payments", authorizerType: "AWS_IAM", connectors: [quickCreate("quick")] },
      ]),
    );

    expect(messages).toEqual(['Payment connector "payments/quick" is ready.']);
  });

  test("says so when the service reports pending without a link", async () => {
    const { messages } = await report(
      fakeAccount({
        "payments-abc": {
          name: "payments",
          connectors: [{ name: "quick", id: "quick-xyz", status: "PENDING_AUTHENTICATION" }],
        },
      }),
      project([
        { name: "payments", authorizerType: "AWS_IAM", connectors: [quickCreate("quick")] },
      ]),
    );

    expect(messages).toEqual([
      'Payment connector "payments/quick" is pending authorization, but no authorization URL was returned.',
    ]);
  });

  test("makes no calls for a project without Quick Create connectors", async () => {
    let called = false;
    const calls = fakeAccount(
      {},
      {
        listStackManagerIds: async () => {
          called = true;
          return [];
        },
      },
    );

    const { messages } = await report(
      calls,
      project(
        [
          {
            name: "payments",
            authorizerType: "AWS_IAM",
            connectors: [{ name: "manual", provider: "CoinbaseCDP", credentialName: "coinbase" }],
          },
        ],
        [
          {
            authorizerType: "PaymentCredentialProvider",
            name: "coinbase",
            provider: "CoinbaseCDP",
          },
        ],
      ),
    );

    expect(called).toBe(false);
    expect(messages).toEqual([]);
  });

  test("ignores connectors on the manager that this project did not declare", async () => {
    const { messages } = await report(
      fakeAccount({
        "payments-abc": {
          name: "payments",
          connectors: [
            { name: "quick", id: "quick-xyz", status: "READY" },
            { name: "someone-elses", id: "other-xyz", status: "PENDING_AUTHENTICATION" },
          ],
        },
      }),
      project([
        { name: "payments", authorizerType: "AWS_IAM", connectors: [quickCreate("quick")] },
      ]),
    );

    expect(messages).toEqual(['Payment connector "payments/quick" is ready.']);
  });

  test("keeps same-named connectors on different managers apart", async () => {
    const { messages } = await report(
      fakeAccount({
        "a-1": {
          name: "alpha",
          connectors: [{ name: "quick", id: "q-a", status: "READY" }],
        },
        "b-2": {
          name: "beta",
          connectors: [{ name: "quick", id: "q-b", status: "AUTHENTICATION_EXPIRED" }],
        },
      }),
      project([
        { name: "alpha", authorizerType: "AWS_IAM", connectors: [quickCreate("quick")] },
        { name: "beta", authorizerType: "AWS_IAM", connectors: [quickCreate("quick")] },
      ]),
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe('Payment connector "alpha/quick" is ready.');
    expect(messages[1]).toContain('"beta/quick" is AUTHENTICATION_EXPIRED');
  });

  test("reports an unreadable status without failing the deploy that already succeeded", async () => {
    const { messages } = await report(
      fakeAccount(
        {},
        {
          listStackManagerIds: async () => {
            throw new Error("AccessDenied");
          },
        },
      ),
      project([
        { name: "payments", authorizerType: "AWS_IAM", connectors: [quickCreate("quick")] },
      ]),
    );

    expect(messages).toEqual([
      "Deployed, but the live status of payment connectors could not be retrieved: AccessDenied",
    ]);
  });

  test("keeps reporting other managers when one cannot be read", async () => {
    const { messages } = await report(
      fakeAccount(
        {
          "a-1": { name: "alpha", connectors: [{ name: "quick", id: "q-a", status: "READY" }] },
          "b-2": { name: "beta", connectors: [{ name: "quick", id: "q-b", status: "READY" }] },
        },
        {
          getManagerName: async ({ managerId }) => {
            if (managerId === "a-1") throw new Error("Throttled");
            return "beta";
          },
        },
      ),
      project([
        { name: "alpha", authorizerType: "AWS_IAM", connectors: [quickCreate("quick")] },
        { name: "beta", authorizerType: "AWS_IAM", connectors: [quickCreate("quick")] },
      ]),
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("could not be retrieved: Throttled");
    expect(messages[1]).toBe('Payment connector "beta/quick" is ready.');
  });
});
