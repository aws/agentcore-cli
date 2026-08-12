import type { Action, Condition } from "@aws-sdk/client-bedrock-agentcore-control";
import z from "zod";
import { InputValidationError } from "../../../../errors";
import { type AppIO, SourceResolver } from "../../../../io";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { assertMutuallyExclusiveInputs, coreOptsFromCtx, parseJsonArrayFlag } from "../../../utils";
import type { GatewayRuleUpdateInput } from "../../types";

export const createUpdateGatewayRuleHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "update",
    description: "update a Gateway Rule",
    flags: [
      flag("gateway-id", "the parent Gateway ID", z.string().optional()),
      flag("rule-id", "the Rule ID", z.string().optional()),
      flag(
        "priority",
        "updated priority from 1 to 1000000",
        z.number().int().min(1).max(1_000_000).optional(),
      ),
      flag(
        "conditions",
        "replacement conditions (JSON array; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag("clear-conditions", "make the Rule unconditional", z.boolean()),
      flag(
        "actions",
        "replacement actions (JSON array; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag("description", "updated Rule description", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["gateway-id"]) {
        throw new InputValidationError("required option '--gateway-id <gateway-id>' not specified");
      }
      if (!flags["rule-id"]) {
        throw new InputValidationError("required option '--rule-id <rule-id>' not specified");
      }
      assertMutuallyExclusiveInputs([
        [
          "conditions",
          flags.conditions,
          "clear-conditions",
          flags["clear-conditions"] || undefined,
        ],
      ]);
      if (flags.description === "") {
        throw new InputValidationError("Rule description cannot be empty or cleared");
      }
      const source = new SourceResolver({ stdin: io.stdin });
      const conditions = parseJsonArrayFlag<Condition>(
        "conditions",
        await source.resolveText("conditions", flags.conditions),
      );
      const actions = parseJsonArrayFlag<Action>(
        "actions",
        await source.resolveText("actions", flags.actions),
      );
      const mutations: Omit<GatewayRuleUpdateInput, "gatewayIdentifier" | "ruleId"> = {
        priority: flags.priority,
        conditions: flags["clear-conditions"] ? [] : conditions,
        actions,
        description: flags.description,
      };
      if (Object.values(mutations).every((value) => value === undefined)) {
        throw new InputValidationError("Rule update requires at least one mutation option");
      }
      const input: GatewayRuleUpdateInput = {
        gatewayIdentifier: flags["gateway-id"],
        ruleId: flags["rule-id"],
        ...mutations,
      };

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.gateway.updateGatewayRule(input, coreOptsFromCtx(ctx)));
    },
  });
