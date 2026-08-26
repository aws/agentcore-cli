import z from "zod";
import { InputValidationError } from "../../../../errors";
import { SourceResolver } from "../../../../io";
import type { PolicySchema } from "../../../../projectSchemas/policy";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { coreOptsFromCtx } from "../../../utils";
import type { AddProjectResourceConfig } from "../types";
import type { GeneratedPolicy } from "./types";

/**
 A substring heuristic, not a Cedar parser; --authorization-phase overrides it.
**/
export function inferAuthorizationPhase(statement: string): "INITIATE" | "RETURN_OUTPUT" {
  return /\bsuppressOutput\b|context\.output/.test(statement) ? "RETURN_OUTPUT" : "INITIATE";
}

const PHASES = { initiate: "INITIATE", "return-output": "RETURN_OUTPUT" } as const;

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
        "generate",
        "generate the Cedar statement from a natural-language description",
        z.string().optional(),
      ),
      flag("gateway", "deployed Gateway name that scopes --generate", z.string().optional()),
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
      if (!flags.engine) {
        throw new InputValidationError("required option '--engine <engine>' not specified");
      }
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      const sources = [flags.statement, flags.generate].filter((value) => value !== undefined);
      if (sources.length !== 1) {
        throw new InputValidationError("specify exactly one of '--statement' or '--generate'");
      }
      if (flags.gateway !== undefined && flags.generate === undefined) {
        throw new InputValidationError("--gateway is valid only with --generate");
      }
      const project = ctx.require(ProjectKey);
      if (!project.spec.policyEngines.some((engine) => engine.name === flags.engine)) {
        throw new InputValidationError(
          `policy engine '${flags.engine}' does not exist in policyEngines[]`,
        );
      }

      let statement: string;
      let sourceFile: string | undefined;
      if (flags.statement !== undefined) {
        const source = new SourceResolver({ stdin: config.io.stdin });
        statement = await source.resolveText("statement", flags.statement);
        if (flags.statement.startsWith("file://")) {
          sourceFile = flags.statement.slice("file://".length);
        }
      } else {
        const generator = config.policy.generatePolicy(
          {
            projectName: project.name,
            engineName: flags.engine,
            gatewayName: flags.gateway,
            description: flags.generate!,
          },
          coreOptsFromCtx(ctx),
        );
        let generated: GeneratedPolicy;
        while (true) {
          const next = await generator.next();
          if (next.done) {
            generated = next.value;
            break;
          }
          config.io.stderr.write(`${next.value.message}\n`);
        }
        statement = generated.statement;
        config.io.stderr.write(`Generated Cedar policy:\n${statement}\n`);
        for (const finding of generated.findings) {
          config.io.stderr.write(`finding [${finding.type}]: ${finding.description}\n`);
        }
      }

      const authorizationPhase = flags["authorization-phase"]
        ? PHASES[flags["authorization-phase"]]
        : inferAuthorizationPhase(statement);

      const policy: z.input<typeof PolicySchema> = {
        name: flags.name,
        description: flags.description,
        statement,
        sourceFile,
        validationMode:
          flags["validation-mode"] === "ignore-all-findings"
            ? "IGNORE_ALL_FINDINGS"
            : "FAIL_ON_ANY_FINDINGS",
        enforcementMode: flags["enforcement-mode"] === "log-only" ? "LOG_ONLY" : "ACTIVE",
        authorizationPhase,
      };

      for await (const event of config.projectManager.addResource(project, {
        resourceType: "policy",
        engineName: flags.engine,
        resourceConfig: policy,
      })) {
        config.io.stderr.write(`${event.message}\n`);
      }
      config.io.stderr.write(
        `added Policy '${flags.name}' to Policy Engine '${flags.engine}' in '${project.name}'\n`,
      );
    },
  });
