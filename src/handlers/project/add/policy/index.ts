import z from "zod";
import { SourceResolver } from "../../../../io";
import type { PolicySchema } from "../../../../projectSchemas/policy";
import { createHandler, flag, ProjectKey } from "../../../../router";
import type { AddResourceInput } from "../../types";
import type { AddProjectResourceConfig } from "../types";
import { addProjectResource, addDescription } from "../shared";

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

export type PolicyEnforcementMode = keyof typeof ENFORCEMENT_MODES;

// PolicyInput is the policy as the flags state it, with the statement already
// resolved to text and, when it came from a file, the path it came from.
export type PolicyInput = {
  engine: string;
  name: string;
  statement: string;
  sourceFile?: string;
  description?: string;
  validationMode?: keyof typeof VALIDATION_MODES;
  enforcementMode?: PolicyEnforcementMode;
  authorizationPhase?: keyof typeof PHASES;
};

// toAddPolicyInput is the one place a Policy is built from user input — the
// flags, or the wizard's answers — so both infer the authorization phase from
// the statement the same way and map modes to the same values.
export function toAddPolicyInput(input: PolicyInput): AddResourceInput {
  const policy: z.input<typeof PolicySchema> = {
    name: input.name,
    description: input.description,
    statement: input.statement,
    sourceFile: input.sourceFile,
    validationMode: input.validationMode && VALIDATION_MODES[input.validationMode],
    enforcementMode: input.enforcementMode && ENFORCEMENT_MODES[input.enforcementMode],
    authorizationPhase: input.authorizationPhase
      ? PHASES[input.authorizationPhase]
      : inferAuthorizationPhase(input.statement),
  };
  return { resourceType: "policy", engineName: input.engine, resourceConfig: policy };
}

export const createAddPolicyHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "policy",
    description: addDescription("policy", "add a Cedar Policy to a project Policy Engine"),
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

      await addProjectResource(
        ctx,
        config,
        project,
        toAddPolicyInput({
          engine: flags.engine,
          name: flags.name,
          statement,
          sourceFile,
          description: flags.description,
          validationMode: flags["validation-mode"],
          enforcementMode: flags["enforcement-mode"],
          authorizationPhase: flags["authorization-phase"],
        }),
        `added Policy '${flags.name}' to Policy Engine '${flags.engine}' in '${project.name}'`,
      );
    },
  });
