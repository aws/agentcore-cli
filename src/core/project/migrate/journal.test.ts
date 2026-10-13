import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectStateError } from "../../../errors";
import {
  assertNoPendingMigration,
  readMigrationState,
  removeMigrationState,
  STATE_RELATIVE_PATH,
  writeMigrationState,
  type MigrationState,
} from "./journal";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "migrate-journal-"));
  roots.push(root);
  return root;
}

const STATE: MigrationState = {
  version: 2,
  startedAt: "2026-10-13T00:00:00.000Z",
  files: { status: "installed", backup: "agentcore/.cli/migrate-backup", changes: [] },
  refactored: ["dev"],
  targets: [
    {
      name: "prod",
      account: "444455556666",
      region: "eu-west-1",
      stackName: "AgentCore-P-prod",
      status: "pending",
    },
  ],
};

describe("the migration record", () => {
  test("round-trips, written atomically with no temporary file left", async () => {
    const root = tempRoot();
    await writeMigrationState(root, STATE);

    expect(await readMigrationState(root)).toEqual(STATE);
    expect(readdirSync(dirname(join(root, STATE_RELATIVE_PATH)))).toEqual(["migration-state.json"]);
    await removeMigrationState(root);
    expect(await readMigrationState(root)).toBeUndefined();
  });
});

describe("assertNoPendingMigration", () => {
  test("allows any target when there's no pending migration", async () => {
    await assertNoPendingMigration(tempRoot(), "prod");
  });

  test("blocks a pending target, naming its account and region, and allows the rest", async () => {
    const root = tempRoot();
    await writeMigrationState(root, STATE);

    const error = await assertNoPendingMigration(root, "prod").catch((caught) => caught);
    expect(error).toBeInstanceOf(ProjectStateError);
    expect(error.message).toContain("Target 'prod' (AWS account 444455556666, eu-west-1)");
    expect(error.message).toContain("agentcore migrate --target prod");
    await assertNoPendingMigration(root, "dev");
  });

  test("blocks a target whose refactor's outcome isn't known yet", async () => {
    const root = tempRoot();
    await writeMigrationState(root, {
      ...STATE,
      targets: [{ ...STATE.targets[0]!, status: "refactoring", refactorId: "rf-1" }],
    });
    await expect(assertNoPendingMigration(root, "prod")).rejects.toThrow("hasn't been migrated");
  });

  test("blocks every target while the project files are half-written", async () => {
    const root = tempRoot();
    await writeMigrationState(root, {
      ...STATE,
      files: { ...STATE.files!, status: "writing" },
      targets: [],
    });
    await expect(assertNoPendingMigration(root, "anything")).rejects.toThrow(
      "stopped while writing the project files",
    );
  });

  test("blocks when the record can't be read", async () => {
    const root = tempRoot();
    await writeMigrationState(root, STATE);
    writeFileSync(join(root, STATE_RELATIVE_PATH), "{ not json");
    await expect(assertNoPendingMigration(root, "dev")).rejects.toThrow("Couldn't read");
    expect(readFileSync(join(root, STATE_RELATIVE_PATH), "utf8")).toBe("{ not json");
  });
});
