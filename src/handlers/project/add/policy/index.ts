import z from "zod";
import { SourceResolver } from "../../../../io";
import type { PolicySchema } from "../../../../projectSchemas/policy";
import { createHandler, flag, ProjectKey } from "../../../../router";
import type { AddProjectResourceConfig } from "../types";
import { addProjectResource } from "../shared";

/**
 A substring heuristic, not a Cedar parser; --authorization-phase overrides it.
**/
export function inferAuthorizationPhase(statement: string): "INITIATE" | "RETURN_OUTPUT" {
  return /\bsuppressOutput\b|context\.output/.test(statement) ? "RETURN_OUTPUT" : "INITIATE";
}

const PHASES = { initiate: "INITIATE", "return-output": "RETURN_OUTPUT" } as const;
const VALIDATION_MODES = {
  "fail-on-any-findings": "FAIL_ON_ANY_FINDINGS",
  "ignore-all-findings": "IGNORE_ALL_FINDINGS",
} as const;
const ENFORCEMENT_MODES = { active: "ACTIVE", "log-only": "LOG_ONLY" } as const;

export const createAddPolicyHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "policy",
    description: "add a Cedar Policy to a project Policy Engine",
    flags: [
      flag("engine", "name of the parent Policy Engine in this project", z.string().min(1)),
      flag("name", "the Policy name", z.string().min(1)),
      flag("description", "Policy description", z.string().optional()),
      flag(
        "statement",
        "Cedar policy statement (inline, file://<path>, or - for stdin)",
        z.string().min(1),
      ),
      flag(
        "validation-mode",
        "validation mode: fail-on-any-findings or ignore-all-findings",
        z.enum(["fail-on-any-findings", "ignore-all-findings"]).optional(),
      ),
      flag(
        "enforcement-mode",
        "enforcement mode: active or log-only",
        z.enum(["active", "log-only"]).optional(),
      ),
      flag(
        "authorization-phase",
        "authorization phase: initiate or return-output (default inferred from the statement)",
        z.enum(["initiate", "return-output"]).optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      const project = ctx.require(ProjectKey);

      const source = new SourceResolver({ stdin: config.io.stdin });
      const statement = (await source.resolveText("statement", flags.statement))!;
      const sourceFile = flags.statement.startsWith("file://")
        ? flags.statement.slice("file://".length)
        : undefined;

      const authorizationPhase = flags["authorization-phase"]
        ? PHASES[flags["authorization-phase"]]
        : inferAuthorizationPhase(statement);

      const policy: z.input<typeof PolicySchema> = {
        name: flags.name,
        description: flags.description,
        statement,
        sourceFile,
        validationMode: flags["validation-mode"] && VALIDATION_MODES[flags["validation-mode"]],
        enforcementMode: flags["enforcement-mode"] && ENFORCEMENT_MODES[flags["enforcement-mode"]],
        authorizationPhase,
      };

      await addProjectResource(
        ctx,
        config,
        project,
        {
          resourceType: "policy",
          engineName: flags.engine,
          resourceConfig: policy,
        },
        `added Policy '${flags.name}' to Policy Engine '${flags.engine}' in '${project.name}'`,
      );
    },
  });
