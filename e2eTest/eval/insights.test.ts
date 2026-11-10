import { describe, expect, test } from "vitest";
import { tmpdir } from "node:os";
import z from "zod";
import { TAGS } from "../constants";
import { CliRunner, parseResult } from "../helpers/run";
import { TIMEOUT_MS } from "../timeouts";

// Needs an account enrolled for Agent Insights. The Insight tests read Insights a
// Builtin.FailureAnalysis batch evaluation already produced, and are skipped
// without one. They run first because disabling the Store deletes its Insights.
const BATCH_EVALUATION_ID = process.env.E2E_INSIGHTS_BATCH_EVALUATION_ID;
const STORE_ID = process.env.E2E_INSIGHT_STORE_ID ?? "default-insight-store";

const cli = new CliRunner();
const cwd = tmpdir();

const InsightSummarySchema = z.object({
  agentInsightId: z.string(),
  applicationName: z.string(),
  archiveStatus: z.string(),
});
const InsightListSchema = z.object({ agentInsights: z.array(InsightSummarySchema) });
const InsightSchema = InsightSummarySchema.extend({
  rootCauses: z.array(z.object({ name: z.string() })).min(1),
});
const ArchiveSchema = z.object({ agentInsightId: z.string(), archiveStatus: z.string() });
const StoreSchema = z.object({ status: z.string(), enablementStatus: z.string() });
const StoreListSchema = z.object({ agentInsightStores: z.array(StoreSchema).length(1) });

async function waitForStatus(status: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS.INSIGHT_STORE_SETTLE;
  while (Date.now() < deadline) {
    const store = parseResult(
      StoreSchema,
      await cli.run(["eval", "insight-store", "get", "--id", STORE_ID, "--json"], cwd),
    );
    if (store.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(`${STORE_ID} did not reach ${status}`);
}

describe("eval insight", { tags: [TAGS.EVAL] }, () => {
  test.skipIf(!BATCH_EVALUATION_ID)(
    "lists a batch evaluation's Insights, reads one, and archives then restores it",
    async () => {
      const list = parseResult(
        InsightListSchema,
        await cli.run(
          ["eval", "insight", "list", "--batch-evaluation-id", BATCH_EVALUATION_ID!, "--json"],
          cwd,
        ),
      );
      const first = list.agentInsights[0];
      expect(first).toBeDefined();
      const target = ["--application-name", first!.applicationName, "--id", first!.agentInsightId];

      parseResult(InsightSchema, await cli.run(["eval", "insight", "get", ...target], cwd));

      for (const status of ["ARCHIVED", "ACTIVE"]) {
        const updated = parseResult(
          ArchiveSchema,
          await cli.run(["eval", "insight", "update", ...target, "--archive-status", status], cwd),
        );
        expect(updated.archiveStatus).toBe(status);
      }
    },
    TIMEOUT_MS.PROJECT_INVOKE,
  );
});

describe("eval insight-store", { tags: [TAGS.EVAL] }, () => {
  test(
    "disables and re-enables the Store, rejecting an update while it is UPDATING",
    async () => {
      parseResult(StoreListSchema, await cli.run(["eval", "insight-store", "list"], cwd));

      const update = (status: string) =>
        cli.run(
          ["eval", "insight-store", "update", "--id", STORE_ID, "--enablement-status", status],
          cwd,
        );

      expect(parseResult(StoreSchema, await update("DISABLED")).enablementStatus).toBe("DISABLED");
      const conflict = await update("ENABLED");
      expect(conflict.exitCode).toBe(1);
      expect(conflict.stderr).toContain("cannot accept the requested update in its current state");

      await waitForStatus("INACTIVE");
      expect(parseResult(StoreSchema, await update("ENABLED")).enablementStatus).toBe("ENABLED");
      await waitForStatus("ACTIVE");
    },
    2 * TIMEOUT_MS.INSIGHT_STORE_SETTLE + TIMEOUT_MS.PROJECT_INVOKE,
  );
});
