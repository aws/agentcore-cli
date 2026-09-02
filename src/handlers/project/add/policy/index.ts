import z from "zod";
import { InputValidationError } from "../../../../errors";
import { SourceResolver } from "../../../../io";
import type {
  AuthorizationPhase,
  EnforcementMode,
  PolicySchema,
  ValidationMode,
} from "../../../../projectSchemas/policy";
import { createHandler, flag, ProjectKey } from "../../../../router";
import type { AddResourceInput } from "../../types";
import type { AddProjectResourceConfig } from "../types";

/**
 A substring heuristic, not a Cedar parser; --authorization-phase overrides it.
**/
export function inferAuthorizationPhase(statement: string): AuthorizationPhase {
  return /\bsuppressOutput\b|context\.output/.test(statement) ? "RETURN_OUTPUT" : "INITIATE";
}

const PHASES = { initiate: "INITIATE", "return-output": "RETURN_OUTPUT" } as const;
const VALIDATION_MODES = {
  "fail-on-any-findings": "FAIL_ON_ANY_FINDINGS",
  "ignore-all-findings": "IGNORE_ALL_FINDINGS",
} as const;
const ENFORCEMENT_MODES = { active: "ACTIVE", "log-only": "LOG_ONLY" } as const;

/**
 * PolicyInput is what every entry point — the flag handler, the wizard —
 * resolves its own inputs to before a Policy is built. `statement` is the Cedar
 * text itself, already read from wherever the user kept it. Anything optional
 * is a field toAddPolicyInput defaults, or leaves to the project schema.
 */
export interface PolicyInput {
  engineName: string;
  name: string;
  statement: string;
  /** Where `statement` was read from, when it was a file; recorded on the Policy. */
  sourceFile?: string;
  description?: string;
  validationMode?: ValidationMode;
  enforcementMode?: EnforcementMode;
  /** Inferred from the statement when absent. */
  authorizationPhase?: AuthorizationPhase;
}

/**
 * toAddPolicyInput is the one place a Policy is assembled from user input,
 * including the phase inference. Both the flag handler and the wizard call it.
 */
export function toAddPolicyInput(input: PolicyInput): AddResourceInput {
  const policy: z.input<typeof PolicySchema> = {
    name: input.name,
    description: input.description,
    statement: input.statement,
    sourceFile: input.sourceFile,
    validationMode: input.validationMode,
    enforcementMode: input.enforcementMode,
    authorizationPhase: input.authorizationPhase ?? inferAuthorizationPhase(input.statement),
  };
  return { resourceType: "policy", engineName: input.engineName, resourceConfig: policy };
}

export const createAddPolicyHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "policy",
    description: "adds a Cedar Policy to a project Policy Engine",
    flags: [
      flag("engine", "name of the parent Policy Engine in this project", z.string().optional()),
      flag("name", "the Policy name", z.string().optional()),
      flag("description", "Policy description", z.string().optional()),
      flag(
        "statement",
        "Cedar policy statement (inline, file://<path>, or - for stdin)",
        z.string().optional(),
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
    // handle only turns flags into a PolicyInput — reading the statement from
    // its source, mapping the kebab-case flag values. What a Policy is belongs
    // to toAddPolicyInput.
    handle: async (ctx, flags) => {
      if (!flags.engine) {
        throw new InputValidationError("required option '--engine <engine>' not specified");
      }
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      if (!flags.statement) {
        throw new InputValidationError("required option '--statement <statement>' not specified");
      }
      const project = ctx.require(ProjectKey);

      const source = new SourceResolver({ stdin: config.io.stdin });
      const statement = (await source.resolveText("statement", flags.statement))!;
      const sourceFile = flags.statement.startsWith("file://")
        ? flags.statement.slice("file://".length)
        : undefined;

      const input = toAddPolicyInput({
        engineName: flags.engine,
        name: flags.name,
        statement,
        sourceFile,
        description: flags.description,
        validationMode: flags["validation-mode"] && VALIDATION_MODES[flags["validation-mode"]],
        enforcementMode: flags["enforcement-mode"] && ENFORCEMENT_MODES[flags["enforcement-mode"]],
        authorizationPhase: flags["authorization-phase"] && PHASES[flags["authorization-phase"]],
      });

      for await (const event of config.projectManager.addResource(project, input)) {
        config.io.stderr.write(`${event.message}\n`);
      }
      config.io.stderr.write(
        `added Policy '${flags.name}' to Policy Engine '${flags.engine}' in '${project.name}'\n`,
      );
    },
  });
