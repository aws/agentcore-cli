import z from "zod";
import { InputValidationError, ResourceNotFoundError } from "../../../../errors";
import { createHandler, flag, ProjectKey } from "../../../../router";
import type { AddProjectResourceConfig } from "../types";
import { addProjectResource } from "../shared";
import { assertMutuallyExclusiveFlags } from "../../../utils";

export const createAddPaymentConnectorHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "payment-connector",
    description: "add a connector to a project payment manager",
    flags: [
      flag("manager", "the parent payment manager", z.string().min(1)),
      flag("name", "the payment connector name", z.string().min(1)),
      flag("credential", "an existing payment credential to reuse", z.string().optional()),
      flag("quick-create", "create a CoinbaseCDP connector through Quick Create", z.boolean()),
    ],
    handle: async (ctx, flags) => {
      assertMutuallyExclusiveFlags(flags, ["credential", "quick-create"], { exactlyOne: true });

      const project = ctx.require(ProjectKey);
      let provider: "CoinbaseCDP" | "StripePrivy";
      let credentialName: string | undefined;

      if (flags["quick-create"]) {
        provider = "CoinbaseCDP";
      } else {
        credentialName = flags.credential!;
        const credential = project.spec.credentials.find(
          (candidate) => candidate.name === credentialName,
        );
        if (!credential) {
          throw new ResourceNotFoundError(
            `no credential named '${credentialName}' exists in this project`,
          );
        }
        if (credential.authorizerType !== "PaymentCredentialProvider") {
          throw new InputValidationError(
            `credential '${credentialName}' is a ${credential.authorizerType}, not a PaymentCredentialProvider`,
          );
        }
        provider = credential.provider;
      }

      await addProjectResource(
        ctx,
        config,
        project,
        {
          resourceType: "payment-connector",
          managerName: flags.manager,
          resourceConfig: flags["quick-create"]
            ? {
                name: flags.name,
                provider: "CoinbaseCDP",
                provisionMode: "QUICK_CREATE",
              }
            : {
                name: flags.name,
                provider,
                credentialName: credentialName!,
              },
        },
        `added payment connector '${flags.name}' to manager '${flags.manager}' in '${project.name}'`,
      );
    },
  });
