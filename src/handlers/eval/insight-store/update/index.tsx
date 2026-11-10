import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { assertMutuallyExclusiveFlags, coreOptsFromCtx } from "../../../utils";
import type { AgentInsightStoreUpdate } from "../../types";

const ENABLEMENT_STATUSES = ["ENABLED", "DISABLED"] as const;
const ENCRYPTION_MODES = ["AWS_OWNED_KMS_KEY", "CUSTOMER_MANAGED_KMS"] as const;

type UpdateFlags = {
  "enablement-status"?: (typeof ENABLEMENT_STATUSES)[number];
  "encryption-mode"?: (typeof ENCRYPTION_MODES)[number];
  "kms-key-arn"?: string;
};

export function resolveStoreUpdate(flags: UpdateFlags): AgentInsightStoreUpdate {
  assertMutuallyExclusiveFlags(flags, ["enablement-status", "encryption-mode"], {
    exactlyOne: true,
  });
  const mode = flags["encryption-mode"];
  const kmsKeyArn = flags["kms-key-arn"];
  if (mode === undefined) {
    if (kmsKeyArn !== undefined) {
      throw new InputValidationError(
        "'--kms-key-arn' requires '--encryption-mode CUSTOMER_MANAGED_KMS'",
      );
    }
    return { enablementStatus: flags["enablement-status"]! };
  }
  if (mode === "CUSTOMER_MANAGED_KMS" && kmsKeyArn === undefined) {
    throw new InputValidationError(
      "'--encryption-mode CUSTOMER_MANAGED_KMS' requires '--kms-key-arn'",
    );
  }
  if (mode === "AWS_OWNED_KMS_KEY" && kmsKeyArn !== undefined) {
    throw new InputValidationError(
      "'--kms-key-arn' cannot be used with '--encryption-mode AWS_OWNED_KMS_KEY'",
    );
  }
  return { encryptionConfiguration: { mode, kmsKeyArn } };
}

export const createUpdateInsightStoreHandler = (core: Core) =>
  createHandler({
    name: "update",
    description: "enable or disable an Agent Insight Store, or change its encryption key",
    flags: [
      flag("id", "the ID of the Agent Insight Store", z.string().min(1)),
      flag(
        "enablement-status",
        `turn Insight generation on or off (${ENABLEMENT_STATUSES.join(" | ")}); DISABLED deletes the Store's Insights`,
        z.enum(ENABLEMENT_STATUSES).optional(),
      ),
      flag(
        "encryption-mode",
        `the key that encrypts Insights (${ENCRYPTION_MODES.join(" | ")})`,
        z.enum(ENCRYPTION_MODES).optional(),
      ),
      flag(
        "kms-key-arn",
        "the customer managed KMS key ARN (only with --encryption-mode CUSTOMER_MANAGED_KMS)",
        z.string().min(1).optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      const update = resolveStoreUpdate(flags);
      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.eval.updateAgentInsightStore(flags["id"], update, coreOptsFromCtx(ctx)),
        );
    },
  });
