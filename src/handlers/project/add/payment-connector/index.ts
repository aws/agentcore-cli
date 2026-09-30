import z from "zod";
import { InputValidationError, ResourceNotFoundError } from "../../../../errors";
import { createHandler, flag, ProjectKey } from "../../../../router";
import type { AddResourceInput, Project } from "../../types";
import type { AddProjectResourceConfig } from "../types";
import { addProjectResource } from "../shared";
import { assertMutuallyExclusiveFlags } from "../../../utils";

export type PaymentConnectorInput =
  | {
      managerName: string;
      name: string;
      quickCreate: true;
    }
  | {
      managerName: string;
      name: string;
      quickCreate?: false;
      credentialName: string;
    };

export function toAddPaymentConnectorInput(
  project: Project,
  input: PaymentConnectorInput,
): AddResourceInput {
  if (input.quickCreate) {
    return {
      resourceType: "payment-connector",
      managerName: input.managerName,
      resourceConfig: {
        name: input.name,
        provider: "CoinbaseCDP",
        provisionMode: "QUICK_CREATE",
      },
    };
  }

  const credential = project.spec.credentials.find(
    (candidate) => candidate.name === input.credentialName,
  );
  if (!credential) {
    throw new ResourceNotFoundError(
      `no credential named '${input.credentialName}' exists in this project`,
    );
  }
  if (credential.authorizerType !== "PaymentCredentialProvider") {
    throw new InputValidationError(
      `credential '${input.credentialName}' is a ${credential.authorizerType}, not a PaymentCredentialProvider`,
    );
  }

  return {
    resourceType: "payment-connector",
    managerName: input.managerName,
    resourceConfig: {
      name: input.name,
      provider: credential.provider,
      credentialName: input.credentialName,
    },
  };
}

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
      const input = toAddPaymentConnectorInput(
        project,
        flags["quick-create"]
          ? {
              managerName: flags.manager,
              name: flags.name,
              quickCreate: true,
            }
          : {
              managerName: flags.manager,
              name: flags.name,
              credentialName: flags.credential!,
            },
      );

      await addProjectResource(
        ctx,
        config,
        project,
        input,
        `added payment connector '${flags.name}' to manager '${flags.manager}' in '${project.name}'`,
      );
    },
  });
