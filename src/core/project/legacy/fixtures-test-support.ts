import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { V0AgentCoreProjectSpecSchema, type V0ProjectSpec } from "../../../projectSchemas/v0";

/**
 * v0 `agentcore.json` files from the v0→v1 schema audit, one per edge case v0 0.31.1
 * accepted. `invalid_*` files are ones v0 itself rejects; `aws-targets_*` files are
 * deployment target lists rather than project specs.
 */
export const FIXTURES_DIR = join(import.meta.dir, "__fixtures__");

/** The raw JSON of a fixture. */
export function rawFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8")) as Record<string, unknown>;
}

/** A fixture parsed with the vendored v0 schema. */
export function v0Fixture(name: string): V0ProjectSpec {
  return V0AgentCoreProjectSpecSchema.parse(rawFixture(name));
}

/** Every project-spec fixture v0 0.31.1 accepts. */
export function validV0FixtureNames(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter(
      (f) => f.endsWith(".json") && !f.startsWith("aws-targets_") && !f.startsWith("invalid_"),
    )
    .sort();
}
