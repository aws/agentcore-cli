import type { Action, Condition } from "@aws-sdk/client-bedrock-agentcore-control";
import z from "zod";
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
      flag("gateway-id", "the parent Gateway ID", z.string().min(1)),
      flag("priority", "Rule priority from 1 to 1000000", z.number().int().min(1).max(1_000_000)),
      flag(
        "conditions",
        "Rule conditions (JSON Condition[]; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag(
        "actions",
        "Rule actions (JSON Action[]; inline, file://<path>, or - for stdin)",
        z.string(),
      ),
      flag("description", "Rule description", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
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
      };
      ctx
        .require(JsonRendererKey)
        .renderJson(await core.gateway.createGatewayRule(input, coreOptsFromCtx(ctx)));
    },
  });
