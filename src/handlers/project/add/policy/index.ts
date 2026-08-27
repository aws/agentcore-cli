import z from "zod";
import { InputValidationError } from "../../../../errors";
import { SourceResolver } from "../../../../io";
import { gatewayResourceName } from "../../../../projectSchemas/gateway";
import type { PolicySchema } from "../../../../projectSchemas/policy";
import { policyEngineResourceName } from "../policy-engine";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { coreOptsFromCtx } from "../../../utils";
import type { AddProjectResourceConfig } from "../types";

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

      let statement: string;
      let sourceFile: string | undefined;
      if (flags.statement !== undefined) {
        const source = new SourceResolver({ stdin: config.io.stdin });
        statement = (await source.resolveText("statement", flags.statement))!;
        if (flags.statement.startsWith("file://")) {
          sourceFile = flags.statement.slice("file://".length);
        }
      } else {
        // Fail before the minute-long generation call; the manager re-checks on write.
        if (!project.spec.policyEngines.some((engine) => engine.name === flags.engine)) {
          throw new InputValidationError(
            `policy engine '${flags.engine}' does not exist in policyEngines[]`,
          );
        }
        const owner = project.spec.policyEngines.find((engine) =>
          engine.policies.some((policy) => policy.name === flags.name),
        );
        if (owner) {
          throw new InputValidationError(
            `a policy with name '${flags.name}' already exists in policy engine '${owner.name}'`,
          );
        }
        const gateways = project.spec.agentCoreGateways;
        const gateway = flags.gateway
          ? gateways.find((candidate) => candidate.name === flags.gateway)
          : gateways.length === 1
            ? gateways[0]
            : undefined;
        if (flags.gateway && !gateway) {
          throw new InputValidationError(
            `gateway '${flags.gateway}' does not exist in agentCoreGateways[]`,
          );
        }
        if (!gateway) {
          throw new InputValidationError(
            gateways.length === 0
              ? "--generate needs a deployed gateway; add one to this project and deploy it first"
              : `this project declares multiple gateways: ${gateways
                  .map((candidate) => candidate.name)
                  .join(", ")}; pass --gateway to choose one`,
          );
        }

        const generator = config.policy.generatePolicy(
          {
            engineName: flags.engine,
            gatewayName: gateway.name,
            engineServiceName: policyEngineResourceName(project.name, flags.engine),
            gatewayServiceName: gatewayResourceName(project.name, gateway),
            description: flags.generate!,
          },
          coreOptsFromCtx(ctx),
        );
        let next = await generator.next();
        while (!next.done) {
          config.io.stderr.write(`${next.value.message}\n`);
          next = await generator.next();
        }
        const generated = next.value;
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
        validationMode: flags["validation-mode"] && VALIDATION_MODES[flags["validation-mode"]],
        enforcementMode: flags["enforcement-mode"] && ENFORCEMENT_MODES[flags["enforcement-mode"]],
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
