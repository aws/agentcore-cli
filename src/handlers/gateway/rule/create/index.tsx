import type { Action, Condition } from "@aws-sdk/client-bedrock-agentcore-control";
import z from "zod";
import { InputValidationError } from "../../../../errors";
import { type AppIO, SourceResolver } from "../../../../io";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx, parseJsonArrayFlag } from "../../../utils";
import type { CreateGatewayRuleInput } from "../../types";

export const createCreateGatewayRuleHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "create",
    description: "create a Gateway Rule",
    flags: [
      flag("gateway-id", "the parent Gateway ID", z.string().optional()),
      flag(
        "priority",
        "Rule priority from 1 to 1000000",
        z.number().int().min(1).max(1_000_000).optional(),
      ),
      flag("conditions", "Rule conditions (JSON Condition[])", z.string().optional()),
      flag("actions", "Rule actions (JSON Action[])", z.string().optional()),
      flag("description", "Rule description", z.string().optional()),
      flag("client-token", "idempotency token", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["gateway-id"]) {
        throw new InputValidationError("required option '--gateway-id <gateway-id>' not specified");
      }
      if (flags.priority === undefined) {
        throw new InputValidationError("required option '--priority <priority>' not specified");
      }
      if (flags.actions === undefined) {
        throw new InputValidationError("required option '--actions <actions>' not specified");
      }

      const source = new SourceResolver({ stdin: io.stdin });
      const conditions = parseJsonArrayFlag<Condition>(
        "conditions",
        await source.resolveText("conditions", flags.conditions),
      );
      const actions = parseJsonArrayFlag<Action>(
        "actions",
        await source.resolveText("actions", flags.actions),
      )!;
      const input: CreateGatewayRuleInput = {
        gatewayIdentifier: flags["gateway-id"],
        priority: flags.priority,
        actions,
        ...(conditions !== undefined ? { conditions } : {}),
        ...(flags.description ? { description: flags.description } : {}),
        ...(flags["client-token"] ? { clientToken: flags["client-token"] } : {}),
      };
      ctx
        .require(JsonRendererKey)
        .renderJson(await core.gateway.createGatewayRule(input, coreOptsFromCtx(ctx)));
    },
  });
